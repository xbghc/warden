import path from 'node:path';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import type { FileDiff, FileSummary, Target, TargetKey, WorktreeInfo, DiffSide } from '@warden/shared';
import { parseTargetKey, TargetKeyError } from '@warden/shared';
import { DIFF_OUTPUT_ARGS, EMPTY_TREE_SHA, mergeBase, refExists, revParse, runGit } from './git.js';
import { parseUnifiedDiff } from './diffparse.js';
import { badRequest, WardenError } from './errors.js';
import type { RepoContext } from './repo.js';
import { readWorktreeState } from './worktree-state.js';

export interface TargetContext {
  key: TargetKey;
  target: Target;
  /** Working directory to run git in (worktree root or repo root). */
  cwd: string;
}

async function runTargetDiff(ctx: TargetContext, args: string[]): Promise<string> {
  return (await runGit(args, { cwd: ctx.cwd })).stdout;
}

const DIFF_BASE_ARGS = ['diff', ...DIFF_OUTPUT_ARGS, '-M', '--find-renames'];

export function resolveTargetContext(repo: RepoContext, worktrees: WorktreeInfo[], key: TargetKey): TargetContext {
  let target: Target;
  try {
    target = parseTargetKey(key);
  } catch (e) {
    if (e instanceof TargetKeyError) throw badRequest(e.message, 'invalid_target');
    throw e;
  }
  // A key without a worktree is the main worktree's, whichever checkout this server was started in.
  // Using the server's own directory here would mix a slot's comparison with the main worktree's marks.
  let cwd = repo.commonRoot;
  if (target.worktree) {
    const wt = worktrees.find((w) => w.path === target.worktree);
    if (!wt) throw badRequest(`unknown worktree: ${target.worktree}`, 'unknown_worktree');
    cwd = wt.path;
  }
  return { key, target, cwd };
}

/** Validate with the filesystem's syntax before passing a literal path to Git or Node. */
export function assertRepoPath(p: string, platform: NodeJS.Platform = process.platform): void {
  const windows = platform === 'win32';
  const parts = p.split(windows ? /[\\/]/ : '/');
  // On POSIX a backslash or colon can be an ordinary filename character. On Windows
  // they can introduce traversal, a drive or an alternate stream instead of that file.
  const invalidWindows =
    windows &&
    (p.startsWith('\\') ||
      p.includes(':') ||
      parts.some(
        (part) =>
          /[<>"|?*]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /[ .]$/.test(part) ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(part.split('.')[0]!.replace(/ +$/, '')),
      ));
  if (!p || p.includes('\0') || p.startsWith('/') || parts.includes('..') || invalidWindows) throw badRequest(`invalid path: ${p}`, 'invalid_path');
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
  }
}

function includesUntracked(t: Target): boolean {
  return t.kind === 'working' || t.kind === 'all' || t.kind === 'base';
}

async function listUntracked(cwd: string): Promise<string[]> {
  const r = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
  return r.stdout.split('\0').filter(Boolean);
}

/** Paths with unmerged index entries: what a stopped merge, rebase or cherry-pick left in conflict. */
async function listUnmerged(cwd: string, file?: string): Promise<string[]> {
  const r = await runGit(['ls-files', '--unmerged', '-z', ...(file ? ['--', literal(file)] : [])], { cwd });
  // Each entry is `<mode> <sha> <stage>\t<path>`, one per stage of the same path.
  return [...new Set(r.stdout.split('\0').flatMap((e) => (e.includes('\t') ? [e.slice(e.indexOf('\t') + 1)] : [])))];
}

/**
 * A conflicted file as the working view shows it. `git diff` prints a combined diff for it, which
 * the parser cannot read, and `--cached` only a note, so the file vanished from both blocks just
 * when it needed looking at. Against HEAD it is an ordinary two-way diff with the markers in it.
 */
async function conflictDiff(ctx: TargetContext, file: string): Promise<FileDiff | undefined> {
  const base = (await hasHead(ctx.cwd)) ? 'HEAD' : EMPTY_TREE_SHA;
  const f = parseUnifiedDiff(await runTargetDiff(ctx, [...DIFF_BASE_ARGS, base, '--', literal(file)])).find((d) => d.path === file);
  return f ? { ...f, conflicted: true } : undefined;
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
  const files = parseUnifiedDiff(await runTargetDiff(ctx, [...args, '--']));
  if (ctx.target.kind === 'working') {
    for (const path of await listUnmerged(ctx.cwd)) {
      const d = await conflictDiff(ctx, path);
      if (!d) continue;
      const at = files.findIndex((f) => f.path === path);
      if (at >= 0) files[at] = d;
      else files.push(d);
    }
  }
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
  if (ctx.target.kind === 'working' && (await listUnmerged(ctx.cwd, filePath)).includes(filePath)) return conflictDiff(ctx, filePath);
  const args = await diffArgs(ctx);
  const pathspec = [literal(filePath)];
  if (hints.oldPath && hints.oldPath !== filePath) pathspec.push(literal(hints.oldPath));
  const files = parseUnifiedDiff(await runTargetDiff(ctx, [...args, '--', ...pathspec]));
  return files.find((f) => f.path === filePath) ?? files[0];
}

/** Which ref holds the content of `side` for this target (undefined = working tree file). */
async function refForSide(ctx: TargetContext, side: DiffSide): Promise<string | undefined> {
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
  }
}

/** Gitlinks name commits in another repository; show must not dereference them as local objects. */
async function gitlink(cwd: string, file: string, ref: string): Promise<string | undefined> {
  const staged = ref === ':0';
  const args = staged ? ['ls-files', '--stage', '-z', '--', literal(file)] : ['ls-tree', '-z', ref, '--', literal(file)];
  const result = await runGit(args, { cwd });
  const entry = result.stdout.split('\0')[0] ?? '';
  const fields = entry.slice(0, entry.indexOf('\t')).split(' ');
  if (fields[0] !== '160000' || (staged ? fields[2] !== '0' : fields[1] !== 'commit')) return undefined;
  return fields[staged ? 1 : 2];
}

/** Full content of a file on one side of the target; null when it does not exist there. */
export async function getFullFile(ctx: TargetContext, filePath: string, side: DiffSide): Promise<string | null> {
  assertRepoPath(filePath);
  const ref = await refForSide(ctx, side);
  if (ref === undefined) {
    try {
      const fullPath = path.join(ctx.cwd, filePath);
      // Git stores a symlink's destination text, including dangling and directory links.
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) return await readlink(fullPath);
      if (info.isDirectory()) {
        const indexed = await gitlink(ctx.cwd, filePath, ':0');
        if (!indexed) return null;
        const top = (await runGit(['rev-parse', '--show-toplevel'], { cwd: fullPath })).stdout.trim();
        // An uninitialized submodule is an empty directory where Git discovers the parent.
        if ((await realpath(top)) !== (await realpath(fullPath))) return `Subproject commit ${indexed}\n`;
        const state = await readWorktreeState(fullPath);
        return `Subproject commit ${state.head ?? indexed}${state.dirtyCount ? '-dirty' : ''}\n`;
      }
      const buf = await readFile(fullPath);
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }
  try {
    const commit = await gitlink(ctx.cwd, filePath, ref);
    if (commit) return `Subproject commit ${commit}\n`;
    // Without the separator Git also stats the entire revision:path as a filename,
    // which can exceed filesystem limits even when the actual file path is valid.
    const r = await runGit(['show', `${ref}:${filePath}`, '--'], { cwd: ctx.cwd });
    return r.stdout;
  } catch (e) {
    if (e instanceof WardenError && e.code === 'git_failed') return null;
    throw e;
  }
}
