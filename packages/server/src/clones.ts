import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { RemoveWorktreeResponse, WorktreeInfo } from '@warden/shared';
import { HttpError } from './errors.js';
import { GitError, LONG_GIT_TIMEOUT_MS, refExists, runGit, runGitWrite } from './git.js';
import { CLONE_MARK, isCloneOf, readRemotes, remoteHeads, type RepoContext } from './repo.js';

// Clone slots: for repositories whose tooling does not cope with linked worktrees — hooks set up
// per `.git` directory, scripts that read `.git` as one — a slot can be a repository of its own
// instead. It is made from the main worktree on this machine, so it costs hard links rather than a
// download, but from then on it talks to the server by itself: branches are not exchanged between
// the main worktree and its clones, each fetches and pushes on its own.

/** A remote name that can be passed on and put in a refspec as it is. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Makes a clone slot at `dir`. `git clone --local` hard-links the main worktree's objects, so even a
 * large repository is there in moments, `--no-checkout` leaves the files to the switch that follows,
 * and `warden.main` in its config names the main worktree it belongs to (see `isCloneOf`). The clone is then made to look like one of the server: the main worktree's remotes, URLs
 * and push URLs as they are, in place of the `origin` that points back at the main worktree, and
 * their remote-tracking branches copied from it, so it knows the server as the main worktree last
 * saw it without fetching anything. A repository with no remote keeps that `origin`: the main
 * worktree is the only server there is.
 */
export async function makeClone(ctx: RepoContext, dir: string): Promise<void> {
  const remotes = [...(await readRemotes(ctx.commonRoot))].filter(([, r]) => r.urls.length);
  const odd = remotes.find(([name]) => !REMOTE_NAME.test(name) || name.includes('..'));
  if (odd) throw new HttpError(409, `remote ${odd[0]} cannot be copied into a clone`, 'unsupported_remote');
  await runGitWrite(
    ['clone', '--quiet', '--local', '--no-checkout', '--origin', 'origin', '--config', `${CLONE_MARK}=${ctx.commonRoot}`, '--', ctx.commonRoot, dir],
    {
      cwd: path.dirname(dir),
      timeoutMs: LONG_GIT_TIMEOUT_MS,
    },
  );
  if (!remotes.length) return;
  // From here on the directory is the clone just made; one that `clone` itself refused — something
  // appeared there since the slot was picked — is left alone.
  try {
    // Removing it takes the main worktree's branches, which `clone` filed under `origin/`, with it.
    await runGitWrite(['remote', 'remove', 'origin'], { cwd: dir });
    for (const [name, r] of remotes) {
      const [first, ...more] = r.urls;
      await runGitWrite(['remote', 'add', '--', name, first!], { cwd: dir });
      for (const url of more) await runGitWrite(['remote', 'set-url', '--add', '--', name, url], { cwd: dir });
      for (const url of r.pushUrls) await runGitWrite(['remote', 'set-url', '--add', '--push', '--', name, url], { cwd: dir });
    }
    const names = remotes.map(([name]) => name);
    await runGitWrite(['fetch', '--quiet', '--no-tags', '--', ctx.commonRoot, ...names.map((n) => `+refs/remotes/${n}/*:refs/remotes/${n}/*`)], {
      cwd: dir,
      timeoutMs: LONG_GIT_TIMEOUT_MS,
    });
    // The fetch copies `<remote>/HEAD` as a plain ref at the commit it pointed to; it is a pointer to a branch.
    for (const [name, branch] of await remoteHeads(ctx.commonRoot)) {
      if (names.includes(name)) await runGitWrite(['remote', 'set-head', '--', name, branch], { cwd: dir });
    }
  } catch (e) {
    await discardClone(dir);
    throw e;
  }
}

/**
 * `git fetch --all` in a clone before a checkout, so that the branch and its base are what the
 * server has now: a slot kept for weeks knows the server only as of its last fetch, and a branch
 * started from that `origin/main` would start weeks back. It reaches the server with whatever
 * credentials the user's git has (see `runGitWrite`'s `network`).
 */
export async function fetchClone(dir: string): Promise<void> {
  try {
    await runGitWrite(['fetch', '--quiet', '--all'], { cwd: dir, network: true });
  } catch (e) {
    if (e instanceof GitError && e.code === 'git_failed') throw new HttpError(502, `git fetch failed in ${dir}: ${e.message}`, 'fetch_failed');
    throw e;
  }
}

/** The branch `git clone` left checked out (in name only, with `--no-checkout`); undefined for a detached HEAD. */
export async function clonedBranch(dir: string): Promise<string | undefined> {
  const r = await runGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd: dir });
  const ref = r.stdout.trim();
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
}

/**
 * Removes a clone made for a checkout that then failed, only ever after `git clone` succeeded in
 * making it. Nothing in it is anyone's yet, and the slot directory was empty or missing before (see
 * `pickSlot`), so the number is free again as it was.
 */
export async function discardClone(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * The branch a released clone held, deleted on request. Only with `-d` and only where its upstream
 * exists: with no upstream, or one that is gone, `git branch -d` checks HEAD instead, and after the
 * release HEAD is the branch's own tip — it would pass for merged and the commits never pushed would
 * go. A clone's branch exists nowhere else, so what cannot be checked is kept.
 */
export async function dropCloneBranch(wt: WorktreeInfo, asked: boolean | undefined): Promise<RemoveWorktreeResponse> {
  const res: RemoveWorktreeResponse = { ok: true, branchDeleted: false };
  if (!asked || !wt.branch) return res;
  const up = (await runGit(['for-each-ref', '--format=%(upstream)', `refs/heads/${wt.branch}`], { cwd: wt.path })).stdout.trim();
  if (!up) res.branchError = 'it has no upstream to tell whether it was pushed';
  else if (!(await refExists(wt.path, up))) res.branchError = `its upstream ${up.replace(/^refs\/(remotes|heads)\//, '')} is gone`;
  else {
    try {
      await runGitWrite(['branch', '-d', wt.branch], { cwd: wt.path });
      res.branchDeleted = true;
    } catch (e) {
      res.branchError = e instanceof Error ? e.message : String(e);
    }
  }
  return res;
}

/**
 * What a clone holds that exists nowhere else, and so goes with its directory: uncommitted changes,
 * commits on no remote-tracking branch — never pushed, as far as its last fetch knows — and a stash.
 * Removing a linked worktree leaves its branches in the repository; removing a clone takes them.
 */
async function wouldLose(dir: string, dirty: number, busy: string | undefined): Promise<string[]> {
  const lost: string[] = [];
  if (busy) lost.push(`a ${busy} in progress`);
  if (dirty) lost.push(`${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}`);
  try {
    const n = Number((await runGit(['rev-list', '--count', 'HEAD', '--branches', '--not', '--remotes'], { cwd: dir })).stdout.trim());
    if (n) lost.push(`${n} ${n === 1 ? 'commit' : 'commits'} on no remote branch`);
  } catch {
    lost.push('commits that could not be checked');
  }
  if (await refExists(dir, 'refs/stash')) lost.push('a stash');
  return lost;
}

/**
 * Deletes a clone slot's directory, dependencies and all — there is no `git worktree remove` for a
 * clone, and this is the one write warden makes outside git. Only a directory listed as one of this
 * repository's clone slots gets here, and it is checked again right before: never one that is not
 * a clone of this repository, forced or not. Anything it alone holds is put to the reviewer first as
 * a 409 — `worktree_dirty` when uncommitted changes are all of it, `needs_force` naming everything
 * otherwise, so that confirming the one question never discards what the other would have asked about.
 */
export async function removeClone(ctx: RepoContext, dir: string, opts: { dirty: number; busy?: string; force?: boolean }): Promise<void> {
  if (!(await isCloneOf(ctx.commonRoot, dir)))
    throw new HttpError(409, `${dir} is not a clone of this repository; warden will not delete it`, 'not_our_checkout');
  if (!opts.force) {
    const lost = await wouldLose(dir, opts.dirty, opts.busy);
    if (lost.length === 1 && opts.dirty) throw new HttpError(409, `${dir} has uncommitted changes`, 'worktree_dirty');
    if (lost.length) throw new HttpError(409, `${dir} has ${lost.join(', ')}, which only it holds`, 'needs_force');
  }
  await rm(dir, { recursive: true });
}
