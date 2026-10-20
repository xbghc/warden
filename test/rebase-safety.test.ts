import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentChange, SlotKind } from '@warden/shared';
import { resolveRepo, StateStore, WorkflowService } from '@warden/server';
import * as backups from '../packages/server/src/backups.js';
import * as git from '../packages/server/src/git.js';
import { listWorktreesDetailed } from '../packages/server/src/worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let store: StateStore;
let workflow: WorkflowService;
const head = (cwd = fx.root) => fx.git('-C', cwd, 'rev-parse', 'HEAD').trim();

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-rebase-safety-');
  fx.git('switch', '-qc', 'feature/order');
  await fx.write('.gitignore', 'local.env\nlocal-dir/\nobstacle\n');
  fx.git('add', '.gitignore');
  fx.git('commit', '-qm', 'Ignore local files');
  data = await mkdtemp(path.join(os.tmpdir(), 'warden-rebase-safety-data-'));
  store = new StateStore(path.join(data, 'state.json'), fx.root);
  workflow = new WorkflowService(await resolveRepo(fx.root), store);
  await workflow.configure('feature/order');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const row of await listWorktreesDetailed(await resolveRepo(fx.root))) if (row.slot !== undefined) await rm(row.path, { recursive: true, force: true });
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

async function source(kind: SlotKind = 'worktree') {
  const change = await workflow.start((await workflow.create({ title: 'Keep source work' })).id, { kind });
  fx.git('-C', change.worktree, 'config', 'user.name', 'Fixture');
  fx.git('-C', change.worktree, 'config', 'user.email', 'fixture@example.com');
  await writeFile(path.join(change.worktree, 'task.txt'), 'task work\n');
  fx.git('-C', change.worktree, 'add', 'task.txt');
  fx.git('-C', change.worktree, 'commit', '-qm', 'Task progress');
  return change;
}

async function advance(file = 'destination.txt', content = 'destination work\n') {
  await fx.write(file, content);
  fx.git('add', '-f', '--', file);
  fx.git('commit', '-qm', 'Advance primary development branch');
  return head();
}

describe('rebase safety', () => {
  it.each(['worktree', 'clone'] as const)('completes and verifies a backup before rebasing a %s', async (kind) => {
    const change = await source(kind);
    const before = head(change.worktree);
    await writeFile(path.join(change.worktree, 'local.env'), 'private local config\n');
    const target = await advance();
    const createBackup = backups.createSafetyBackup;
    let saved: Awaited<ReturnType<typeof createBackup>> | undefined;
    vi.spyOn(backups, 'createSafetyBackup').mockImplementation(async (...args) => {
      saved = await createBackup(...args);
      expect(saved).toMatchObject({ reason: 'rebase', head: before, worktree: change.worktree });
      expect((await stat(saved.path)).isDirectory()).toBe(true);
      expect(fx.git('--git-dir', path.join(saved.path, 'git-common'), 'cat-file', '-t', before).trim()).toBe('commit');
      expect(await readFile(path.join(saved.path, 'worktree', 'local.env'), 'utf8')).toBe('private local config\n');
      expect(head(change.worktree)).toBe(before);
      return saved;
    });
    const write = git.runGitWrite;
    vi.spyOn(git, 'runGitWrite').mockImplementation(async (args, options) => {
      if (args.includes('rebase')) expect(saved).toBeDefined();
      return write(args, options);
    });
    const updated = await workflow.sync(change.id, before, target);
    expect(updated.base).toBe(target);
    expect(head(change.worktree)).not.toBe(before);
    expect(await readFile(path.join(change.worktree, 'local.env'), 'utf8')).toBe('private local config\n');
    expect(await readFile(path.join(change.worktree, 'task.txt'), 'utf8')).toBe('task work\n');
    expect(fx.git('-C', change.worktree, 'status', '--porcelain').trim()).toBe('');
    expect(backups.createSafetyBackup).toHaveBeenCalledOnce();
    expect(await backups.listSafetyBackups(store)).toEqual([]);
    expect((await store.load()).workflow!.changes.find((row) => row.id === change.id)).not.toHaveProperty('rebaseBackups');
  });

  it('leaves the source untouched when its backup fails', async () => {
    const change = await source();
    const before = head(change.worktree);
    const indexPath = path.resolve(change.worktree, fx.git('-C', change.worktree, 'rev-parse', '--git-path', 'index').trim());
    const index = await readFile(indexPath);
    const target = await advance();
    vi.spyOn(backups, 'createSafetyBackup').mockRejectedValue(Object.assign(new Error('Backup disk unavailable'), { code: 'backup_failed' }));
    const write = vi.spyOn(git, 'runGitWrite');
    await expect(workflow.sync(change.id, before, target)).rejects.toMatchObject({ code: 'backup_failed' });
    expect(write.mock.calls.some(([args]) => args.includes('rebase'))).toBe(false);
    expect(head(change.worktree)).toBe(before);
    expect(await readFile(indexPath)).toEqual(index);
    expect(await readFile(path.join(change.worktree, 'task.txt'), 'utf8')).toBe('task work\n');
  });

  it.each(['source', 'destination'] as const)('rejects a changed %s revision after the backup finishes', async (changed) => {
    const change = await source();
    const before = head(change.worktree);
    const target = await advance();
    const createBackup = backups.createSafetyBackup;
    let externalHead = '';
    vi.spyOn(backups, 'createSafetyBackup').mockImplementation(async (...args) => {
      const saved = await createBackup(...args);
      const cwd = changed === 'source' ? change.worktree : fx.root;
      fx.git('-C', cwd, 'commit', '--allow-empty', '-qm', 'External commit during backup');
      externalHead = head(cwd);
      return saved;
    });
    const write = vi.spyOn(git, 'runGitWrite');
    await expect(workflow.sync(change.id, before, target)).rejects.toMatchObject({ code: 'review_changed' });
    expect(head(change.worktree)).toBe(changed === 'source' ? externalHead : before);
    expect(head()).toBe(changed === 'destination' ? externalHead : target);
    expect(write.mock.calls.some(([args]) => args.includes('rebase'))).toBe(false);
  });

  it.each([
    ['local.env', 'local.env'],
    ['local-dir/private.txt', 'local-dir'],
    ['obstacle', 'obstacle/tracked.txt'],
  ])('preserves ignored %s when the target introduces %s', async (local, tracked) => {
    const change = await source();
    const before = head(change.worktree);
    await mkdir(path.dirname(path.join(change.worktree, local!)), { recursive: true });
    await writeFile(path.join(change.worktree, local!), 'irreplaceable local contents\n');
    const target = await advance(tracked!);
    const backup = vi.spyOn(backups, 'createSafetyBackup');
    await expect(workflow.sync(change.id, before, target)).rejects.toMatchObject({ code: 'rebase_ignored_collision' });
    expect(head(change.worktree)).toBe(before);
    expect(await readFile(path.join(change.worktree, local!), 'utf8')).toBe('irreplaceable local contents\n');
    expect(backup).not.toHaveBeenCalled();
  });

  it.each([
    ['local.env', 'LOCAL.ENV'],
    ['local-dir/private.txt', 'LOCAL-DIR'],
    ['obstacle', 'OBSTACLE/tracked.txt'],
  ])('honors core.ignorecase for %s versus %s on macOS', async (local, tracked) => {
    const change = await source();
    fx.git('-C', change.worktree, 'config', 'core.ignorecase', 'true');
    const before = head(change.worktree);
    await mkdir(path.dirname(path.join(change.worktree, local!)), { recursive: true });
    await writeFile(path.join(change.worktree, local!), 'preserve case-insensitive local contents\n');
    const target = await advance(tracked!);
    const backup = vi.spyOn(backups, 'createSafetyBackup');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await expect(workflow.sync(change.id, before, target)).rejects.toMatchObject({ code: 'rebase_ignored_collision' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(head(change.worktree)).toBe(before);
    expect(await readFile(path.join(change.worktree, local!), 'utf8')).toBe('preserve case-insensitive local contents\n');
    expect(backup).not.toHaveBeenCalled();
  });

  it('protects ignored files from an intermediate replay commit even when the final source tree deletes them', async () => {
    const change = await source();
    await writeFile(path.join(change.worktree, 'local.env'), 'formerly tracked\n');
    fx.git('-C', change.worktree, 'add', '-f', 'local.env');
    fx.git('-C', change.worktree, 'commit', '-qm', 'Temporary tracked configuration');
    fx.git('-C', change.worktree, 'rm', 'local.env');
    fx.git('-C', change.worktree, 'commit', '-qm', 'Stop tracking configuration');
    await writeFile(path.join(change.worktree, 'local.env'), 'new private configuration\n');
    const before = head(change.worktree);
    const target = await advance();
    await expect(workflow.sync(change.id, before, target)).rejects.toMatchObject({ code: 'rebase_ignored_collision' });
    expect(head(change.worktree)).toBe(before);
    expect(await readFile(path.join(change.worktree, 'local.env'), 'utf8')).toBe('new private configuration\n');
  });

  it('leaves actual rebase conflicts in place and keeps the original source backup', async () => {
    const change = await source();
    await writeFile(path.join(change.worktree, 'src/b.ts'), 'export const b = 20;\n');
    fx.git('-C', change.worktree, 'add', 'src/b.ts');
    fx.git('-C', change.worktree, 'commit', '-qm', 'Source change');
    const before = head(change.worktree);
    const target = await advance('src/b.ts', 'export const b = 30;\n');
    const backup = vi.spyOn(backups, 'createSafetyBackup');
    await expect(workflow.sync(change.id, before, target)).rejects.toThrow();
    const saved = await backup.mock.results[0]!.value;
    expect(saved.head).toBe(before);
    expect((await stat(saved.path)).isDirectory()).toBe(true);
    expect(fx.git('-C', change.worktree, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('src/b.ts');
    const recorded = (await store.load()).workflow!.changes.find((c) => c.id === change.id) as DevelopmentChange;
    expect(recorded.sync).toMatchObject({ status: 'conflict', target });
  });

  it('repairs interrupted bookkeeping without rebasing or running hooks a second time', async () => {
    const change = await source();
    const before = head(change.worktree);
    const target = await advance();
    const update = store.update.bind(store);
    const brokenSave = vi.spyOn(store, 'update').mockImplementation(async (mutate) =>
      update((state) => {
        const result = mutate(state);
        if (state.workflow!.changes.some((row) => row.worktree && row.base === target)) throw new Error('State disk unavailable');
        return result;
      }),
    );
    await expect(workflow.sync(change.id, before, target)).rejects.toThrow('State disk unavailable');
    const rebased = head(change.worktree);
    expect(rebased).not.toBe(before);
    brokenSave.mockRestore();
    const write = vi.spyOn(git, 'runGitWrite');
    const backup = vi.spyOn(backups, 'createSafetyBackup');
    const repaired = await workflow.sync(change.id, rebased, target);
    expect(repaired.base).toBe(target);
    expect(head(change.worktree)).toBe(rebased);
    expect(write.mock.calls.some(([args]) => args.includes('rebase'))).toBe(false);
    expect(backup).not.toHaveBeenCalled();
    expect(await backups.listSafetyBackups(store)).toEqual([]);
  });
});
