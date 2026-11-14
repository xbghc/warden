import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskReview } from '@warden/shared';
import { makeFixtureRepo, type FixtureRepo } from '../../../test/fixtures/make-repo.js';
import { Engine } from './engine.js';
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
    expect((await listWorktreesDetailed(ctx)).find((row) => row.path === one)).toMatchObject({ shared: true, head: source, dirty: 0, free: false });
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
    expect(removed.branchError).toContain('has been preserved');
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

  it.each([false, true])('preserves shallow history when importing a commit (previous import: %s)', async (previousImport) => {
    const primary = path.join(data, 'shallow');
    fx.git('clone', '--quiet', '--depth=1', '--no-local', '--', fx.root, primary);
    const head = fx.git('-C', primary, 'rev-parse', 'HEAD').trim();
    const boundary = await readFile(path.join(primary, '.git', 'shallow'), 'utf8');
    const refs = fx.git('-C', primary, 'show-ref');
    const repository = await ensureSharedRepository(primary);
    if (previousImport) {
      // Older imports transferred the object but silently rejected its shallow boundary.
      fx.git('-C', repository, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', primary, head);
      expect(fx.git('-C', repository, 'rev-parse', `${head}^{commit}`).trim()).toBe(head);
      fx.git('-C', repository, 'update-ref', 'refs/heads/retained-task', head);
    }
    await importSharedCommit(primary, primary, head);
    expect(fx.git('-C', repository, 'rev-list', '--count', head).trim()).toBe('1');
    expect(await readFile(path.join(repository, 'shallow'), 'utf8')).toBe(boundary);
    expect(await importSharedCommit(primary, primary, head)).toBe(repository);
    if (previousImport) expect(fx.git('-C', repository, 'rev-parse', 'retained-task').trim()).toBe(head);
    expect(await readFile(path.join(primary, '.git', 'shallow'), 'utf8')).toBe(boundary);
    expect(fx.git('-C', primary, 'show-ref')).toBe(refs);
    expect(fx.git('-C', primary, 'status', '--porcelain')).toBe('');
    expect(await lstat(path.join(repository, 'FETCH_HEAD')).catch(() => undefined)).toBeUndefined();
  });

  // Two complete deliveries and a rebase need more than one operation's timeout on busy CI hosts.
  it('previews, reviews, delivers twice and rebases a task allocated from a shallow primary', { timeout: 90_000 }, async () => {
    const primary = path.join(data, 'shallow');
    fx.git('clone', '--quiet', '--depth=1', '--no-local', '--', fx.root, primary);
    fx.git('-C', primary, 'config', 'user.name', 'Fixture');
    fx.git('-C', primary, 'config', 'user.email', 'fixture@example.com');
    const engine = await Engine.open(primary, path.join(data, 'state.json'));
    try {
      await engine.execute('workflow.configure', { branch: 'main' });
      const task = await engine.execute('task.create', { title: 'Shallow task' });
      expect(task.worktree).toBeTruthy();
      const workspace = task.worktree!;
      const originalHead = fx.git('-C', primary, 'rev-parse', 'HEAD').trim();
      for (const file of ['first.txt', 'second.txt']) {
        await writeFile(path.join(workspace, file), `${file}\n`);
        fx.git('-C', workspace, 'add', file);
        fx.git('-C', workspace, 'commit', '-qm', `Add ${file}`);
        const sourceHead = fx.git('-C', workspace, 'rev-parse', 'HEAD').trim();
        const preview = await engine.execute('preview.connect', { connectedIds: [task.id] });
        expect(preview.syncStatus).toBe('synced');
        expect(await readFile(path.join(preview.worktree!, file), 'utf8')).toBe(`${file}\n`);
        const data = await engine.execute('repository.get', undefined);
        const review = taskReview(data.workflow, task.id, data.workspaces.worktrees)!;
        expect(review.sourceHead).toBe(sourceHead);
        expect((await engine.execute('review.files', { key: review.targetKey })).files.map((entry) => entry.path)).toEqual([file]);
        await engine.execute('task.deliver', {
          taskId: task.id,
          sourceHead,
          sourceBase: review.sourceBase,
          developmentHead: review.developmentHead!,
          message: `Deliver ${file}`,
        });
        expect(fx.git('-C', primary, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(file);
        expect(fx.git('-C', primary, 'status', '--porcelain')).toBe('');
        expect((await runGit(['rev-parse', '--verify', `${sourceHead}^{commit}`], { cwd: primary, okCodes: [0, 128] })).code).toBe(128);
      }
      expect(fx.git('-C', primary, 'rev-list', '--count', `${originalHead}..HEAD`).trim()).toBe('2');
      const checks = await engine.execute('rebase.check', undefined);
      expect(checks.checks[0]?.status).toBe('ready');
      const result = await engine.execute('rebase.run', { items: checks.checks });
      expect(result.results).toEqual([{ changeId: task.id, status: 'updated' }]);
      expect(fx.git('-C', workspace, 'rev-parse', 'HEAD')).toBe(fx.git('-C', primary, 'rev-parse', 'HEAD'));
    } finally {
      await engine.close();
    }
  });

  // Git 2.47+ names the choice on the maintenance command line; older versions never detach it here.
  const maintenance = (cwd: string) => {
    const trace = spawnSync('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'Trigger maintenance'], {
      env: {
        ...process.env,
        GIT_TRACE: '1',
        GIT_AUTHOR_NAME: 'F',
        GIT_AUTHOR_EMAIL: 'f@example.com',
        GIT_COMMITTER_NAME: 'F',
        GIT_COMMITTER_EMAIL: 'f@example.com',
      },
      encoding: 'utf8',
    });
    expect(trace.status, trace.stderr).toBe(0);
    return trace.stderr.split('\n').filter((line) => /run_command: git maintenance run/.test(line));
  };

  it('keeps automatic maintenance inside the command that triggers it in Warden repositories', async () => {
    const repository = await ensureSharedRepository(fx.root);
    const config = (cwd: string) => fx.git('-C', cwd, 'config', '--get-regexp', '^(maintenance|gc)\\.autodetach$').trim().split('\n').sort();
    const foreground = ['gc.autodetach false', 'maintenance.autodetach false'];
    expect(config(repository)).toEqual(foreground);
    // A repository created before the setting existed receives it on the next use.
    fx.git('-C', repository, 'config', '--unset', 'maintenance.autoDetach');
    fx.git('-C', repository, 'config', 'gc.autoDetach', 'true');
    expect(await ensureSharedRepository(fx.root)).toBe(repository);
    expect(config(repository)).toEqual(foreground);

    const engine = await Engine.open(fx.root, path.join(data, 'state.json'));
    try {
      await engine.execute('workflow.configure', { branch: 'main' });
      const task = await engine.execute('task.create', { title: 'Foreground maintenance' });
      expect(config(task.worktree!)).toEqual(foreground);
      const preview = await engine.execute('preview.connect', { connectedIds: [task.id] });
      // The fixture primary disables maintenance; these repositories are created by Warden.
      for (const cwd of [task.worktree!, preview.worktree!]) {
        for (const line of maintenance(cwd)) expect(line).toMatch(/--no-detach/);
      }
    } finally {
      await engine.close();
    }
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
    expect(result.branchError).toContain('is still checked out in a workspace');
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
