import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFixtureRepo, type FixtureRepo } from '../../../test/fixtures/make-repo.js';
import { runGit } from './git.js';
import { listWorktreesAll, resolveRepo } from './repo.js';
import { StateStore } from './state.js';
import { checkoutState, checkoutWorktree, listBranches, listWorktreesDetailed, releaseWorktree, removeWorktree } from './worktrees.js';
import { ensureSharedRepository, importSharedCommit, sharedRepositoryOwner, sharedRepositoryPath, validatedSharedRepository } from './shared-repository.js';

describe('external shared task repository', () => {
  let fx: FixtureRepo;
  let data: string;
  beforeEach(async () => {
    fx = await makeFixtureRepo('warden-shared-');
    data = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-shared-data-')));
  });
  afterEach(async () => {
    for (const slot of [1, 2, 3]) await rm(`${fx.root}-${slot}`, { recursive: true, force: true });
    await fx.cleanup();
    await rm(`${fx.root}-warden`, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });

  it('shares task objects and private indexes without importing agent commits into primary', async () => {
    const primaryRefs = fx.git('show-ref');
    const ctx = await resolveRepo(fx.root);
    const first = await checkoutWorktree(ctx, { branch: 'agent/one', base: 'main', kind: 'shared', slot: 1 });
    const second = await checkoutWorktree(ctx, { branch: 'agent/two', base: 'main', kind: 'shared', slot: 2 });
    const repository = sharedRepositoryPath(fx.root);
    for (const checkout of [first, second]) {
      expect(checkout.worktree.shared).toBe(true);
      expect(path.resolve(checkout.worktree.path, fx.git('-C', checkout.worktree.path, 'rev-parse', '--git-common-dir').trim())).toBe(repository);
      expect(await resolveRepo(checkout.worktree.path)).toEqual({ root: checkout.worktree.path, commonRoot: fx.root });
      expect(await checkoutState(ctx, checkout.worktree)).toEqual({ foreign: false });
    }
    const one = first.worktree.path;
    const two = second.worktree.path;
    expect(fx.git('-C', one, 'rev-parse', '--git-path', 'index')).not.toBe(fx.git('-C', two, 'rev-parse', '--git-path', 'index'));
    await writeFile(path.join(one, 'agent.txt'), 'agent-only content\n');
    fx.git('-C', one, 'add', 'agent.txt');
    fx.git('-C', one, 'commit', '-qm', 'Agent draft');
    const source = fx.git('-C', one, 'rev-parse', 'HEAD').trim();
    expect(fx.git('-C', two, 'show', `${source}:agent.txt`)).toBe('agent-only content\n');
    expect(fx.git('-C', two, 'status', '--porcelain')).toBe('');
    expect((await runGit(['rev-parse', '--verify', `${source}^{commit}`], { cwd: fx.root, okCodes: [0, 128] })).code).toBe(128);
    expect(fx.git('show-ref')).toBe(primaryRefs);
    expect(fx.git('status', '--porcelain')).toBe('');
    expect((await listWorktreesDetailed(ctx)).find((row) => row.path === one)?.comparison).toMatchObject({ kind: 'base', ahead: 1, behind: 0 });
    expect(await listBranches(ctx, await listWorktreesAll(ctx))).toEqual([expect.objectContaining({ name: 'main', worktree: fx.root })]);
  });

  it('keeps internal worktrees out of the task list and preserves both legacy checkout kinds', async () => {
    const ctx = await resolveRepo(fx.root);
    await checkoutWorktree(ctx, { branch: 'legacy/linked', slot: 1, kind: 'worktree' });
    await checkoutWorktree(ctx, { branch: 'legacy/clone', slot: 2, kind: 'clone' });
    await checkoutWorktree(ctx, { branch: 'agent/shared', slot: 3, kind: 'shared' });
    const repository = sharedRepositoryPath(fx.root);
    const preview = path.join(path.dirname(repository), 'preview');
    fx.git('-C', repository, 'worktree', 'add', '-q', '--detach', preview, 'agent/shared');
    expect(await sharedRepositoryOwner(preview)).toBe(fx.root);
    const rows = await listWorktreesDetailed(ctx);
    expect(rows.map((row) => row.path)).toEqual([fx.root, `${fx.root}-1`, `${fx.root}-2`, `${fx.root}-3`]);
    expect(rows.find((row) => row.slot === 1)).not.toHaveProperty('shared');
    expect(rows.find((row) => row.slot === 2)).toMatchObject({ clone: true });
    expect(rows.find((row) => row.slot === 3)).toMatchObject({ shared: true });
    expect(rows.every((row) => !row.foreign)).toBe(true);
  });

  it('releases, reuses and removes shared slots in their owning repository', async () => {
    const ctx = await resolveRepo(fx.root);
    const store = new StateStore(path.join(data, 'state.json'), fx.root);
    const created = await checkoutWorktree(ctx, { branch: 'agent/one', slot: 1, kind: 'shared' });
    const released = await releaseWorktree(ctx, { path: created.worktree.path, deleteBranch: true }, store);
    expect(released.backup?.head).toBe(created.worktree.head);
    expect(released.branchDeleted).toBe(true);
    expect((await listWorktreesDetailed(ctx)).find((row) => row.slot === 1)).toMatchObject({ free: true, shared: true });
    const reused = await checkoutWorktree(ctx, { branch: 'agent/two', slot: 1, kind: 'shared', base: 'main' });
    expect(reused.reused).toBe(true);
    expect(reused.worktree.shared).toBe(true);
    await writeFile(path.join(reused.worktree.path, 'retained.txt'), 'not accepted\n');
    fx.git('-C', reused.worktree.path, 'add', 'retained.txt');
    fx.git('-C', reused.worktree.path, 'commit', '-qm', 'Unaccepted source');
    const source = fx.git('-C', reused.worktree.path, 'rev-parse', 'HEAD').trim();
    const removed = await removeWorktree(ctx, { path: reused.worktree.path, deleteBranch: true }, store);
    expect(removed.backup?.head).toBe(source);
    expect(removed.branchDeleted).toBe(false);
    expect(removed.branchError).toContain('已保留');
    expect(fx.git('-C', sharedRepositoryPath(fx.root), 'rev-parse', 'agent/two').trim()).toBe(source);
    expect(await listWorktreesAll(ctx)).toEqual([expect.objectContaining({ path: fx.root, isMain: true })]);
    expect(fx.git('branch', '--list', 'agent/*')).toBe('');
  });

  it('imports exact primary revisions once and leaves primary refs and worktree untouched', async () => {
    const head = fx.git('rev-parse', 'HEAD').trim();
    expect(await validatedSharedRepository(fx.root)).toBeUndefined();
    const repositories = await Promise.all(Array.from({ length: 4 }, () => ensureSharedRepository(fx.root)));
    expect(new Set(repositories).size).toBe(1);
    const repository = await importSharedCommit(fx.root, fx.root, head);
    expect(await importSharedCommit(fx.root, fx.root, head)).toBe(repository);
    expect(fx.git('-C', repository, 'rev-parse', `${head}^{commit}`).trim()).toBe(head);
    expect(await lstat(path.join(repository, 'FETCH_HEAD')).catch(() => undefined)).toBeUndefined();
    expect(fx.git('-C', repository, 'config', '--get', 'user.name').trim()).toBe('Fixture');
    expect((await runGit(['config', '--get', 'core.hooksPath'], { cwd: repository, okCodes: [0, 1] })).code).toBe(1);
    await expect(importSharedCommit(fx.root, fx.root, 'main')).rejects.toMatchObject({ code: 'invalid_commit' });
    expect(fx.git('status', '--porcelain')).toBe('');
  });

  it('retains a branch held by a shared worktree outside the numbered task inventory', async () => {
    const ctx = await resolveRepo(fx.root);
    const created = await checkoutWorktree(ctx, { branch: 'agent/one', slot: 1, kind: 'shared' });
    const repository = sharedRepositoryPath(fx.root);
    const manual = path.join(data, 'manual');
    fx.git('-C', repository, 'worktree', 'add', '-q', '--force', manual, 'agent/one');
    const store = new StateStore(path.join(data, 'state.json'), fx.root);
    const result = await releaseWorktree(ctx, { path: created.worktree.path, deleteBranch: true }, store);
    expect(result.branchDeleted).toBe(false);
    expect(result.branchError).toContain('仍在工作区中使用');
    expect(fx.git('-C', manual, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('agent/one');
    expect(fx.git('-C', manual, 'status', '--porcelain')).toBe('');
  });

  it('serializes initialization from independent server processes', async () => {
    const module = new URL('./shared-repository.ts', import.meta.url).href;
    const source = `import { ensureSharedRepository } from ${JSON.stringify(module)}; console.log(await ensureSharedRepository(${JSON.stringify(fx.root)}));`;
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source])));
    expect(results.map((result) => result.stdout.trim())).toEqual(Array(3).fill(sharedRepositoryPath(fx.root)));
    expect(await validatedSharedRepository(fx.root)).toBe(sharedRepositoryPath(fx.root));
    expect(await lstat(path.join(`${fx.root}-warden`, 'initialization.repository.lock', 'v2', 'active')).catch(() => undefined)).toBeUndefined();
  });

  it('refuses foreign repositories and symlinked storage without modifying them', async () => {
    const repository = sharedRepositoryPath(fx.root);
    await mkdir(path.dirname(repository));
    fx.git('init', '-q', '--bare', repository);
    await expect(ensureSharedRepository(fx.root)).rejects.toMatchObject({ code: 'shared_repository_invalid' });
    expect(fx.git('-C', repository, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    await rm(path.dirname(repository), { recursive: true });
    await symlink(data, path.dirname(repository), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ensureSharedRepository(fx.root)).rejects.toMatchObject({ code: 'shared_repository_invalid' });
    expect(await lstat(path.join(data, 'repo.git')).catch(() => undefined)).toBeUndefined();
  });

  it('marks a replaced shared task checkout as foreign before it can be mutated', async () => {
    const ctx = await resolveRepo(fx.root);
    const created = await checkoutWorktree(ctx, { branch: 'agent/one', slot: 1, kind: 'shared' });
    await rm(created.worktree.path, { recursive: true });
    fx.git('clone', '-q', fx.root, created.worktree.path);
    expect(await checkoutState(ctx, created.worktree)).toEqual({ foreign: true });
    const store = new StateStore(path.join(data, 'state.json'), fx.root);
    await expect(releaseWorktree(ctx, { path: created.worktree.path, force: true }, store)).rejects.toMatchObject({ code: 'not_our_checkout' });
    expect(fx.git('-C', created.worktree.path, 'status', '--porcelain')).toBe('');
  });

  it('rejects a task whose .git pointer was redirected to another shared task', async () => {
    const ctx = await resolveRepo(fx.root);
    const first = await checkoutWorktree(ctx, { branch: 'agent/one', slot: 1, kind: 'shared' });
    const second = await checkoutWorktree(ctx, { branch: 'agent/two', slot: 2, kind: 'shared' });
    const source = path.join(second.worktree.path, '.git');
    const indexPath = fx.git('-C', second.worktree.path, 'rev-parse', '--git-path', 'index').trim();
    const index = await readFile(indexPath);
    await copyFile(source, path.join(first.worktree.path, '.git'));
    expect(await checkoutState(ctx, first.worktree)).toEqual({ foreign: true });
    await expect(resolveRepo(first.worktree.path)).rejects.toMatchObject({ code: 'shared_repository_invalid' });
    const store = new StateStore(path.join(data, 'state.json'), fx.root);
    await expect(releaseWorktree(ctx, { path: first.worktree.path, force: true }, store)).rejects.toMatchObject({ code: 'not_our_checkout' });
    await expect(removeWorktree(ctx, { path: first.worktree.path, force: true }, store)).rejects.toMatchObject({ code: 'not_our_checkout' });
    expect(fx.git('-C', second.worktree.path, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('agent/two');
    expect(await readFile(indexPath)).toEqual(index);
    expect(fx.git('-C', second.worktree.path, 'status', '--porcelain')).toBe('');
  });
});
