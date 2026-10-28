import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, PreviewService } from '@warden/engine';
import { checkoutWorktree } from '../packages/engine/src/worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fixture: FixtureRepo;
let directory: string;
let engine: Engine;
const engines: Engine[] = [];
beforeEach(async () => {
  fixture = await makeFixtureRepo('warden-engine-');
  directory = await mkdtemp(path.join(os.tmpdir(), 'warden-engine-data-'));
  engine = await Engine.open(fixture.root, path.join(directory, 'state.json'));
  engines.push(engine);
  await engine.execute('workflow.configure', { branch: 'main' });
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((instance) => instance.close()));
  vi.restoreAllMocks();
  for (const slot of [1, 2, 3]) await rm(`${fixture.root}-${slot}`, { recursive: true, force: true });
  await fixture.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe('desktop engine', () => {
  it('reviews submodule versions without requiring their objects in the primary repository', async () => {
    const before = '1'.repeat(40);
    const after = '2'.repeat(40);
    fixture.git('update-index', '--add', '--cacheinfo', `160000,${before},dependency`);
    fixture.git('commit', '-qm', 'Record external submodule version');
    fixture.git('update-index', '--cacheinfo', `160000,${after},dependency`);
    fixture.git('commit', '-qm', 'Update external submodule version');
    const key = `commit:${fixture.git('rev-parse', 'HEAD').trim()}`;
    expect((await engine.execute('review.files', { key })).files.map((file) => file.path)).toEqual(['dependency']);
    expect((await engine.execute('review.file', { key, file: 'dependency', side: 'old' })).content).toBe(`Subproject commit ${before}\n`);
    expect((await engine.execute('review.file', { key, file: 'dependency', side: 'new' })).content).toBe(`Subproject commit ${after}\n`);
  });

  it('refreshes the persistent preview and its setup environment across branches at the same commit', async () => {
    await fixture.write('.gitignore', 'node_modules/\n');
    fixture.git('add', '.gitignore');
    fixture.git('commit', '-qm', 'Ignore runtime dependencies');
    fixture.git('branch', 'feature/other');
    await engine.execute('config.save', {
      hooks: {},
      previewSetup: 'mkdir -p node_modules; printf "%s" "$WARDEN_DEVELOPMENT_BRANCH" > node_modules/branch',
    });
    const first = await engine.execute('preview.refresh', undefined);
    expect(first.setup?.status).toBe('succeeded');
    expect(await readFile(path.join(first.worktree!, 'node_modules/branch'), 'utf8')).toBe('main');
    await writeFile(path.join(first.worktree!, 'node_modules/retained'), 'dependency cache');
    fixture.git('switch', 'feature/other');
    await engine.execute('workflow.configure', { branch: 'feature/other' });
    expect((await engine.execute('preview.get', undefined)).syncStatus).toBe('pending');
    const next = await engine.execute('preview.refresh', undefined);
    expect(next.developmentBranch).toBe('feature/other');
    expect(next.developmentHead).toBe(first.developmentHead);
    expect(next.worktree).toBe(first.worktree);
    expect(next.syncStatus).toBe('synced');
    expect(next.setup?.status).toBe('succeeded');
    expect(await readFile(path.join(next.worktree!, 'node_modules/branch'), 'utf8')).toBe('feature/other');
    expect(await readFile(path.join(next.worktree!, 'node_modules/retained'), 'utf8')).toBe('dependency cache');
  });

  it('rejects an old branch request after it waits behind another window switching requirements', async () => {
    fixture.git('branch', 'feature/other');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = engine.store.withRepositoryLock(async () => {
      entered();
      await gate;
    });
    await held;
    let waiting!: () => void;
    const attempted = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const lock = engine.store.withRepositoryLock.bind(engine.store);
    vi.spyOn(engine.store, 'withRepositoryLock').mockImplementation((fn) => {
      waiting();
      return lock(fn);
    });
    const rejected = expect(engine.execute('task.create', { title: 'Stale A task' }, { developmentBranch: 'main' })).rejects.toMatchObject({
      code: 'requirement_changed',
    });
    try {
      await attempted;
      await engine.store.update((state) => {
        state.workflow!.developmentBranch = 'feature/other';
      });
    } finally {
      release();
      await holding;
    }
    await rejected;
    expect((await engine.execute('workflow.get', undefined)).workflow!.changes).toHaveLength(0);
    const current = await engine.execute('task.create', { title: 'Current B task' }, { developmentBranch: 'feature/other' });
    expect(current.developmentBranch).toBe('feature/other');
    expect((await engine.execute('task.create', { title: 'Unscoped task' })).developmentBranch).toBe('feature/other');
  });

  it('allocates a fresh logical workspace in a clean free directory without inheriting an old branch', async () => {
    const base = fixture.git('rev-parse', 'HEAD').trim();
    const old = await checkoutWorktree(engine.repo, { slot: 1, branch: 'old-task', base, kind: 'shared' });
    await writeFile(path.join(old.worktree.path, 'old.txt'), 'Old work\n');
    fixture.git('-C', old.worktree.path, 'add', '.');
    fixture.git('-C', old.worktree.path, 'commit', '-qm', 'Old task');
    fixture.git('-C', old.worktree.path, 'switch', '--detach');
    const plan = await engine.execute('task.create', { title: 'New workspace', body: 'Fresh task' });
    const task = await engine.execute('task.start', { taskId: plan.id });
    expect(task.worktree).toBe(old.worktree.path);
    expect(task.branch).not.toBe('old-task');
    expect(task.base).toBe(base);
    expect(task.deliveries).toBeUndefined();
    expect(fixture.git('-C', task.worktree, 'rev-parse', 'HEAD').trim()).toBe(base);
    await expect(readFile(path.join(task.worktree, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await engine.execute('task.create', { title: 'Another workspace' });
    expect((await engine.execute('task.start', { taskId: next.id })).worktree).not.toBe(task.worktree);
  });

  it('preserves structured errors and rejects adoption through the desktop API', async () => {
    await expect(engine.execute('task.create', { title: '' })).rejects.toMatchObject({ code: 'invalid_title' });
    const plan = await engine.execute('task.create', { title: 'Task' });
    await expect(engine.execute('task.start', { taskId: plan.id, worktree: fixture.root } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await engine.execute('workflow.get', undefined)).workflow?.changes[0]?.worktree).toBeUndefined();
    expect(fixture.git('status', '--porcelain')).toBe('');
  });

  it('keeps one background preview owner and transfers ownership when its session closes', async () => {
    const second = await Engine.open(fixture.root, engine.store.file);
    engines.push(second);
    const owners = new Set<PreviewService>();
    vi.spyOn(PreviewService.prototype, 'tick').mockImplementation(async function (this: PreviewService) {
      owners.add(this);
    });
    const errors: unknown[] = [];
    await engine.start(
      async () => {},
      (error) => errors.push(error),
    );
    await vi.waitFor(() => expect(owners.size).toBe(1), { timeout: 3000 });
    // Close both in turn: only a live session may retain the observer lease.
    const ownerFile = path.join(`${engine.store.file}.preview-owner.lock`, 'v2', 'active');
    const ownerEntries = await readdir(ownerFile);
    expect(ownerEntries).toHaveLength(1);
    expect(await readFile(path.join(ownerFile, ownerEntries[0]!), 'utf8')).toContain(`${process.pid}:`);
    await second.start(
      async () => {},
      (error) => errors.push(error),
    );
    await engine.close();
    await vi.waitFor(() => expect(owners.size).toBe(2), { timeout: 3000 });
    await second.close();
    await expect(readdir(ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(engine.execute('workflow.get', undefined)).rejects.toMatchObject({ code: 'session_closed' });
    expect(errors).toEqual([]);
  });

  it('lets a requested write wait for its own slow preview without consuming the repository lock timeout', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(PreviewService.prototype, 'tick').mockImplementation(async () => {
      await engine.store.withRepositoryLock(async () => {
        entered();
        await gate;
      });
    });
    const errors: unknown[] = [];
    await engine.start(
      async () => {},
      (error) => errors.push(error),
    );
    await running;
    const requested = engine.execute('task.create', { title: 'After preview' }).then(
      (task) => ({ task }),
      (error) => ({ error }),
    );
    try {
      // A legitimate local composition can exceed the cross-window lock wait on Windows.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect((await engine.execute('workflow.context', undefined)).developmentBranch).toBe('main');
      expect((await engine.store.load()).workflow!.changes).toHaveLength(0);
    } finally {
      release();
    }
    expect(await requested).toMatchObject({ task: { title: 'After preview' } });
    expect(errors).toEqual([]);
  });

  it('drains an in-flight mutation before closing and keeps the saved plan available to the next session', async () => {
    const creating = engine.execute('task.create', { title: 'Persist across reload' });
    await engine.close();
    const task = await creating;
    const reopened = await Engine.open(fixture.root, engine.store.file);
    engines.push(reopened);
    expect((await reopened.execute('workflow.get', undefined)).workflow?.changes.some((row) => row.id === task.id)).toBe(true);
  });
});
