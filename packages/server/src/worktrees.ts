import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import type {
  BranchInfo,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  ReleaseWorktreeRequest,
  RemoveWorktreeRequest,
  RemoveWorktreeResponse,
  SlotKind,
  WorktreeDetail,
  WorktreeInfo,
  WorktreeSlot,
} from '@warden/shared';
import { isValidRef } from '@warden/shared';
import { badRequest, HttpError } from './errors.js';
import { GitError, LONG_GIT_TIMEOUT_MS, refExists, runGit, runGitWrite } from './git.js';
import { detectDefaultBase, isCloneOf, listWorktrees, listWorktreesAll, remoteDefault, slotOf, slotPath, type RepoContext } from './repo.js';
import { clonedBranch, discardClone, dropCloneBranch, fetchClone, makeClone, removeClone } from './clones.js';
import { assertSafetyBackupCurrent, createSafetyBackup } from './backups.js';
import type { StateStore } from './state.js';
import { readWorktreeState } from './worktree-state.js';
import { ensureSharedRepository, importSharedCommit, isSharedCheckout } from './shared-repository.js';

export { slotOf, slotPath } from './repo.js';

/** Entries `git status` reports, renames counted once: what a worktree would lose if removed. */
export async function dirtyCount(cwd: string): Promise<number> {
  return (await readWorktreeState(cwd)).dirtyCount;
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
async function listUpstreams(cwd: string): Promise<Map<string, Upstream>> {
  const r = await runGit(['for-each-ref', '--format=%(refname)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'], { cwd });
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
 * was still passes for the slot; a clone slot has to be a clone of this repository still — and
 * nothing may be stopped halfway in it, since a release, a reuse or a removal would throw the
 * half-done rebase or merge away.
 */
export async function checkoutState(ctx: RepoContext, wt: WorktreeInfo): Promise<{ foreign: boolean; busy?: string }> {
  const dir = wt.path;
  if (wt.clone) {
    if (!(await isCloneOf(ctx.commonRoot, dir))) return { foreign: true };
  } else if (wt.shared) {
    if (!(await isSharedCheckout(ctx.commonRoot, dir))) return { foreign: true };
  } else {
    const [ours, theirs] = await Promise.all([commonDirOf(ctx.commonRoot), commonDirOf(dir)]);
    if (!ours || ours !== theirs) return { foreign: true };
  }
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

/** Main worktree first, then the slots by number, whichever kind, then worktrees made anywhere else. */
function listingOrder(a: WorktreeDetail, b: WorktreeDetail): number {
  const rank = (w: WorktreeDetail) => (w.isMain ? 0 : w.slot !== undefined ? 1 : 2);
  return rank(a) - rank(b) || (a.slot ?? 0) - (b.slot ?? 0);
}

export async function listWorktreesDetailed(ctx: RepoContext): Promise<WorktreeDetail[]> {
  const [all, upstreams] = await Promise.all([listWorktreesAll(ctx), listUpstreams(ctx.commonRoot)]);
  const shared = all.find((w) => w.shared && !w.prunable);
  const sharedUpstreams = shared ? await listUpstreams(shared.path) : new Map<string, Upstream>();
  const main = all.find((w) => w.isMain);
  const held = new Map<string, string>();
  for (const w of all) if (w.branch) held.set(w.branch, w.path);
  const details = await Promise.all(
    all.map(async (w) => {
      const slot = w.isMain || w.bare ? undefined : slotOf(ctx, w.path);
      const dirty = w.prunable || w.bare ? 0 : await dirtyCount(w.path).catch(() => -1);
      const state = slot === undefined || w.prunable ? { foreign: false } : await checkoutState(ctx, w);
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
      if (w.clone) return describeClone(detail, held);
      // A free slot holds no branch: there is nothing to compare.
      if (detail.free)
        return w.shared ? describeFreeBranches(detail, new Map(all.filter((row) => row.shared && row.branch).map((row) => [row.branch!, row.path]))) : detail;
      // A branch that has an upstream is counted against it, the main worktree's included: what is
      // not pushed or not pulled yet says more about it than its distance from whatever the main
      // worktree has checked out. The upstream is also the ref `git branch -d` checks before deleting.
      const upstream = w.branch ? (w.shared ? sharedUpstreams : upstreams).get(w.branch) : undefined;
      if (upstream && !upstream.gone) {
        detail.comparison = { kind: 'upstream', base: upstream.name, ahead: upstream.ahead, behind: upstream.behind };
        return detail;
      }
      // Once the upstream is gone `git branch -d` checks HEAD instead, and the count follows it there.
      if (upstream) detail.upstreamGone = upstream.name;
      if (w.isMain) return detail;
      if (!main?.head || !w.head || /^0+$/.test(main.head) || /^0+$/.test(w.head)) return { ...detail, comparisonError: '分支尚无提交' };
      try {
        const result = await runGit(['rev-list', '--left-right', '--count', `${main.head}...${w.head}`, '--'], {
          cwd: w.shared ? w.path : ctx.commonRoot,
        });
        const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
        detail.comparison = { kind: 'base', base: main.branch ?? `HEAD ${main.head.slice(0, 7)}`, ahead: ahead!, behind: behind! };
      } catch {
        detail.comparisonError = '无法比较提交历史';
      }
      return detail;
    }),
  );
  return details.sort(listingOrder);
}

/**
 * What the panel shows of a clone, read in the clone: its branches are its own. A branch with an
 * upstream is counted against it; any other, or one whose upstream is gone, against the clone's remote
 * default branch — the main worktree's HEAD is in another repository, one this clone shares nothing
 * with. A free clone lists its local branches, which the checkout form offers for it, each marked
 * with the checkout that has a branch of that name: two checkouts on one name would push to one
 * branch on the server.
 */
async function describeClone(detail: WorktreeDetail, held: Map<string, string>): Promise<WorktreeDetail> {
  if (detail.foreign) return detail;
  const cwd = detail.path;
  const trunk = detail.trunk;
  if (detail.free) return describeFreeBranches(detail, held);
  const upstream = detail.branch ? (await listUpstreams(cwd)).get(detail.branch) : undefined;
  if (upstream && !upstream.gone) {
    detail.comparison = { kind: 'upstream', base: upstream.name, ahead: upstream.ahead, behind: upstream.behind };
    return detail;
  }
  if (upstream) detail.upstreamGone = upstream.name;
  if (!trunk) return detail;
  try {
    const result = await runGit(['rev-list', '--left-right', '--count', `${trunk}...HEAD`, '--'], { cwd });
    const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
    detail.comparison = { kind: 'trunk', base: trunk, ahead: ahead!, behind: behind! };
  } catch {
    detail.comparisonError = '无法比较提交历史';
  }
  return detail;
}

async function describeFreeBranches(detail: WorktreeDetail, held: Map<string, string>): Promise<WorktreeDetail> {
  const r = await runGit(['for-each-ref', '--format=%(refname:lstrip=2)%09%(objectname:short)', 'refs/heads'], { cwd: detail.path });
  detail.branches = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = ''] = line.split('\t');
      const worktree = held.get(name);
      return { name, sha, ...(worktree ? { worktree } : {}) };
    });
  return detail;
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
  for (const w of worktrees) if (w.branch && !w.clone && !w.shared) at.set(w.branch, w.path);
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
 * will be checked out tracking one rather than started from the base. Looked up where the checkout
 * would read it: in the clone, for a slot that is one — its remote-tracking branches are its own —
 * and in the main worktree otherwise, whose are what a new clone starts with.
 */
export async function lookupRemoteBranches(ctx: RepoContext, name: string, slot?: number): Promise<string[]> {
  const branch = name.trim();
  // The name becomes a `for-each-ref` pattern, where a `*` would match every remote branch there is.
  await assertBranchName(ctx, branch);
  const own = slot === undefined ? undefined : (await listWorktreesAll(ctx)).find((w) => (w.clone || w.shared) && w.path === slotPath(ctx, slot));
  return remoteBranches(own?.path ?? ctx.commonRoot, branch);
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
 * number no slot has yet is made, as `kind` says. A slot that exists is what it was made as. Either
 * way the path is composed here: nothing in a request names a directory, so a checkout cannot land
 * anywhere but beside the main worktree.
 */
async function pickSlot(
  ctx: RepoContext,
  worktrees: WorktreeDetail[],
  wanted: number | undefined,
  kind: SlotKind,
): Promise<WorktreeSlot & { reuse: boolean; clone: boolean; shared: boolean }> {
  const slots = worktrees.filter((w) => w.slot !== undefined);
  if (wanted === undefined) {
    const free = slots.filter((w) => w.free).sort((a, b) => a.slot! - b.slot!)[0];
    if (free) return { slot: free.slot!, path: free.path, reuse: true, clone: !!free.clone, shared: !!free.shared };
    return { ...(await nextSlot(ctx, worktrees)), reuse: false, clone: kind === 'clone', shared: kind === 'shared' };
  }
  const have = slots.find((w) => w.slot === wanted);
  if (have?.prunable) throw new HttpError(409, `the directory of slot ${wanted} is gone; remove its entry first`, 'slot_gone');
  if (have?.foreign) throw new HttpError(409, `${have.path} is not a checkout of this repository`, 'not_our_checkout');
  if (have?.busy) throw new HttpError(409, `a ${have.busy} is in progress in slot ${wanted}`, 'operation_in_progress');
  if (have && !have.free) throw new HttpError(409, `slot ${wanted} is in use${have.branch ? ` by ${have.branch}` : ''}`, 'slot_in_use');
  if (have) return { slot: wanted, path: have.path, reuse: true, clone: !!have.clone, shared: !!have.shared };
  const p = slotPath(ctx, wanted);
  if (!(await dirUsable(p))) throw badRequest(`${p} already exists`, 'path_exists');
  return { slot: wanted, path: p, reuse: false, clone: kind === 'clone', shared: kind === 'shared' };
}

/** `<remote>/<branch>` for each remote that has the branch; `*` spans one path segment, the remote's name. */
async function remoteBranches(cwd: string, branch: string): Promise<string[]> {
  const r = await runGit(['for-each-ref', '--format=%(refname:lstrip=2)', `refs/remotes/*/${branch}`], { cwd });
  return r.stdout.split('\n').filter(Boolean);
}

/**
 * What a branch name refers to in the repository at `cwd`, decided when the request arrives rather
 * than from the page's list, which may predate a fetch or a branch an agent just made. A local
 * branch is checked out as it is: undefined. A branch only a remote has becomes a local one
 * tracking it (`--track`), as `git worktree add <path> <branch>` guesses: starting it from the
 * default base would give the name a second history without the remote's commits, so a base is
 * refused unless it says which remote — the one choice left when several have the branch. Any other
 * name is a new branch from `base`, or from `fallback()` when there is none.
 */
async function resolveBranch(
  cwd: string,
  branch: string,
  base: string | undefined,
  fallback: () => Promise<string>,
): Promise<{ start: string; track: boolean } | undefined> {
  if (base && !(await refExists(cwd, base))) throw badRequest(`unknown ref: ${base}`, 'unknown_ref');
  if (await refExists(cwd, `refs/heads/${branch}`)) {
    if (base) throw new HttpError(409, `branch ${branch} already exists`, 'branch_exists');
    return undefined;
  }
  // A local `origin/x` would leave every later `origin/x` ambiguous, and it is never what was meant.
  if (await refExists(cwd, `refs/remotes/${branch}`)) {
    throw new HttpError(409, `${branch} is a remote branch; enter ${branch.slice(branch.indexOf('/') + 1)} to check it out`, 'branch_exists');
  }
  const remote = await remoteBranches(cwd, branch);
  if (remote.length > 1 && !remote.includes(base ?? '')) {
    throw new HttpError(409, `branch ${branch} exists on several remotes; enter ${remote.join(' or ')} as the base`, 'ambiguous_branch');
  }
  if (remote.length === 1 && base && base !== remote[0]) {
    throw new HttpError(409, `branch ${branch} already exists as ${remote[0]}; leave the base empty to check it out`, 'branch_exists');
  }
  return remote.length ? { start: base || remote[0]!, track: true } : { start: base || (await fallback()), track: false };
}

/** Refuses a name some checkout has on: git keeps a branch in one worktree, and two clones on one name would push to one branch. */
function assertBranchFree(worktrees: WorktreeDetail[], branch: string): void {
  const holder = worktrees.find((w) => w.branch === branch);
  if (holder) throw new HttpError(409, `${branch} is already checked out at ${holder.path}`, 'branch_in_use');
}

/**
 * Checks a branch out into a slot (see `resolveBranch` for what the name becomes).
 *
 * A worktree slot reads the name in the main worktree, whose refs it shares. Into a free one that is
 * `git branch` in the main worktree — where a base such as `HEAD` means what it would to `worktree
 * add` — followed by `git switch` in the slot, which rewrites the files there as any checkout does and
 * leaves the ignored ones alone. Into a new slot it is `git worktree add`, with the same choices as
 * options; the default base is `main`/`master`.
 *
 * A clone slot reads it in the clone, after `git fetch --all` there when asked: its branches and its
 * view of the server are its own. A new one is made first (`makeClone`), and dropped again should
 * the checkout then fail. The branch is made and switched to in the clone; the default base is its
 * remote's default branch. The branch `git clone` made for the main worktree's HEAD goes once the
 * clone is on its own branch.
 */
export async function checkoutWorktree(ctx: RepoContext, req: CreateWorktreeRequest): Promise<CreateWorktreeResponse> {
  const branch = req.branch.trim();
  const base = req.base?.trim() || undefined;
  await assertBranchName(ctx, branch);
  if (base && !isValidRef(base)) throw badRequest(`invalid base ref: ${base}`, 'invalid_ref');
  const existing = await listWorktreesDetailed(ctx);
  const target = await pickSlot(ctx, existing, req.slot, req.kind ?? 'worktree');
  if (target.clone) await checkoutClone(ctx, existing, target, branch, base, !!req.fetch);
  else if (target.shared) await checkoutShared(ctx, existing, target, branch, base);
  else await checkoutLinked(ctx, existing, target, branch, base);
  const real = await realpath(target.path).catch(() => target.path);
  const worktree = (await listWorktrees(ctx)).find((w) => w.path === real);
  if (!worktree) throw new HttpError(500, `git checked ${branch} out at ${target.path} but does not list it`, 'git_failed');
  return { worktree, slot: target.slot, reused: target.reuse };
}

async function checkoutLinked(
  ctx: RepoContext,
  existing: WorktreeDetail[],
  target: WorktreeSlot & { reuse: boolean },
  branch: string,
  base?: string,
  repository = ctx.commonRoot,
): Promise<void> {
  const cwd = repository;
  const create = await resolveBranch(cwd, branch, base, async () => (await detectDefaultBase(cwd)) || 'HEAD');
  assertBranchFree(existing, branch);
  // A branch made for a slot that then refuses the switch would stay behind, taken; `-D` undoes
  // it, and only it — the branch has nothing of its own yet.
  let made = false;
  try {
    if (target.reuse) {
      if (create) {
        await runGitWrite(['branch', ...(create.track ? ['--track'] : []), branch, create.start], { cwd });
        made = true;
      }
      // A clean status can still hide ignored local configuration that the next branch tracks.
      await runGitWrite(['switch', '--no-guess', '--no-overwrite-ignore', branch], { cwd: target.path });
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
}

async function checkoutShared(
  ctx: RepoContext,
  existing: WorktreeDetail[],
  target: WorktreeSlot & { reuse: boolean },
  branch: string,
  base?: string,
): Promise<void> {
  assertBranchFree(existing, branch);
  const repository = await ensureSharedRepository(ctx.commonRoot);
  if (await refExists(repository, `refs/heads/${branch}`)) {
    // Existing task branches retain their history; they never resolve through primary refs.
    await checkoutLinked(ctx, existing, target, branch, base, repository);
    return;
  }
  const wanted = base ?? (await detectDefaultBase(ctx.commonRoot)) ?? 'HEAD';
  // Explicit bases may name another shared task. Primary refs are the default source and are
  // imported as immutable commits without creating a primary-named branch in the shared store.
  let sha: string;
  if (base && (await refExists(repository, base))) sha = (await runGit(['rev-parse', '--verify', `${base}^{commit}`], { cwd: repository })).stdout.trim();
  else {
    if (!(await refExists(ctx.commonRoot, wanted))) throw badRequest(`unknown ref: ${wanted}`, 'unknown_ref');
    sha = (await runGit(['rev-parse', '--verify', `${wanted}^{commit}`], { cwd: ctx.commonRoot })).stdout.trim();
    await importSharedCommit(ctx.commonRoot, ctx.commonRoot, sha);
  }
  await checkoutLinked(ctx, existing, target, branch, sha, repository);
}

async function checkoutClone(
  ctx: RepoContext,
  existing: WorktreeDetail[],
  target: WorktreeSlot & { reuse: boolean },
  branch: string,
  base: string | undefined,
  fetch: boolean,
): Promise<void> {
  // Before anything is cloned or fetched: a name some checkout has on is refused wherever it lives.
  assertBranchFree(existing, branch);
  const cwd = target.path;
  if (!target.reuse) await makeClone(ctx, cwd);
  try {
    if (fetch) await fetchClone(cwd);
    const create = await resolveBranch(cwd, branch, base, async () => (await remoteDefault(cwd)) ?? (await detectDefaultBase(cwd)) ?? 'HEAD');
    const cloned = target.reuse ? undefined : await clonedBranch(cwd);
    let made = false;
    try {
      if (create) {
        await runGitWrite(['branch', ...(create.track ? ['--track'] : []), branch, create.start], { cwd });
        made = true;
      }
      // A new clone has every file still to write, and a large repository takes a while.
      await runGitWrite(['switch', '--no-guess', '--no-overwrite-ignore', branch], { cwd, timeoutMs: LONG_GIT_TIMEOUT_MS });
    } catch (e) {
      if (made) await runGitWrite(['branch', '-D', branch], { cwd }).catch(() => undefined);
      throw e;
    }
    // A copy of the main worktree's branch as the clone found it: the main worktree still has it,
    // and a clone keeps the branches that were checked out in it, not one that never was.
    if (cloned && cloned !== branch) await runGitWrite(['branch', '-D', cloned], { cwd });
  } catch (e) {
    if (!target.reuse) await discardClone(cwd);
    throw e;
  }
}

/** `git branch -d` on request. A branch that is not merged is kept, and the response says why. */
async function dropBranch(ctx: RepoContext, wt: WorktreeInfo, asked: boolean | undefined): Promise<RemoveWorktreeResponse> {
  const res: RemoveWorktreeResponse = { ok: true, branchDeleted: false };
  if (asked && wt.branch) {
    try {
      if (wt.shared) await dropSharedBranch(ctx, wt.branch);
      else await runGitWrite(['branch', '-d', wt.branch], { cwd: ctx.commonRoot });
      res.branchDeleted = true;
    } catch (e) {
      res.branchError = e instanceof Error ? e.message : String(e);
    }
  }
  return res;
}

/** A bare repository's HEAD is not the delivery baseline. Check that baseline explicitly before
 * deleting only the exact observed ref; squash-delivered source histories remain conservatively kept.
 */
async function dropSharedBranch(ctx: RepoContext, branch: string): Promise<void> {
  const primaryHead = (await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: ctx.commonRoot })).stdout.trim();
  const repository = await importSharedCommit(ctx.commonRoot, ctx.commonRoot, primaryHead);
  const ref = `refs/heads/${branch}`;
  const head = (await runGit(['rev-parse', '--verify', ref], { cwd: repository })).stdout.trim();
  const upstream = (await listUpstreams(repository)).get(branch);
  const target =
    upstream && !upstream.gone ? (await runGit(['rev-parse', '--verify', `${upstream.name}^{commit}`], { cwd: repository })).stdout.trim() : primaryHead;
  if ((await runGit(['merge-base', '--is-ancestor', head, target], { cwd: repository, okCodes: [0, 1] })).code !== 0)
    throw new HttpError(409, `分支 ${branch} 尚未完整合入目标，已保留`, 'branch_not_merged');
  // Public inventory excludes internal and manually placed worktrees, but all registered
  // checkouts protect their branch, just as they do for Git's ordinary branch deletion.
  const worktrees = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: repository });
  if (worktrees.stdout.split('\0').includes(`branch ${ref}`)) throw new HttpError(409, `分支 ${branch} 仍在工作区中使用，已保留`, 'branch_in_use');
  await runGitWrite(['update-ref', '-d', ref, head], { cwd: repository });
}

/**
 * Lets a slot go of its branch and keeps the directory: `git switch --detach` in it leaves HEAD's
 * commit checked out with no branch on it and touches no file. A clone keeps the branch as well,
 * unless deleting it is asked for and its upstream has all of it (`dropCloneBranch`). Uncommitted changes are refused as
 * 409 `worktree_dirty`, and only the request that carries `force` after that — the reviewer's
 * confirmation — discards them: `reset --hard` for the tracked files, `clean -fd` for the untracked
 * ones, never `-x`, so what is ignored (the installed dependencies, above all) stays. The branch
 * goes as it does on removal: on request, by `-d`, kept and reported when it is not merged. A
 * worktree that is not a slot is not released, since nothing would reuse it, and one whose
 * directory is gone has nothing to keep; both are for removal.
 */
export async function releaseWorktree(ctx: RepoContext, req: ReleaseWorktreeRequest, store: StateStore): Promise<RemoveWorktreeResponse> {
  const p = req.path.trim();
  const wt = (await listWorktreesAll(ctx)).find((w) => w.path === p || (p && w.path === path.resolve(p)));
  if (!wt) throw badRequest(`unknown worktree: ${p}`, 'unknown_worktree');
  if (wt.isMain) throw badRequest('the main worktree cannot be released', 'main_worktree');
  if (wt.bare || slotOf(ctx, wt.path) === undefined) throw badRequest(`${wt.path} is not a slot; remove it instead`, 'not_a_slot');
  if (wt.prunable) throw badRequest(`the directory of ${wt.path} is gone; remove its entry instead`, 'worktree_gone');
  // Checked before anything else touches the directory: a forced release runs reset --hard and clean.
  const state = await checkoutState(ctx, wt);
  if (state.foreign) throw new HttpError(409, `${wt.path} is not a checkout of this repository; warden will not write in it`, 'not_our_checkout');
  if (state.busy) throw new HttpError(409, `a ${state.busy} is in progress in ${wt.path}; finish or abort it first`, 'operation_in_progress');
  const dirty = await dirtyCount(wt.path);
  if (dirty > 0 && !req.force) throw new HttpError(409, `${wt.path} has uncommitted changes`, 'worktree_dirty');
  const backup = await createSafetyBackup(store, wt.path, 'release');
  const current = await checkoutState(ctx, wt);
  if (current.foreign || current.busy) throw new HttpError(409, '备份后工作区状态已变化，请刷新重试', 'worktree_changed');
  await assertSafetyBackupCurrent(backup);
  if (dirty > 0) {
    // Not `switch --discard-changes`: with no start point it leaves a modified file alone.
    await runGitWrite(['reset', '-q', '--hard'], { cwd: wt.path });
    await runGitWrite(['clean', '-fdq'], { cwd: wt.path });
  }
  if (!wt.detached) await runGitWrite(['switch', '--detach'], { cwd: wt.path });
  const result = await (wt.clone ? dropCloneBranch(wt, req.deleteBranch) : dropBranch(ctx, wt, req.deleteBranch));
  return { ...result, backup };
}

/**
 * `git worktree remove`, or for a clone the deletion of its directory (`removeClone`), which takes
 * its branches with it. `--force` is passed only when the request carries it, which the UI sends
 * only after the reviewer confirmed: git's refusals come back as 409 — `worktree_dirty` for
 * uncommitted changes, `needs_force` for anything else git wants forced (an older git validating
 * that a directory that is gone exists, say) — and the second request is the confirmation. An entry
 * whose directory is gone is removed like any other, one entry at a time; `prune` would take every
 * such entry at once. The branch is deleted only on request and only with `-d`, so one that is not
 * merged stays and the response says why.
 */
export async function removeWorktree(ctx: RepoContext, req: RemoveWorktreeRequest, store: StateStore): Promise<RemoveWorktreeResponse> {
  const p = req.path.trim();
  const wt = (await listWorktreesAll(ctx)).find((w) => w.path === p || (p && w.path === path.resolve(p)));
  if (!wt) throw badRequest(`unknown worktree: ${p}`, 'unknown_worktree');
  if (wt.isMain) throw badRequest('the main worktree cannot be removed', 'main_worktree');
  if (wt.clone) {
    const state = await checkoutState(ctx, wt);
    const backup = await removeClone(ctx, wt.path, { dirty: await dirtyCount(wt.path), busy: state.busy, force: req.force }, store);
    return { ok: true, branchDeleted: false, backup };
  }
  // git removes a clean checkout with a rebase stopped in it without a word; that is asked first.
  if (!wt.prunable) {
    const state = await checkoutState(ctx, wt);
    if (state.foreign) throw new HttpError(409, `${wt.path} is not a checkout of this repository`, 'not_our_checkout');
    if (state.busy && !req.force) throw new HttpError(409, `a ${state.busy} is in progress in ${wt.path}; removing it throws that away`, 'needs_force');
    if (!req.force && (await dirtyCount(wt.path))) throw new HttpError(409, `${wt.path} has uncommitted changes`, 'worktree_dirty');
  }
  const backup = wt.prunable ? undefined : await createSafetyBackup(store, wt.path, 'remove');
  if (!wt.prunable && (await checkoutState(ctx, wt)).foreign) throw new HttpError(409, '备份后工作区身份已变化，请刷新重试', 'not_our_checkout');
  if (backup) await assertSafetyBackupCurrent(backup);
  const args = ['worktree', 'remove'];
  if (req.force) args.push('--force');
  args.push(wt.path);
  try {
    await runGitWrite(args, { cwd: wt.shared ? await ensureSharedRepository(ctx.commonRoot) : ctx.commonRoot });
  } catch (e) {
    if (e instanceof GitError && /contains modified or untracked files/.test(e.stderr)) {
      throw new HttpError(409, `${wt.path} has uncommitted changes`, 'worktree_dirty');
    }
    if (e instanceof GitError && !req.force && /use --force|validation failed/.test(e.stderr)) {
      throw new HttpError(409, e.message, 'needs_force');
    }
    throw e;
  }
  return { ...(await dropBranch(ctx, wt, req.deleteBranch)), ...(backup ? { backup } : {}) };
}
