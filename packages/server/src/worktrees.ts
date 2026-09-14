import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { BranchInfo, CreateWorktreeRequest, RemoveWorktreeRequest, RemoveWorktreeResponse, WorktreeDetail, WorktreeInfo } from '@warden/shared';
import { isValidRef } from '@warden/shared';
import { badRequest, HttpError } from './errors.js';
import { GitError, refExists, runGit, runGitWrite } from './git.js';
import { detectDefaultBase, listWorktrees, listWorktreesAll, type RepoContext } from './repo.js';

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

/** A local branch's upstream, as `git branch -vv` shows it. */
interface Upstream {
  /** `origin/topic`, or `main` for a branch set to track a local one. */
  name: string;
  /** The ref it tracks no longer exists: typically deleted on the remote once merged, then pruned by a fetch. */
  gone: boolean;
  ahead: number;
  behind: number;
}

/**
 * The upstream of every local branch that has one, keyed by branch name, counts included: one
 * `for-each-ref` for all of them. runGit's `LC_ALL=C` keeps `%(upstream:track)` in the English form
 * parsed here — `[ahead 1, behind 2]`, `[gone]`, or empty when the two are level.
 */
async function listUpstreams(ctx: RepoContext): Promise<Map<string, Upstream>> {
  const r = await runGit(['for-each-ref', '--format=%(refname)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'], { cwd: ctx.commonRoot });
  const out = new Map<string, Upstream>();
  for (const line of r.stdout.split('\n')) {
    const [ref = '', name = '', track = ''] = line.split('\t');
    if (!name) continue;
    out.set(ref.replace(/^refs\/heads\//, ''), {
      name,
      gone: track === '[gone]',
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    });
  }
  return out;
}

export async function listWorktreesDetailed(ctx: RepoContext): Promise<WorktreeDetail[]> {
  const [all, upstreams] = await Promise.all([listWorktreesAll(ctx), listUpstreams(ctx)]);
  const main = all.find((w) => w.isMain);
  return Promise.all(
    all.map(async (w) => {
      const detail: WorktreeDetail = { ...w, dirty: w.prunable || w.bare ? 0 : await dirtyCount(w.path) };
      // A branch that has an upstream is counted against it, the main worktree's included: what is
      // not pushed or not pulled yet says more about it than its distance from whatever the main
      // worktree has checked out. The upstream is also the ref `git branch -d` checks before deleting.
      const upstream = w.branch ? upstreams.get(w.branch) : undefined;
      if (upstream && !upstream.gone) {
        detail.comparison = { kind: 'upstream', base: upstream.name, ahead: upstream.ahead, behind: upstream.behind };
        return detail;
      }
      // Once the upstream is gone `git branch -d` checks HEAD instead, and the count follows it there.
      if (upstream) detail.upstreamGone = upstream.name;
      if (w.isMain) return detail;
      if (!main?.head || !w.head || /^0+$/.test(main.head) || /^0+$/.test(w.head)) return { ...detail, comparisonError: '分支尚无提交' };
      try {
        const result = await runGit(['rev-list', '--left-right', '--count', `${main.head}...${w.head}`, '--'], { cwd: ctx.commonRoot });
        const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
        detail.comparison = { kind: 'base', base: main.branch ?? `HEAD ${main.head.slice(0, 7)}`, ahead: ahead!, behind: behind! };
      } catch {
        detail.comparisonError = '无法比较提交历史';
      }
      return detail;
    }),
  );
}

/**
 * Local branches, each with the worktree that has it checked out (a prunable one still counts).
 * `lstrip=2` rather than `short`, which turns a branch that shares its name with a tag into
 * `heads/<name>`. Remote branches are left out: a remote can carry thousands of them, so the form asks
 * about the one name typed instead (`lookupRemoteBranches`).
 */
export async function listBranches(ctx: RepoContext, worktrees: WorktreeInfo[]): Promise<BranchInfo[]> {
  const r = await runGit(['for-each-ref', '--format=%(refname:lstrip=2)%09%(objectname:short)', 'refs/heads'], { cwd: ctx.commonRoot });
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

/**
 * `<remote>/<branch>` for each remote that has the branch named in the form, so the form can say it
 * will be checked out tracking one rather than started from the base.
 */
export async function lookupRemoteBranches(ctx: RepoContext, name: string): Promise<string[]> {
  const branch = name.trim();
  // The name becomes a `for-each-ref` pattern, where a `*` would match every remote branch there is.
  await assertBranchName(ctx, branch);
  return remoteBranches(ctx.commonRoot, branch);
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

/** `<remote>/<branch>` for each remote that has the branch; `*` spans one path segment, the remote's name. */
async function remoteBranches(cwd: string, branch: string): Promise<string[]> {
  const r = await runGit(['for-each-ref', '--format=%(refname:lstrip=2)', `refs/remotes/*/${branch}`], { cwd });
  return r.stdout.split('\n').filter(Boolean);
}

/**
 * `git worktree add`, deciding what the branch name refers to when the request arrives rather than
 * trusting the page's list, which may predate a fetch or a branch an agent just made. A local branch
 * is checked out as it is, which git allows in one worktree at a time. A branch only a remote has
 * becomes a local one tracking it (`--track -b`), as `git worktree add <path> <branch>` guesses:
 * starting it from the default base would give the name a second history without the remote's
 * commits, so a base is refused unless it says which remote — the one choice left when several have
 * the branch. Any other name is a new branch from `base`, or from `main`/`master` when there is none.
 */
export async function addWorktree(ctx: RepoContext, req: CreateWorktreeRequest): Promise<WorktreeInfo> {
  const branch = req.branch.trim();
  const base = req.base?.trim();
  await assertBranchName(ctx, branch);
  const existing = await listWorktreesAll(ctx);
  const target = await assertNewWorktreePath(ctx, existing, req.path.trim());
  const cwd = ctx.commonRoot;
  if (base) {
    if (!isValidRef(base)) throw badRequest(`invalid base ref: ${base}`, 'invalid_ref');
    if (!(await refExists(cwd, base))) throw badRequest(`unknown ref: ${base}`, 'unknown_ref');
  }
  let args: string[];
  if (await refExists(cwd, `refs/heads/${branch}`)) {
    if (base) throw new HttpError(409, `branch ${branch} already exists`, 'branch_exists');
    const holder = existing.find((w) => w.branch === branch);
    if (holder) throw new HttpError(409, `${branch} is already checked out at ${holder.path}`, 'branch_in_use');
    args = ['worktree', 'add', target, branch];
  } else if (await refExists(cwd, `refs/remotes/${branch}`)) {
    // A local `origin/x` would leave every later `origin/x` ambiguous, and it is never what was meant.
    throw new HttpError(409, `${branch} is a remote branch; enter ${branch.slice(branch.indexOf('/') + 1)} to check it out`, 'branch_exists');
  } else {
    const remote = await remoteBranches(cwd, branch);
    if (remote.length > 1 && !remote.includes(base ?? '')) {
      throw new HttpError(409, `branch ${branch} exists on several remotes; enter ${remote.join(' or ')} as the base`, 'ambiguous_branch');
    }
    if (remote.length === 1 && base && base !== remote[0]) {
      throw new HttpError(409, `branch ${branch} already exists as ${remote[0]}; leave the base empty to check it out`, 'branch_exists');
    }
    args = remote.length
      ? ['worktree', 'add', '--track', '-b', branch, target, base || remote[0]!]
      : ['worktree', 'add', '-b', branch, target, base || (await detectDefaultBase(cwd)) || 'HEAD'];
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
