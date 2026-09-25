import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import type {
  BranchInfo,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  ReleaseWorktreeRequest,
  RemoveWorktreeRequest,
  RemoveWorktreeResponse,
  WorktreeDetail,
  WorktreeInfo,
  WorktreeSlot,
} from '@warden/shared';
import { isValidRef } from '@warden/shared';
import { badRequest, HttpError } from './errors.js';
import { GitError, refExists, runGit, runGitWrite } from './git.js';
import { detectDefaultBase, listWorktrees, listWorktreesAll, type RepoContext } from './repo.js';

/**
 * The directories warden makes are numbered slots beside the main worktree — `<repo>-1`,
 * `<repo>-2`, … — not one directory per branch. A directory is where the dependencies get
 * installed, and a fresh one for every branch meant installing them for every branch. A slot
 * outlives its branch: released, it stays behind, node_modules and all, for the next branch to be
 * checked out into.
 */
export function slotPath(ctx: RepoContext, slot: number): string {
  return path.join(path.dirname(ctx.commonRoot), `${path.basename(ctx.commonRoot)}-${slot}`);
}

/** The number of the slot at `p`; undefined for a worktree made anywhere else, or named otherwise. */
export function slotOf(ctx: RepoContext, p: string): number | undefined {
  if (path.dirname(p) !== path.dirname(ctx.commonRoot)) return undefined;
  const prefix = `${path.basename(ctx.commonRoot)}-`;
  const name = path.basename(p);
  const n = name.startsWith(prefix) ? name.slice(prefix.length) : '';
  return /^[1-9]\d*$/.test(n) ? Number(n) : undefined;
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

/** The checkout `dir` is, if it is one of its own: git finds a parent's repository from a plain directory too. */
async function commonDirOf(dir: string): Promise<string | undefined> {
  try {
    const r = await runGit(['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd: dir });
    const [top, common] = r.stdout.trim().split('\n');
    if (!top || !common || (await realpath(top)) !== (await realpath(dir))) return undefined;
    return await realpath(path.resolve(dir, common));
  } catch {
    return undefined;
  }
}

/** The files git keeps while an operation that owns the working tree is stopped halfway. */
const IN_PROGRESS: [string, string][] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

/**
 * Whether the directory at a slot's path may be written: it has to be a checkout of this repository
 * — git lists an entry as long as `<dir>/.git` exists, so a repository cloned where a deleted slot
 * was still passes for the slot — and nothing may be stopped halfway in it, since a release, a
 * reuse or a removal would throw the half-done rebase or merge away.
 */
async function checkoutState(ctx: RepoContext, dir: string): Promise<{ foreign: boolean; busy?: string }> {
  const [ours, theirs] = await Promise.all([commonDirOf(ctx.commonRoot), commonDirOf(dir)]);
  if (!ours || ours !== theirs) return { foreign: true };
  const r = await runGit(['rev-parse', ...IN_PROGRESS.flatMap(([f]) => ['--git-path', f])], { cwd: dir });
  const paths = r.stdout.trim().split('\n');
  for (const [i, [, what]] of IN_PROGRESS.entries()) {
    const p = paths[i];
    if (
      p &&
      (await stat(path.resolve(dir, p)).then(
        () => true,
        () => false,
      ))
    )
      return { foreign: false, busy: what };
  }
  return { foreign: false };
}

export async function listWorktreesDetailed(ctx: RepoContext): Promise<WorktreeDetail[]> {
  const [all, upstreams] = await Promise.all([listWorktreesAll(ctx), listUpstreams(ctx)]);
  const main = all.find((w) => w.isMain);
  return Promise.all(
    all.map(async (w) => {
      const slot = w.isMain || w.bare ? undefined : slotOf(ctx, w.path);
      const dirty = w.prunable || w.bare ? 0 : await dirtyCount(w.path);
      const state = slot === undefined || w.prunable ? { foreign: false } : await checkoutState(ctx, w.path);
      const detail: WorktreeDetail = {
        ...w,
        dirty,
        ...(slot === undefined ? {} : { slot }),
        ...(state.foreign ? { foreign: true } : {}),
        ...(state.busy ? { busy: state.busy } : {}),
        // Free is what the next checkout may take over: a detached HEAD, nothing that would be lost,
        // nothing stopped halfway, and a checkout that is this repository's own.
        free: slot !== undefined && !w.prunable && w.detached && dirty === 0 && !state.foreign && !state.busy,
      };
      // A free slot holds no branch: there is nothing to compare.
      if (detail.free) return detail;
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

/** A directory git may make a worktree at: nothing there yet, or an empty one. */
async function dirUsable(p: string): Promise<boolean> {
  const st = await stat(p).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  return !st || (st.isDirectory() && (await readdir(p)).length === 0);
}

/**
 * The slot a checkout makes when it takes no free one: the lowest number with no directory of its
 * own. A number git lists is taken even with its directory gone — `worktree add` refuses the path
 * until the entry is removed.
 */
export async function nextSlot(ctx: RepoContext, worktrees: WorktreeInfo[]): Promise<WorktreeSlot> {
  const listed = new Set(worktrees.map((w) => w.path));
  for (let slot = 1; ; slot++) {
    const p = slotPath(ctx, slot);
    if (!listed.has(p) && (await dirUsable(p))) return { slot, path: p };
  }
}

/**
 * Where the branch goes. Unasked, the lowest free slot, else a new one at the next number. Asked
 * for by number, a slot that exists has to be free — one holding a branch is never switched from
 * under whoever is working in it, and one whose directory is gone has to be cleared first — and a
 * number no slot has yet is made. Either way the path is composed here: nothing in a request names
 * a directory, so a checkout cannot land anywhere but beside the main worktree.
 */
async function pickSlot(ctx: RepoContext, worktrees: WorktreeDetail[], wanted: number | undefined): Promise<WorktreeSlot & { reuse: boolean }> {
  const slots = worktrees.filter((w) => w.slot !== undefined);
  if (wanted === undefined) {
    const free = slots.filter((w) => w.free).sort((a, b) => a.slot! - b.slot!)[0];
    if (free) return { slot: free.slot!, path: free.path, reuse: true };
    return { ...(await nextSlot(ctx, worktrees)), reuse: false };
  }
  const have = slots.find((w) => w.slot === wanted);
  if (have?.prunable) throw new HttpError(409, `the directory of slot ${wanted} is gone; remove its entry first`, 'slot_gone');
  if (have?.foreign) throw new HttpError(409, `${have.path} is not a checkout of this repository`, 'not_our_checkout');
  if (have?.busy) throw new HttpError(409, `a ${have.busy} is in progress in slot ${wanted}`, 'operation_in_progress');
  if (have && !have.free) throw new HttpError(409, `slot ${wanted} is in use${have.branch ? ` by ${have.branch}` : ''}`, 'slot_in_use');
  if (have) return { slot: wanted, path: have.path, reuse: true };
  const p = slotPath(ctx, wanted);
  if (!(await dirUsable(p))) throw badRequest(`${p} already exists`, 'path_exists');
  return { slot: wanted, path: p, reuse: false };
}

/** `<remote>/<branch>` for each remote that has the branch; `*` spans one path segment, the remote's name. */
async function remoteBranches(cwd: string, branch: string): Promise<string[]> {
  const r = await runGit(['for-each-ref', '--format=%(refname:lstrip=2)', `refs/remotes/*/${branch}`], { cwd });
  return r.stdout.split('\n').filter(Boolean);
}

/**
 * Checks a branch out into a slot, deciding what the branch name refers to when the request arrives
 * rather than trusting the page's list, which may predate a fetch or a branch an agent just made. A
 * local branch is checked out as it is, which git allows in one worktree at a time. A branch only a
 * remote has becomes a local one tracking it (`--track`), as `git worktree add <path> <branch>`
 * guesses: starting it from the default base would give the name a second history without the
 * remote's commits, so a base is refused unless it says which remote — the one choice left when
 * several have the branch. Any other name is a new branch from `base`, or from `main`/`master` when
 * there is none.
 *
 * Into a free slot that is `git branch` in the main worktree — where a base such as `HEAD` means what
 * it would to `worktree add` — followed by `git switch` in the slot, which rewrites the files there as
 * any checkout does and leaves the ignored ones alone. Into a new slot it is `git worktree add`, with
 * the same choices as options.
 */
export async function checkoutWorktree(ctx: RepoContext, req: CreateWorktreeRequest): Promise<CreateWorktreeResponse> {
  const branch = req.branch.trim();
  const base = req.base?.trim();
  await assertBranchName(ctx, branch);
  const cwd = ctx.commonRoot;
  if (base) {
    if (!isValidRef(base)) throw badRequest(`invalid base ref: ${base}`, 'invalid_ref');
    if (!(await refExists(cwd, base))) throw badRequest(`unknown ref: ${base}`, 'unknown_ref');
  }
  const existing = await listWorktreesDetailed(ctx);
  /** Unset for a branch that exists; otherwise where the new one starts, and whether it tracks that. */
  let create: { start: string; track: boolean } | undefined;
  if (await refExists(cwd, `refs/heads/${branch}`)) {
    if (base) throw new HttpError(409, `branch ${branch} already exists`, 'branch_exists');
    const holder = existing.find((w) => w.branch === branch);
    if (holder) throw new HttpError(409, `${branch} is already checked out at ${holder.path}`, 'branch_in_use');
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
    create = remote.length ? { start: base || remote[0]!, track: true } : { start: base || (await detectDefaultBase(cwd)) || 'HEAD', track: false };
  }
  const target = await pickSlot(ctx, existing, req.slot);
  // A branch made for a slot that then refuses the switch would stay behind, taken; `-D` undoes
  // it, and only it — the branch has nothing of its own yet.
  let made = false;
  try {
    if (target.reuse) {
      if (create) {
        await runGitWrite(['branch', ...(create.track ? ['--track'] : []), branch, create.start], { cwd });
        made = true;
      }
      await runGitWrite(['switch', '--no-guess', branch], { cwd: target.path });
    } else if (create) {
      await runGitWrite(['worktree', 'add', ...(create.track ? ['--track'] : []), '-b', branch, target.path, create.start], { cwd });
    } else {
      await runGitWrite(['worktree', 'add', target.path, branch], { cwd });
    }
  } catch (e) {
    if (made) await runGitWrite(['branch', '-D', branch], { cwd }).catch(() => undefined);
    if (e instanceof GitError && /already (checked out|used by worktree)/.test(e.stderr)) throw new HttpError(409, e.message, 'branch_in_use');
    throw e;
  }
  const real = await realpath(target.path).catch(() => target.path);
  const worktree = (await listWorktrees(ctx)).find((w) => w.path === real);
  if (!worktree) throw new HttpError(500, `git checked ${branch} out at ${target.path} but does not list it`, 'git_failed');
  return { worktree, slot: target.slot, reused: target.reuse };
}

/** `git branch -d` on request. A branch that is not merged is kept, and the response says why. */
async function dropBranch(ctx: RepoContext, wt: WorktreeInfo, asked: boolean | undefined): Promise<RemoveWorktreeResponse> {
  const res: RemoveWorktreeResponse = { ok: true, branchDeleted: false };
  if (asked && wt.branch) {
    try {
      await runGitWrite(['branch', '-d', wt.branch], { cwd: ctx.commonRoot });
      res.branchDeleted = true;
    } catch (e) {
      res.branchError = e instanceof Error ? e.message : String(e);
    }
  }
  return res;
}

/**
 * Lets a slot go of its branch and keeps the directory: `git switch --detach` in it leaves HEAD's
 * commit checked out with no branch on it and touches no file. Uncommitted changes are refused as
 * 409 `worktree_dirty`, and only the request that carries `force` after that — the reviewer's
 * confirmation — discards them: `reset --hard` for the tracked files, `clean -fd` for the untracked
 * ones, never `-x`, so what is ignored (the installed dependencies, above all) stays. The branch
 * goes as it does on removal: on request, by `-d`, kept and reported when it is not merged. A
 * worktree that is not a slot is not released, since nothing would reuse it, and one whose
 * directory is gone has nothing to keep; both are for removal.
 */
export async function releaseWorktree(ctx: RepoContext, req: ReleaseWorktreeRequest): Promise<RemoveWorktreeResponse> {
  const p = req.path.trim();
  const wt = (await listWorktreesAll(ctx)).find((w) => w.path === p || (p && w.path === path.resolve(p)));
  if (!wt) throw badRequest(`unknown worktree: ${p}`, 'unknown_worktree');
  if (wt.isMain) throw badRequest('the main worktree cannot be released', 'main_worktree');
  if (wt.bare || slotOf(ctx, wt.path) === undefined) throw badRequest(`${wt.path} is not a slot; remove it instead`, 'not_a_slot');
  if (wt.prunable) throw badRequest(`the directory of ${wt.path} is gone; remove its entry instead`, 'worktree_gone');
  // Checked before anything else touches the directory: a forced release runs reset --hard and clean.
  const state = await checkoutState(ctx, wt.path);
  if (state.foreign) throw new HttpError(409, `${wt.path} is not a checkout of this repository; warden will not write in it`, 'not_our_checkout');
  if (state.busy) throw new HttpError(409, `a ${state.busy} is in progress in ${wt.path}; finish or abort it first`, 'operation_in_progress');
  const dirty = await dirtyCount(wt.path);
  if (dirty > 0 && !req.force) throw new HttpError(409, `${wt.path} has uncommitted changes`, 'worktree_dirty');
  if (dirty > 0) {
    // Not `switch --discard-changes`: with no start point it leaves a modified file alone.
    await runGitWrite(['reset', '-q', '--hard'], { cwd: wt.path });
    await runGitWrite(['clean', '-fdq'], { cwd: wt.path });
  }
  if (!wt.detached) await runGitWrite(['switch', '--detach'], { cwd: wt.path });
  return dropBranch(ctx, wt, req.deleteBranch);
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
  // git removes a clean checkout with a rebase stopped in it without a word; that is asked first.
  if (!wt.prunable && !req.force) {
    const state = await checkoutState(ctx, wt.path);
    if (state.busy) throw new HttpError(409, `a ${state.busy} is in progress in ${wt.path}; removing it throws that away`, 'needs_force');
  }
  const args = ['worktree', 'remove'];
  if (req.force) args.push('--force');
  args.push(wt.path);
  try {
    await runGitWrite(args, { cwd: ctx.commonRoot });
  } catch (e) {
    if (e instanceof GitError && /contains modified or untracked files/.test(e.stderr)) {
      throw new HttpError(409, `${wt.path} has uncommitted changes`, 'worktree_dirty');
    }
    if (e instanceof GitError && !req.force && /use --force|validation failed/.test(e.stderr)) {
      throw new HttpError(409, e.message, 'needs_force');
    }
    throw e;
  }
  return dropBranch(ctx, wt, req.deleteBranch);
}
