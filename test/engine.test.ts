import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const ownerFile = `${engine.store.file}.preview-owner.lock`;
    expect(await readFile(ownerFile, 'utf8')).toContain(`${process.pid}:`);
    await second.start(
      async () => {},
      (error) => errors.push(error),
    );
    await engine.close();
    await vi.waitFor(() => expect(owners.size).toBe(2), { timeout: 3000 });
    await second.close();
    await expect(readFile(ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(engine.execute('workflow.get', undefined)).rejects.toMatchObject({ code: 'session_closed' });
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
