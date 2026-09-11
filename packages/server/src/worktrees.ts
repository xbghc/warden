import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { BranchInfo, CreateWorktreeRequest, RemoveWorktreeRequest, RemoveWorktreeResponse, WorktreeDetail, WorktreeInfo } from '@warden/shared';
import { isValidRef } from '@warden/shared';
import { badRequest, HttpError } from './errors.js';
import { GitError, refExists, runGit, runGitWrite } from './git.js';
import { listWorktrees, listWorktreesAll, type RepoContext } from './repo.js';

/**
 * Where a new worktree goes unless the request says otherwise: beside the main worktree, named
 * `<repo>-<branch>`. The client appends the branch (slashes as dashes) and lets the path be edited.
 */
export function worktreePathPrefix(ctx: RepoContext): string {
  return path.join(path.dirname(ctx.commonRoot), `${path.basename(ctx.commonRoot)}-`);
}

/** Entries `git status` reports, renames counted once: what a worktree would lose if removed. */
async function dirtyCount(cwd: string): Promise<number> {
  try {
    const r = await runGit(['status', '--porcelain', '--untracked-files=all'], { cwd });
    return r.stdout.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

export async function listWorktreesDetailed(ctx: RepoContext): Promise<WorktreeDetail[]> {
  const all = await listWorktreesAll(ctx);
  const main = all.find((w) => w.isMain);
  return Promise.all(
    all.map(async (w) => {
      const detail: WorktreeDetail = { ...w, dirty: w.prunable || w.bare ? 0 : await dirtyCount(w.path) };
      if (w.isMain) return detail;
      if (!main?.head || !w.head || /^0+$/.test(main.head) || /^0+$/.test(w.head)) return { ...detail, comparisonError: '分支尚无提交' };
      try {
        const result = await runGit(['rev-list', '--left-right', '--count', `${main.head}...${w.head}`, '--'], { cwd: ctx.commonRoot });
        const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
        detail.comparison = { base: main.branch ?? `HEAD ${main.head.slice(0, 7)}`, ahead: ahead!, behind: behind!, merged: ahead === 0 };
      } catch {
        detail.comparisonError = '无法比较提交历史';
      }
      return detail;
    }),
  );
}

/** Local branches, each with the worktree that has it checked out (a prunable one still counts). */
export async function listBranches(ctx: RepoContext, worktrees: WorktreeInfo[]): Promise<BranchInfo[]> {
  const r = await runGit(['for-each-ref', '--format=%(refname:short)%09%(objectname:short)', 'refs/heads'], { cwd: ctx.commonRoot });
  const at = new Map<string, string>();
  for (const w of worktrees) if (w.branch) at.set(w.branch, w.path);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = ''] = line.split('\t');
      const worktree = at.get(name);
      return { name, sha, ...(worktree ? { worktree } : {}) };
    });
}

/** A branch name git would accept, and one that is only ever a name: no `@{-1}`-style expansion. */
async function assertBranchName(ctx: RepoContext, name: string): Promise<void> {
  if (!isValidRef(name) || name.includes('@{') || name.startsWith('refs/')) throw badRequest(`invalid branch name: ${name}`, 'invalid_branch');
  try {
    await runGit(['check-ref-format', '--branch', name], { cwd: ctx.commonRoot });
  } catch {
    throw badRequest(`invalid branch name: ${name}`, 'invalid_branch');
  }
}

/**
 * Where a worktree may be created: under the main worktree's parent directory and outside every
 * existing worktree, so a request cannot drop a checkout into the repository itself or anywhere else
 * on the disk. The directory must be new, or empty.
 */
async function assertNewWorktreePath(ctx: RepoContext, worktrees: WorktreeInfo[], p: string): Promise<string> {
  if (!p || !path.isAbsolute(p)) throw badRequest('worktree path must be absolute', 'invalid_path');
  const target = path.resolve(p);
  const parent = path.dirname(ctx.commonRoot);
  if (target === parent || !target.startsWith(parent + path.sep)) throw badRequest(`worktree path must be under ${parent}`, 'invalid_path');
  for (const w of worktrees) {
    if (target === w.path || target.startsWith(w.path + path.sep)) throw badRequest(`${target} is inside the worktree at ${w.path}`, 'invalid_path');
  }
  const st = await stat(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  if (!st) return target;
  if (!st.isDirectory() || (await readdir(target)).length > 0) throw badRequest(`${target} already exists`, 'path_exists');
  return target;
}

/**
 * `git worktree add`: with `base`, a new branch is made from it (`-b`); without, an existing branch
 * is checked out, which git allows in one worktree at a time.
 */
export async function addWorktree(ctx: RepoContext, req: CreateWorktreeRequest): Promise<WorktreeInfo> {
  const branch = req.branch.trim();
  const base = req.base?.trim();
  await assertBranchName(ctx, branch);
  const existing = await listWorktreesAll(ctx);
  const target = await assertNewWorktreePath(ctx, existing, req.path.trim());
  const cwd = ctx.commonRoot;
  const branchExists = await refExists(cwd, `refs/heads/${branch}`);
  let args: string[];
  if (base) {
    if (!isValidRef(base)) throw badRequest(`invalid base ref: ${base}`, 'invalid_ref');
    if (!(await refExists(cwd, base))) throw badRequest(`unknown ref: ${base}`, 'unknown_ref');
    if (branchExists) throw new HttpError(409, `branch ${branch} already exists`, 'branch_exists');
    args = ['worktree', 'add', '-b', branch, target, base];
  } else {
    if (!branchExists) throw badRequest(`unknown branch: ${branch}`, 'unknown_ref');
    const holder = existing.find((w) => w.branch === branch);
    if (holder) throw new HttpError(409, `${branch} is already checked out at ${holder.path}`, 'branch_in_use');
    args = ['worktree', 'add', target, branch];
  }
  try {
    await runGitWrite(args, { cwd });
  } catch (e) {
    if (e instanceof GitError && /already (checked out|used by worktree)/.test(e.stderr)) throw new HttpError(409, e.message, 'branch_in_use');
    throw e;
  }
  const real = await realpath(target).catch(() => target);
  const made = (await listWorktrees(ctx)).find((w) => w.path === real);
  if (!made) throw new HttpError(500, `git created ${target} but does not list it`, 'git_failed');
  return made;
}

/**
 * `git worktree remove`. `--force` is passed only when the request carries it, which the UI sends
 * only after the reviewer confirmed: git's refusals come back as 409 — `worktree_dirty` for
 * uncommitted changes, `needs_force` for anything else git wants forced (an older git validating
 * that a directory that is gone exists, say) — and the second request is the confirmation. An entry
 * whose directory is gone is removed like any other, one entry at a time; `prune` would take every
 * such entry at once. The branch is deleted only on request and only with `-d`, so one that is not
 * merged stays and the response says why.
 */
export async function removeWorktree(ctx: RepoContext, req: RemoveWorktreeRequest): Promise<RemoveWorktreeResponse> {
  const p = req.path.trim();
  const wt = (await listWorktreesAll(ctx)).find((w) => w.path === p || (p && w.path === path.resolve(p)));
  if (!wt) throw badRequest(`unknown worktree: ${p}`, 'unknown_worktree');
  if (wt.isMain) throw badRequest('the main worktree cannot be removed', 'main_worktree');
  const cwd = ctx.commonRoot;
  const args = ['worktree', 'remove'];
  if (req.force) args.push('--force');
  args.push(wt.path);
  try {
    await runGitWrite(args, { cwd });
  } catch (e) {
    if (e instanceof GitError && /contains modified or untracked files/.test(e.stderr)) {
      throw new HttpError(409, `${wt.path} has uncommitted changes`, 'worktree_dirty');
    }
    if (e instanceof GitError && !req.force && /use --force|validation failed/.test(e.stderr)) {
      throw new HttpError(409, e.message, 'needs_force');
    }
    throw e;
  }
  const res: RemoveWorktreeResponse = { ok: true, branchDeleted: false };
  if (req.deleteBranch && wt.branch) {
    try {
      await runGitWrite(['branch', '-d', wt.branch], { cwd });
      res.branchDeleted = true;
    } catch (e) {
      res.branchError = e instanceof Error ? e.message : String(e);
    }
  }
  return res;
}
