import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FileDiff, FileSummary, Target, TargetKey, WorktreeInfo, CommentSide } from '@warden/shared';
import { parseTargetKey, TargetKeyError } from '@warden/shared';
import { EMPTY_TREE_SHA, mergeBase, refExists, revParse, runGit, type SnapshotEnv } from './git.js';
import { checkpointObjects, withCheckpointIndex } from './checkpoints.js';
import { parseUnifiedDiff } from './diffparse.js';
import { DEBUG_MARKER_STRINGS, debugLineNumbers, markDebugLines } from './debug.js';
import { badRequest, HttpError } from './errors.js';
import type { RepoContext } from './repo.js';

export interface TargetContext {
  key: TargetKey;
  target: Target;
  /** Working directory to run git in (worktree root or repo root). */
  cwd: string;
  /** Filled in for a checkpoint target by whoever looked it up in the state (see app.ts). */
  checkpoint?: { tree: string; store: string };
}

function checkpointOf(ctx: TargetContext): { tree: string; store: string } {
  if (!ctx.checkpoint) throw new Error(`checkpoint of ${ctx.key} was not looked up`);
  return ctx.checkpoint;
}

/** Git options that let a command read the checkpoint's objects; nothing for any other target. */
async function objectsFor(ctx: TargetContext): Promise<{ snapshot?: SnapshotEnv }> {
  return ctx.target.kind === 'checkpoint' ? { snapshot: await checkpointObjects(ctx.cwd, checkpointOf(ctx).store) } : {};
}

/**
 * Runs a diff of the target. A checkpoint's is `git diff <tree>` under an index that lists the
 * untracked files as well; everything else runs as it is.
 */
async function runDiff(ctx: TargetContext, args: string[]): Promise<string> {
  if (ctx.target.kind !== 'checkpoint') return (await runGit(args, { cwd: ctx.cwd })).stdout;
  return withCheckpointIndex(ctx.cwd, checkpointOf(ctx).store, async (snapshot) => (await runGit(args, { cwd: ctx.cwd, snapshot })).stdout);
}

/**
 * Every diff warden parses or turns into a patch. The user's git config reaches these commands, and
 * each flag here overrides one setting that would change the output: textconv would put a
 * converted text in the patch staging applies (a PDF's extracted text, say, in the index), the
 * mnemonic or no-prefix settings would break every path, and diff.submodule would hide a
 * submodule's change or list files from inside it.
 */
const DIFF_OUTPUT_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '-U3'];
const DIFF_BASE_ARGS = ['diff', ...DIFF_OUTPUT_ARGS, '-M', '--find-renames'];

export function resolveTargetContext(repo: RepoContext, worktrees: WorktreeInfo[], key: TargetKey): TargetContext {
  let target: Target;
  try {
    target = parseTargetKey(key);
  } catch (e) {
    if (e instanceof TargetKeyError) throw badRequest(e.message, 'invalid_target');
    throw e;
  }
  let cwd = repo.root;
  if (target.worktree) {
    const wt = worktrees.find((w) => w.path === target.worktree);
    if (!wt) throw badRequest(`unknown worktree: ${target.worktree}`, 'unknown_worktree');
    cwd = wt.path;
  }
  return { key, target, cwd };
}

/** Rejects anything that could reach outside the worktree; the rest is taken as one literal name. */
function assertRepoPath(p: string): void {
  if (!p || p.startsWith('/') || p.split('/').includes('..')) throw badRequest(`invalid path: ${p}`, 'invalid_path');
}

/** Pathspec for exactly this file: without the magic, a name starting with `:` is read as pathspec syntax. */
export const literal = (p: string): string => `:(literal)${p}`;

async function hasHead(cwd: string): Promise<boolean> {
  return refExists(cwd, 'HEAD');
}

/**
 * The commit a `base` target diffs against: where the branch forked off `ref`, so that commits
 * which landed on `ref` afterwards do not show up as reversed changes (which is what a plain
 * `git diff <ref>` would do). An unborn HEAD compares against the empty tree, like `all`.
 */
async function baseSha(ctx: TargetContext, ref: string): Promise<string> {
  if (!(await refExists(ctx.cwd, ref))) throw badRequest(`unknown ref: ${ref}`, 'unknown_ref');
  if (!(await hasHead(ctx.cwd))) return EMPTY_TREE_SHA;
  const sha = await mergeBase(ctx.cwd, ref, 'HEAD');
  if (!sha) throw badRequest(`${ref} and HEAD share no history`, 'no_merge_base');
  return sha;
}

/** Build the git diff arguments (without pathspec) for a target. */
async function diffArgs(ctx: TargetContext): Promise<string[]> {
  const t = ctx.target;
  switch (t.kind) {
    case 'working':
      return [...DIFF_BASE_ARGS];
    case 'staged':
      return [...DIFF_BASE_ARGS, '--cached'];
    case 'all':
      return [...DIFF_BASE_ARGS, (await hasHead(ctx.cwd)) ? 'HEAD' : EMPTY_TREE_SHA];
    case 'commit': {
      if (!(await refExists(ctx.cwd, t.sha))) throw badRequest(`unknown commit: ${t.sha}`, 'unknown_ref');
      const parent = await revParse(ctx.cwd, `${t.sha}^`);
      return [...DIFF_BASE_ARGS, parent ?? EMPTY_TREE_SHA, t.sha];
    }
    case 'range': {
      if (!(await refExists(ctx.cwd, t.base))) throw badRequest(`unknown ref: ${t.base}`, 'unknown_ref');
      if (!(await refExists(ctx.cwd, t.head))) throw badRequest(`unknown ref: ${t.head}`, 'unknown_ref');
      // `a...b` needs a merge base; git's "fatal: no merge base" is a request problem, like for `base`.
      if (!(await mergeBase(ctx.cwd, t.base, t.head))) throw badRequest(`${t.base} and ${t.head} share no history`, 'no_merge_base');
      return [...DIFF_BASE_ARGS, `${t.base}...${t.head}`];
    }
    case 'base':
      return [...DIFF_BASE_ARGS, await baseSha(ctx, t.ref)];
    case 'checkpoint':
      return [...DIFF_BASE_ARGS, checkpointOf(ctx).tree];
  }
}

function includesUntracked(t: Target): boolean {
  return t.kind === 'working' || t.kind === 'all' || t.kind === 'base';
}

async function listUntracked(cwd: string): Promise<string[]> {
  const r = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
  return r.stdout.split('\0').filter(Boolean);
}

async function isUntracked(cwd: string, file: string): Promise<boolean> {
  const r = await runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', literal(file)], { cwd });
  return r.stdout.split('\0').filter(Boolean).includes(file);
}

async function untrackedDiff(cwd: string, file: string): Promise<FileDiff | undefined> {
  // `git diff --no-index` exits 1 when there are differences (always, for a new file).
  const r = await runGit(['diff', ...DIFF_OUTPUT_ARGS, '--no-index', '--', '/dev/null', file], {
    cwd,
    okCodes: [0, 1],
  });
  const parsed = parseUnifiedDiff(r.stdout);
  const f = parsed[0];
  if (!f) return undefined;
  f.path = file;
  f.status = 'added';
  f.untracked = true;
  delete f.oldPath;
  return f;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Full diff for the target, parsed. */
export async function listTargetDiffs(ctx: TargetContext): Promise<FileDiff[]> {
  const args = await diffArgs(ctx);
  // `--` so that a file named like a revision (`HEAD`, a branch) is not read as one.
  const files = parseUnifiedDiff(await runDiff(ctx, [...args, '--']));
  if (includesUntracked(ctx.target)) {
    const untracked = await listUntracked(ctx.cwd);
    const extra = await mapLimit(untracked, 8, (f) => untrackedDiff(ctx.cwd, f).catch(() => undefined));
    for (const f of extra) if (f) files.push(f);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return files;
}

export function toSummary(f: FileDiff): FileSummary {
  const { hunks: _hunks, ...rest } = f;
  return rest;
}

export interface FileDiffHints {
  oldPath?: string;
  untracked?: boolean;
}

/** Diff of a single file inside the target. Returns undefined when the file has no changes. */
export async function getFileDiff(ctx: TargetContext, filePath: string, hints: FileDiffHints = {}): Promise<FileDiff | undefined> {
  assertRepoPath(filePath);
  if (hints.oldPath) assertRepoPath(hints.oldPath);
  if (includesUntracked(ctx.target) && (hints.untracked || (await isUntracked(ctx.cwd, filePath)))) {
    return untrackedDiff(ctx.cwd, filePath);
  }
  const args = await diffArgs(ctx);
  const pathspec = [literal(filePath)];
  if (hints.oldPath && hints.oldPath !== filePath) pathspec.push(literal(hints.oldPath));
  const files = parseUnifiedDiff(await runDiff(ctx, [...args, '--', ...pathspec]));
  return files.find((f) => f.path === filePath) ?? files[0];
}

/** Which ref holds the content of `side` for this target (undefined = working tree file). */
async function refForSide(ctx: TargetContext, side: CommentSide): Promise<string | undefined> {
  const t = ctx.target;
  switch (t.kind) {
    case 'working':
      return side === 'new' ? undefined : ':0';
    case 'staged':
      return side === 'new' ? ':0' : 'HEAD';
    case 'all':
      return side === 'new' ? undefined : 'HEAD';
    case 'commit':
      if (side === 'new') return t.sha;
      return (await revParse(ctx.cwd, `${t.sha}^`)) ?? EMPTY_TREE_SHA;
    case 'range':
      // The diff is `base...head`: its old side is where the two forked, not `base` itself.
      if (side === 'new') return t.head;
      return (await mergeBase(ctx.cwd, t.base, t.head)) ?? t.base;
    case 'base':
      return side === 'new' ? undefined : baseSha(ctx, t.ref);
    case 'checkpoint':
      return side === 'new' ? undefined : checkpointOf(ctx).tree;
  }
}

/** Full content of a file on one side of the target; null when it does not exist there. */
export async function getFullFile(ctx: TargetContext, filePath: string, side: CommentSide): Promise<string | null> {
  assertRepoPath(filePath);
  const ref = await refForSide(ctx, side);
  if (ref === undefined) {
    try {
      const buf = await readFile(path.join(ctx.cwd, filePath));
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }
  try {
    const r = await runGit(['show', `${ref}:${filePath}`], { cwd: ctx.cwd, ...(await objectsFor(ctx)) });
    return r.stdout;
  } catch (e) {
    if (e instanceof HttpError && e.code === 'git_failed') return null;
    throw e;
  }
}

/** Paths are handed to `git grep` this many at a time, well inside any command-line limit. */
const GREP_CHUNK = 500;

/** Which of `paths` hold a debug marker on `side` of the target: the only ones worth reading whole. */
async function pathsWithMarkers(ctx: TargetContext, side: CommentSide, paths: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (paths.length === 0) return found;
  const ref = await refForSide(ctx, side);
  // color.ui=always would wrap each name in escapes, submodule.recurse would make --untracked fatal:
  // either way no file would be found to hold a marker, and debug lines would be staged as code.
  const args = ['grep', '--no-color', '--no-recurse-submodules', '-l', '-z', '-I', '-i', '-F', ...DEBUG_MARKER_STRINGS.flatMap((m) => ['-e', m])];
  // The working tree includes the untracked files the listing shows; a tree prints `<ref>:<path>`.
  if (ref === undefined) args.push('--untracked');
  else if (ref === ':0') args.push('--cached');
  else args.push(ref);
  const prefix = ref === undefined || ref === ':0' ? '' : `${ref}:`;
  const objects = await objectsFor(ctx);
  for (let i = 0; i < paths.length; i += GREP_CHUNK) {
    const chunk = paths.slice(i, i + GREP_CHUNK).map(literal);
    // Exit 1 is "no match".
    const r = await runGit([...args, '--', ...chunk], { cwd: ctx.cwd, okCodes: [0, 1], ...objects });
    for (const p of r.stdout.split('\0')) if (p) found.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return found;
}

/**
 * Flags the debug lines of `files` in place (`DiffLine.debug`, `debugAdditions` / `debugDeletions`).
 * A hunk seldom shows the marker that opened the block its lines sit in, so the sides of a file are
 * read whole — only for the files `git grep` finds a marker in, which is usually none of them.
 */
export async function annotateDebug(ctx: TargetContext, files: FileDiff[]): Promise<void> {
  const text = files.filter((f) => !f.binary && f.hunks.length > 0);
  const oldPathOf = (f: FileDiff) => f.oldPath ?? f.path;
  // A side git cannot search marks nothing rather than failing the listing: there is no such side
  // to hold debug code when HEAD is unborn, which is where that happens.
  const none = () => new Set<string>();
  const [onNew, onOld] = await Promise.all([
    pathsWithMarkers(
      ctx,
      'new',
      text.filter((f) => f.status !== 'deleted').map((f) => f.path),
    ).catch(none),
    pathsWithMarkers(ctx, 'old', text.filter((f) => f.status !== 'added').map(oldPathOf)).catch(none),
  ]);
  const read = async (p: string, side: CommentSide, marked: Set<string>) => {
    if (!marked.has(p)) return undefined;
    const content = await getFullFile(ctx, p, side).catch(() => null);
    return content === null ? undefined : debugLineNumbers(content);
  };
  await mapLimit(
    text.filter((f) => onNew.has(f.path) || onOld.has(oldPathOf(f))),
    8,
    async (f) => {
      const [n, o] = await Promise.all([read(f.path, 'new', onNew), read(oldPathOf(f), 'old', onOld)]);
      markDebugLines(f, n, o);
    },
  );
}
