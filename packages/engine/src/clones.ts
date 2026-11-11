import path from 'node:path';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { RemoveWorktreeResponse, SafetyBackup, WorktreeInfo } from '@warden/shared';
import { assertSafetyBackupCurrent, createSafetyBackup } from './backups.js';
import type { StateStore } from './state.js';
import { WardenError } from './errors.js';
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
  if (odd) throw new WardenError(409, `remote ${odd[0]} cannot be copied into a clone`, 'unsupported_remote');
  await runGitWrite(
    ['clone', '--quiet', '--local', '--no-checkout', '--origin', 'origin', '--config', `${CLONE_MARK}=${ctx.commonRoot}`, '--', ctx.commonRoot, dir],
    {
      cwd: path.dirname(dir),
      timeoutMs: LONG_GIT_TIMEOUT_MS,
    },
  );
  // From here on the directory is the clone just made; one that `clone` itself refused — something
  // appeared there since the slot was picked — is left alone.
  try {
    await copyLocalSetup(ctx.commonRoot, dir);
    if (!remotes.length) return;
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
 * Repository settings a linked worktree would share with the main worktree and a clone copies
 * when it is made: commit identity and signing, line endings, the hooks location, and the filter,
 * merge and diff drivers that attributes name. Remotes, credentials and URL rewrites are Warden's
 * or the server's business, and paths such as `commit.template` would mean something else here.
 */
const COPIED_CONFIG =
  '^(user\\.(name|email|signingkey)|(commit|tag)\\.gpgsign|gpg\\..+|core\\.(autocrlf|eol|safecrlf|hookspath)|(filter|merge|diff)\\..+\\..+)$';

/** Every value per key of the copied settings `cwd` sees, in Git's order. */
async function copiedConfig(cwd: string): Promise<Map<string, string[]>> {
  const r = await runGit(['config', '--null', '--get-regexp', COPIED_CONFIG], { cwd, okCodes: [0, 1] });
  const values = new Map<string, string[]>();
  for (const entry of r.stdout.split('\0')) {
    if (!entry) continue;
    const split = entry.indexOf('\n');
    // A key written without `=` is a boolean true.
    const [key, value] = split < 0 ? [entry, 'true'] : [entry.slice(0, split), entry.slice(split + 1)];
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}

/**
 * Gives a new clone the local setup a linked worktree would have shared with the main worktree.
 * Settings are compared as each repository resolves them, so global defaults stay unpinned while
 * local values and path-conditional includes that match only the main worktree are written. Hooks
 * in the default directory, local excludes and local attributes are copied as they are now; a
 * `core.hooksPath` is copied as a setting, so a tracked or external hooks directory stays live.
 */
async function copyLocalSetup(main: string, dir: string): Promise<void> {
  const [source, cloned] = await Promise.all([copiedConfig(main), copiedConfig(dir)]);
  for (const [key, values] of source) {
    if (cloned.get(key)?.join('\0') === values.join('\0')) continue;
    await runGitWrite(['config', '--replace-all', key, values[0]!], { cwd: dir });
    for (const value of values.slice(1)) await runGitWrite(['config', '--add', key, value], { cwd: dir });
  }
  const common = path.resolve(main, (await runGit(['rev-parse', '--git-common-dir'], { cwd: main })).stdout.trim());
  const target = path.join(dir, '.git');
  const files = ['exclude', 'attributes'].map((name) => [path.join(common, 'info', name), path.join(target, 'info', name)] as const);
  if (!source.has('core.hookspath')) {
    const hooks = await readdir(path.join(common, 'hooks')).catch(() => []);
    for (const name of hooks) if (!name.endsWith('.sample')) files.push([path.join(common, 'hooks', name), path.join(target, 'hooks', name)]);
  }
  for (const [from, to] of files) {
    await mkdir(path.dirname(to), { recursive: true });
    // Hook managers may install symlinks or helper directories; the clone gets their content. A
    // file the main worktree does not have, or a dangling link, is simply not copied.
    await cp(from, to, { recursive: true, dereference: true, force: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

/** Settings that decide which files Git sees and how their bytes are stored. */
const RUNTIME_CONFIG = /^(core\.(autocrlf|eol|safecrlf)|(filter|merge|diff)\..+\..+)$/;
const mirrored = new Map<string, { common: string; signature?: string }>();

/**
 * Keeps the bare shared repository's view of files aligned with primary. Preview and composition
 * worktrees read `info/exclude`, `info/attributes` and drivers from it, so a file ignored only
 * locally in primary must not count as an unexpected preview edit. Primary can change these at
 * any time; unchanged files are detected by stat and cost no Git process. Hooks, identity and
 * signing stay out: internal composition disables them per command.
 */
export async function mirrorLocalSetup(main: string, repository: string): Promise<void> {
  let known = mirrored.get(repository);
  if (!known) {
    known = { common: path.resolve(main, (await runGit(['rev-parse', '--git-common-dir'], { cwd: main })).stdout.trim()) };
    mirrored.set(repository, known);
  }
  const sources = ['config', path.join('info', 'exclude'), path.join('info', 'attributes')].map((name) => path.join(known.common, name));
  const stats = await Promise.all(
    sources.map((file) =>
      stat(file).then(
        (info) => `${info.mtimeMs}:${info.size}`,
        () => 'missing',
      ),
    ),
  );
  const signature = stats.join('|');
  if (known.signature === signature) return;
  const [source, shared] = await Promise.all([copiedConfig(main), copiedConfig(repository)]);
  for (const [key, values] of source) {
    if (!RUNTIME_CONFIG.test(key) || shared.get(key)?.join('\0') === values.join('\0')) continue;
    await runGitWrite(['config', '--replace-all', key, values[0]!], { cwd: repository });
    for (const value of values.slice(1)) await runGitWrite(['config', '--add', key, value], { cwd: repository });
  }
  // A value primary no longer resolves can only be an earlier mirrored copy.
  for (const key of shared.keys()) if (RUNTIME_CONFIG.test(key) && !source.has(key)) await runGitWrite(['config', '--unset-all', key], { cwd: repository });
  for (const name of ['exclude', 'attributes']) {
    const to = path.join(repository, 'info', name);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(path.join(known.common, 'info', name), to, { dereference: true, force: true }).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      await rm(to, { force: true });
    });
  }
  known.signature = signature;
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
    if (e instanceof GitError && e.code === 'git_failed') throw new WardenError(502, `git fetch failed in ${dir}: ${e.message}`, 'fetch_failed');
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
 * clone, and besides the local setup copied into a new clone (see `copyLocalSetup`), this is the one
 * write warden makes outside git. Only a directory listed as one of this
 * repository's clone slots gets here, and it is checked again right before: never one that is not
 * a clone of this repository, forced or not. Anything it alone holds is put to the reviewer first as
 * a 409 — `worktree_dirty` when uncommitted changes are all of it, `needs_force` naming everything
 * otherwise, so that confirming the one question never discards what the other would have asked about.
 */
export async function removeClone(
  ctx: RepoContext,
  dir: string,
  opts: { dirty: number; busy?: string; force?: boolean },
  store: StateStore,
): Promise<SafetyBackup> {
  if (!(await isCloneOf(ctx.commonRoot, dir)))
    throw new WardenError(409, `${dir} is not a clone of this repository; warden will not delete it`, 'not_our_checkout');
  if (!opts.force) {
    const lost = await wouldLose(dir, opts.dirty, opts.busy);
    if (lost.length === 1 && opts.dirty) throw new WardenError(409, `${dir} has uncommitted changes`, 'worktree_dirty');
    if (lost.length) throw new WardenError(409, `${dir} has ${lost.join(', ')}, which only it holds`, 'needs_force');
  }
  const backup = await createSafetyBackup(store, dir, 'remove');
  if (!(await isCloneOf(ctx.commonRoot, dir)))
    throw new WardenError(409, 'The workspace identity changed after backup. Refresh and retry.', 'not_our_checkout');
  await assertSafetyBackupCurrent(backup);
  await rm(dir, { recursive: true });
  return backup;
}
