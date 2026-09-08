import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FileDiff, FileSummary, Target, TargetKey, WorktreeInfo, CommentSide } from '@warden/shared';
import { parseTargetKey, TargetKeyError } from '@warden/shared';
import { EMPTY_TREE_SHA, mergeBase, refExists, revParse, runGit } from './git.js';
import { parseUnifiedDiff } from './diffparse.js';
import { badRequest, HttpError } from './errors.js';
import type { RepoContext } from './repo.js';

export interface TargetContext {
  key: TargetKey;
  target: Target;
  /** Working directory to run git in (worktree root or repo root). */
  cwd: string;
}

const DIFF_BASE_ARGS = ['diff', '--no-color', '--no-ext-diff', '-U3', '-M', '--find-renames'];

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
      return [...DIFF_BASE_ARGS, `${t.base}...${t.head}`];
    }
    case 'base':
      return [...DIFF_BASE_ARGS, await baseSha(ctx, t.ref)];
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
  const r = await runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', file], { cwd });
  return r.stdout.split('\0').filter(Boolean).includes(file);
}

async function untrackedDiff(cwd: string, file: string): Promise<FileDiff | undefined> {
  // `git diff --no-index` exits 1 when there are differences (always, for a new file).
  const r = await runGit(['diff', '--no-color', '--no-ext-diff', '-U3', '--no-index', '--', '/dev/null', file], {
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
  const r = await runGit(args, { cwd: ctx.cwd });
  const files = parseUnifiedDiff(r.stdout);
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
  if (!filePath || filePath.startsWith('/') || filePath.split('/').includes('..')) {
    throw badRequest(`invalid path: ${filePath}`, 'invalid_path');
  }
  if (includesUntracked(ctx.target) && (hints.untracked || (await isUntracked(ctx.cwd, filePath)))) {
    return untrackedDiff(ctx.cwd, filePath);
  }
  const args = await diffArgs(ctx);
  const pathspec = [filePath];
  if (hints.oldPath && hints.oldPath !== filePath) pathspec.push(hints.oldPath);
  const r = await runGit([...args, '--', ...pathspec], { cwd: ctx.cwd });
  const files = parseUnifiedDiff(r.stdout);
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
      return side === 'new' ? t.head : t.base;
    case 'base':
      return side === 'new' ? undefined : baseSha(ctx, t.ref);
  }
}

/** Full content of a file on one side of the target; null when it does not exist there. */
export async function getFullFile(ctx: TargetContext, filePath: string, side: CommentSide): Promise<string | null> {
  if (!filePath || filePath.startsWith('/') || filePath.split('/').includes('..')) {
    throw badRequest(`invalid path: ${filePath}`, 'invalid_path');
  }
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
    const r = await runGit(['show', `${ref}:${filePath}`], { cwd: ctx.cwd });
    return r.stdout;
  } catch (e) {
    if (e instanceof HttpError && e.code === 'git_failed') return null;
    throw e;
  }
}
