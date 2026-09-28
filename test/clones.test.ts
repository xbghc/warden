import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Comment, CreateWorktreeResponse, FilesResponse, ReleaseWorktreeResponse, RepoInfo, WorktreeDetail, WorktreesResponse } from '@warden/shared';
import { createApp, NvimService, resolveRepo, StateStore, takeFeedback } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

// Clone slots: a repository of its own beside the main worktree, made from it on this machine and
// talking to the server by itself afterwards. A bare repository stands in for the server, so the
// fetches here never leave the machine.

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;
let server: string;
let store: StateStore;

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const fails = (cwd: string, ...args: string[]) => {
  try {
    execFileSync('git', args, { cwd, env, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
};
const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
const k = (key: string) => encodeURIComponent(key);
const slotDir = (n: number) => path.join(path.dirname(fx.root), `${path.basename(fx.root)}-${n}`);
const list = async () => json<WorktreesResponse>(await app.request('/api/worktrees'));
const slot = async (n: number): Promise<WorktreeDetail | undefined> => (await list()).worktrees.find((w) => w.slot === n);
const checkout = async (body: Record<string, unknown>): Promise<CreateWorktreeResponse> => {
  const res = await send('POST', '/api/worktrees', body);
  if (res.status !== 201) throw new Error(`checkout failed (${res.status}): ${await res.text()}`);
  return json<CreateWorktreeResponse>(res);
};
const release = (body: Record<string, unknown>) => send('POST', '/api/worktrees/release', body);
const remove = (body: Record<string, unknown>) => send('POST', '/api/worktrees/remove', body);
const branches = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
/** A commit on the server's `main` that the main worktree has not fetched. */
const pushElsewhere = (message: string) => {
  const sha = git(server, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', message);
  git(server, 'update-ref', 'refs/heads/main', sha);
  return sha;
};

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-clone-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-clone-data-'));
  server = path.join(dataDir, 'server.git');
  git(fx.root, 'clone', '-q', '--bare', fx.root, server);
  git(server, 'branch', 'agent/remote', 'main~1');
  git(fx.root, 'remote', 'add', 'origin', server);
  git(fx.root, 'config', 'remote.origin.pushurl', server);
  git(fx.root, 'fetch', '-q', 'origin');
  git(fx.root, 'remote', 'set-head', 'origin', 'main');
  git(fx.root, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  // Work the main worktree has and the server does not: a clone must not pick it up.
  git(fx.root, 'switch', '-q', '-c', 'local-only');
  await fx.write('local.txt', 'mine\n');
  git(fx.root, 'add', 'local.txt');
  git(fx.root, 'commit', '-q', '-m', 'local only');
  git(fx.root, 'switch', '-q', 'main');
  const repo = await resolveRepo(fx.root);
  store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  app = createApp({ repo, store, nvim: new NvimService([path.join(dataDir, 'none')]) });
});

afterEach(async () => {
  for (const n of [1, 2, 3]) await rm(slotDir(n), { recursive: true, force: true });
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('a clone slot', () => {
  it('is a clone of the server, as the main worktree knows it, holding only the branch checked out', async () => {
    const made = await checkout({ branch: 'agent/one', kind: 'clone' });
    const dir = await realpath(slotDir(1));
    expect(made).toMatchObject({ slot: 1, reused: false, worktree: { path: dir, branch: 'agent/one', clone: true, isMain: false } });
    expect(git(dir, 'rev-parse', '--git-dir')).toBe('.git');
    expect(git(dir, 'config', 'warden.main')).toBe(await realpath(fx.root));
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(server);
    expect(git(dir, 'config', '--get-all', 'remote.origin.pushurl')).toBe(server);
    expect(git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
    expect(git(dir, 'rev-parse', 'origin/agent/remote')).toBe(git(fx.root, 'rev-parse', 'origin/agent/remote'));
    // The main worktree's own branches stay there: not as `origin/*`, not as local branches.
    expect(branches(dir)).toEqual(['agent/one']);
    expect(fails(dir, 'rev-parse', '--verify', 'refs/remotes/origin/local-only')).toBe(true);
    // A new branch starts from the remote's default branch, not the main worktree's `main`.
    expect(made.worktree.head).toBe(git(fx.root, 'rev-parse', 'origin/main'));
    expect(git(dir, 'status', '--porcelain')).toBe('');

    const res = await list();
    expect(res.slotKind).toBe('clone');
    expect(res.trunk).toBe('origin/main');
    expect(res.worktrees.find((w) => w.slot === 1)).toMatchObject({
      clone: true,
      free: false,
      dirty: 0,
      trunk: 'origin/main',
      comparison: { base: 'origin/main', ahead: 0, behind: 0 },
    });
    expect((await json<RepoInfo>(await app.request('/api/repo'))).worktrees.map((w) => [w.branch, !!w.clone])).toContainEqual(['agent/one', true]);

    // Reviewed like any other checkout: its keys carry its path, and git runs in it.
    await writeFile(path.join(dir, 'src/b.ts'), 'export const b = 3;\n');
    const files = await json<FilesResponse>(await app.request(`/api/targets/${k(`worktree:${dir}:working`)}/files`));
    expect(files.files.map((f) => f.path)).toEqual(['src/b.ts']);
    expect(files.root).toBe(dir);
    // What the page offers a clone to compare with: its remote default branch, which it has.
    expect((await json<RepoInfo>(await app.request('/api/repo'))).worktrees.find((w) => w.path === dir)?.trunk).toBe('origin/main');
    expect((await app.request(`/api/targets/${k(`worktree:${dir}:base:origin/main`)}/files`)).status).toBe(200);
  });

  it('reads the branch in the clone, and a fetch first reads it as the server has it now', async () => {
    const one = await checkout({ branch: 'agent/one', kind: 'clone' });
    expect((await json<ReleaseWorktreeResponse>(await release({ path: one.worktree.path }))).ok).toBe(true);
    expect(await slot(1)).toMatchObject({ free: true, clone: true, branches: [{ name: 'agent/one' }] });

    const before = git(fx.root, 'rev-parse', 'origin/main');
    const now = pushElsewhere('landed on the server');
    // Without a fetch the clone knows the server as of when it was made.
    const two = await checkout({ branch: 'agent/two', slot: 1 });
    expect(two).toMatchObject({ slot: 1, reused: true, worktree: { branch: 'agent/two', head: before, clone: true } });
    await release({ path: two.worktree.path });
    const three = await checkout({ branch: 'agent/three', slot: 1, fetch: true });
    expect(three.worktree.head).toBe(now);
    // The main worktree was not touched: it has not fetched.
    expect(git(fx.root, 'rev-parse', 'origin/main')).toBe(before);
    await release({ path: three.worktree.path });

    // A branch only the server has is checked out tracking it; one the clone has, as it is.
    const remote = await checkout({ branch: 'agent/remote', slot: 1 });
    expect(remote.worktree.head).toBe(git(server, 'rev-parse', 'agent/remote'));
    expect(git(remote.worktree.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/agent/remote');
    await release({ path: remote.worktree.path });
    expect((await checkout({ branch: 'agent/one', slot: 1 })).worktree.head).toBe(before);

    // Looked up in the clone, where the checkout reads it.
    const lookup = async (branch: string, n?: number) =>
      (await json<{ remotes: string[] }>(await app.request(`/api/worktrees/remotes?branch=${k(branch)}${n ? `&slot=${n}` : ''}`))).remotes;
    git(one.worktree.path, 'update-ref', 'refs/remotes/origin/only-in-clone', 'HEAD');
    expect(await lookup('only-in-clone', 1)).toEqual(['origin/only-in-clone']);
    expect(await lookup('only-in-clone')).toEqual([]);
  });

  it('gives up the checkout when the fetch fails, and leaves the slot as it was', async () => {
    const one = await checkout({ branch: 'agent/one', kind: 'clone' });
    await release({ path: one.worktree.path });
    git(one.worktree.path, 'remote', 'set-url', 'origin', path.join(dataDir, 'no-such-server.git'));
    // Still this repository's slot with its remote moved: warden named the main worktree in its config.
    expect(await slot(1)).toMatchObject({ free: true, clone: true });
    const res = await send('POST', '/api/worktrees', { branch: 'agent/two', slot: 1, fetch: true });
    expect(res.status).toBe(502);
    expect(await code(res)).toBe('fetch_failed');
    expect(await slot(1)).toMatchObject({ free: true });
    expect(branches(one.worktree.path)).toEqual(['agent/one']);
  });

  it('refuses a name another checkout has on, in either direction', async () => {
    expect(await code(await send('POST', '/api/worktrees', { branch: 'main', kind: 'clone' }))).toBe('branch_in_use');
    // Nothing was cloned for the refusal.
    expect(existsSync(slotDir(1))).toBe(false);
    await checkout({ branch: 'agent/one', kind: 'clone' });
    expect(await code(await send('POST', '/api/worktrees', { branch: 'agent/one', kind: 'worktree' }))).toBe('branch_in_use');
    expect(await code(await send('POST', '/api/worktrees', { branch: 'agent/one', kind: 'clone' }))).toBe('branch_in_use');
    // A bad base is found in the clone made for it, which then goes again.
    expect(await code(await send('POST', '/api/worktrees', { branch: 'agent/two', kind: 'clone', base: 'nope' }))).toBe('unknown_ref');
    expect(existsSync(slotDir(2))).toBe(false);
  });

  it('deletes a released branch only when its upstream has all of it', async () => {
    // Started from a sha: no upstream to say whether it was ever pushed.
    const loose = await checkout({ branch: 'agent/loose', kind: 'clone', base: git(fx.root, 'rev-parse', 'origin/main') });
    const dir = loose.worktree.path;
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'never pushed');
    const kept = await json<ReleaseWorktreeResponse>(await release({ path: dir, deleteBranch: true }));
    expect(kept).toMatchObject({ ok: true, branchDeleted: false });
    expect(kept.branchError).toMatch(/no upstream/);
    expect(branches(dir)).toContain('agent/loose');

    const pushed = await checkout({ branch: 'agent/remote', slot: 1 });
    expect(await json<ReleaseWorktreeResponse>(await release({ path: pushed.worktree.path, deleteBranch: true }))).toEqual({ ok: true, branchDeleted: true });

    const ahead = await checkout({ branch: 'agent/remote', slot: 1 });
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'not pushed yet');
    const unpushed = await json<ReleaseWorktreeResponse>(await release({ path: ahead.worktree.path, deleteBranch: true }));
    expect(unpushed.branchDeleted).toBe(false);
    expect(branches(dir)).toContain('agent/remote');

    // Its upstream gone from the server and pruned: `-d` would check the detached HEAD, the branch itself.
    await checkout({ branch: 'agent/remote', slot: 1 });
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/agent/remote');
    const gone = await json<ReleaseWorktreeResponse>(await release({ path: dir, deleteBranch: true }));
    expect(gone.branchError).toMatch(/upstream origin\/agent\/remote is gone/);
    expect(branches(dir)).toContain('agent/remote');
  });

  it('is deleted only after what it alone holds was put to the reviewer', async () => {
    const made = await checkout({ branch: 'agent/one', kind: 'clone', base: git(fx.root, 'rev-parse', 'origin/main') });
    const dir = made.worktree.path;
    await writeFile(path.join(dir, 'scratch.txt'), 'x\n');
    expect(await code(await remove({ path: dir }))).toBe('worktree_dirty');
    git(dir, 'add', 'scratch.txt');
    git(dir, 'commit', '-q', '-m', 'only here');
    const unpushed = await remove({ path: dir });
    expect(unpushed.status).toBe(409);
    expect(await json<{ code: string; error: string }>(unpushed)).toMatchObject({
      code: 'needs_force',
      error: expect.stringMatching(/1 commit on no remote branch/),
    });
    // Uncommitted changes and a commit: confirming the one must not pass over the other.
    await writeFile(path.join(dir, 'more.txt'), 'y\n');
    expect(await code(await remove({ path: dir }))).toBe('needs_force');
    expect(existsSync(dir)).toBe(true);
    expect(await json(await remove({ path: dir, force: true }))).toEqual({ ok: true, branchDeleted: false });
    expect(existsSync(dir)).toBe(false);
    expect((await list()).worktrees.map((w) => w.path)).not.toContain(dir);

    // A free clone with nothing of its own goes at once.
    const clean = await checkout({ branch: 'agent/remote', kind: 'clone' });
    await release({ path: clean.worktree.path });
    expect((await remove({ path: clean.worktree.path })).status).toBe(200);
    expect(existsSync(clean.worktree.path)).toBe(false);
  });

  it('takes a clone made by hand from the same server for a slot', async () => {
    git(path.dirname(slotDir(1)), 'clone', '-q', server, slotDir(1));
    git(slotDir(1), 'switch', '-q', '--detach');
    expect(await slot(1)).toMatchObject({ clone: true, free: true, trunk: 'origin/main' });
    expect((await checkout({ branch: 'agent/one' })).worktree).toMatchObject({ path: await realpath(slotDir(1)), clone: true });
  });

  it('leaves a repository that is not a clone of this one out, and never writes in it', async () => {
    const other = slotDir(1);
    git(path.dirname(other), 'init', '-q', other);
    git(other, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    git(other, 'remote', 'add', 'origin', 'https://example.invalid/other.git');
    expect((await list()).worktrees.map((w) => w.path)).not.toContain(await realpath(other));
    expect(await code(await send('POST', '/api/worktrees', { branch: 'agent/one', slot: 1, kind: 'clone' }))).toBe('path_exists');
    expect(await code(await remove({ path: other, force: true }))).toBe('unknown_worktree');
    expect(existsSync(path.join(other, '.git'))).toBe(true);
    // Its number is taken; the next slot goes after it.
    expect((await checkout({ branch: 'agent/one', kind: 'clone' })).slot).toBe(2);
  });

  it('shares the main worktree’s review state with a server or an agent started inside it', async () => {
    const made = await checkout({ branch: 'agent/one', kind: 'clone' });
    const dir = made.worktree.path;
    const inClone = await resolveRepo(dir);
    expect(inClone).toEqual({ root: dir, commonRoot: await realpath(fx.root) });
    const there = createApp({ repo: inClone, store: new StateStore(path.join(dataDir, 'state.json'), inClone.commonRoot), nvim: new NvimService([]) });
    expect((await json<RepoInfo>(await there.request('/api/repo'))).defaultTarget).toBe(`worktree:${dir}:working`);

    await writeFile(path.join(dir, 'src/b.ts'), 'export const b = 3;\n');
    const comment = await json<Comment>(
      await send('POST', `/api/targets/${k(`worktree:${dir}:working`)}/comments`, {
        filePath: 'src/b.ts',
        side: 'new',
        startLine: 1,
        endLine: 1,
        body: 'why 3?',
      }),
    );
    // What `warden feedback` in the clone reads.
    const taken = await takeFeedback(store, { worktreeRoot: inClone.root, mainRoot: inClone.commonRoot, peek: true });
    expect(taken.map((c) => c.id)).toEqual([comment.id]);
  });

  it('points back at the main worktree when there is no server to copy', async () => {
    git(fx.root, 'remote', 'remove', 'origin');
    const made = await checkout({ branch: 'agent/one', kind: 'clone' });
    const dir = made.worktree.path;
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(await realpath(fx.root));
    // The main worktree is the server here: its branches are the clone's `origin/*`.
    expect(made.worktree.head).toBe(git(fx.root, 'rev-parse', 'main'));
    expect(await slot(1)).toMatchObject({ clone: true, trunk: 'origin/main' });
    expect((await resolveRepo(dir)).commonRoot).toBe(await realpath(fx.root));
  });
});
