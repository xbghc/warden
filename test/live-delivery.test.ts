import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../packages/engine/src/engine.js';
import { GitSandbox } from '../packages/engine/src/git-sandbox.js';
import { sharedRepositoryPath } from '../packages/engine/src/shared-repository.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let engine: Engine;
const timeout = process.platform === 'win32' ? 90_000 : 30_000;

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-live-delivery-');
  data = await mkdtemp(path.join(os.tmpdir(), 'warden-live-delivery-data-'));
  engine = await Engine.open(fx.root, path.join(data, 'state.json'));
  await engine.execute('workflow.configure', { branch: 'main' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  for (const slot of [1, 2]) await rm(`${fx.root}-${slot}`, { recursive: true, force: true });
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

async function reviewed(taskId: string) {
  const review = (await engine.execute('task.review', { taskId }))!;
  expect(review.sourceHead).toBeTruthy();
  return { taskId, sourceHead: review.sourceHead!, sourceTree: review.sourceTree, sourceBase: review.sourceBase, developmentHead: review.developmentHead! };
}

async function index(cwd: string) {
  return readFile(path.resolve(cwd, fx.git('-C', cwd, 'rev-parse', '--git-path', 'index').trim()));
}

async function createTask(title: string) {
  const task = await engine.execute('task.create', { title });
  if (!task.worktree) throw new Error(task.workspaceError?.message ?? 'Workspace allocation failed');
  return task;
}

describe('saved workspace delivery', () => {
  it.each([
    { synchronization: 'merge', increment: 'saved' },
    { synchronization: 'merge', increment: 'committed' },
    { synchronization: 'rebase', increment: 'saved' },
    { synchronization: 'rebase', increment: 'committed' },
  ] as const)(
    'keeps superseded snapshots out of a $increment increment after manual $synchronization and a primary revert',
    { timeout },
    async ({ synchronization, increment }) => {
      const task = await createTask('Snapshot boundary');
      await fx.write('human.txt', 'Primary contribution\n');
      fx.git('add', '.');
      fx.git('commit', '-qm', 'Add primary contribution');
      await writeFile(path.join(task.worktree, 'first.txt'), 'First increment\n');
      const first = await reviewed(task.id);
      expect(first.sourceTree).toBeTruthy();
      await engine.execute('task.deliver', { ...first, message: 'Deliver saved first increment' });
      const incorporated = fx.git('rev-parse', 'HEAD').trim();

      fx.git('-C', task.worktree, 'add', '.');
      fx.git('-C', task.worktree, 'commit', '-qm', 'Checkpoint the first increment');
      fx.git('-C', task.worktree, 'fetch', '-q', fx.root, 'main');
      if (synchronization === 'merge') fx.git('-C', task.worktree, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
      else fx.git('-C', task.worktree, 'rebase', '-q', 'FETCH_HEAD');
      fx.git('rm', 'human.txt');
      fx.git('commit', '-qm', 'Remove primary contribution');
      await writeFile(path.join(task.worktree, 'second.txt'), 'Second increment\n');
      if (increment === 'committed') {
        fx.git('-C', task.worktree, 'add', '.');
        fx.git('-C', task.worktree, 'commit', '-qm', 'Checkpoint the second increment');
      }

      // Effective boundaries belong to this observation; review must not repair persisted state.
      const state = await readFile(engine.store.file);
      const beforeIndex = await index(task.worktree);
      const beforeStatus = fx.git('-C', task.worktree, 'status', '--porcelain');
      const beforeHead = fx.git('-C', task.worktree, 'rev-parse', 'HEAD').trim();
      const review = (await engine.execute('task.review', { taskId: task.id }))!;
      expect(review.sourceBase).toBe(incorporated);
      expect(!!review.sourceTree).toBe(increment === 'saved');
      expect((await engine.execute('review.files', { key: review.targetKey })).files.map((file) => file.path)).toEqual(['second.txt']);
      expect(await readFile(engine.store.file)).toEqual(state);

      const preview = await engine.execute('preview.connect', { connectedIds: [task.id] });
      expect(preview.syncStatus).toBe('synced');
      await expect(readFile(path.join(preview.worktree!, 'human.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(preview.worktree!, 'second.txt'), 'utf8')).toBe('Second increment\n');
      await engine.execute('task.deliver', { ...(await reviewed(task.id)), message: 'Deliver only the reviewed second increment' });
      expect(fx.git('diff', '--name-only', 'HEAD^', 'HEAD').trim()).toBe('second.txt');
      await expect(readFile(path.join(fx.root, 'human.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(fx.root, 'first.txt'), 'utf8')).toBe('First increment\n');
      expect(await readFile(path.join(fx.root, 'second.txt'), 'utf8')).toBe('Second increment\n');
      expect(await index(task.worktree)).toEqual(beforeIndex);
      expect(fx.git('-C', task.worktree, 'status', '--porcelain')).toBe(beforeStatus);
      expect(fx.git('-C', task.worktree, 'rev-parse', 'HEAD').trim()).toBe(beforeHead);
    },
  );

  it('keeps a saved delivery boundary usable after hooks edit its contents and Git prunes trial objects', { timeout }, async () => {
    const task = await createTask('Hook edits');
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
    await writeFile(path.join(task.worktree, 'story.txt'), lines.join(''));
    const hook = path.join(fx.root, '.git/hooks/pre-commit');
    await writeFile(hook, '#!/bin/sh\nsed "s/^line 22$/Hook line 22/" story.txt > story.tmp\nmv story.tmp story.txt\ngit add story.txt\n');
    await chmod(hook, 0o755);
    await engine.execute('task.deliver', { ...(await reviewed(task.id)), message: 'First' });
    await rm(hook);
    fx.git('-C', sharedRepositoryPath(fx.root), 'reflog', 'expire', '--expire=now', '--all');
    fx.git('-C', sharedRepositoryPath(fx.root), 'gc', '--prune=now');
    lines[25] = 'Second increment\n';
    await writeFile(path.join(task.worktree, 'story.txt'), lines.join(''));
    await engine.execute('task.deliver', { ...(await reviewed(task.id)), message: 'Second' });
    expect(await readFile(path.join(fx.root, 'story.txt'), 'utf8')).toBe(lines.join('').replace('line 22\n', 'Hook line 22\n'));
  });

  it('squashes staged, unstaged, untracked, deleted, renamed and binary content without changing the task checkout', { timeout }, async () => {
    const task = await createTask('Saved content');
    const cwd = task.worktree;
    const source = fx.git('-C', cwd, 'rev-parse', 'HEAD').trim();
    await writeFile(path.join(cwd, 'README.md'), 'Staged version\n');
    fx.git('-C', cwd, 'add', 'README.md');
    await writeFile(path.join(cwd, 'README.md'), 'Saved version\n');
    await writeFile(path.join(cwd, 'new.txt'), 'New content\n');
    await writeFile(path.join(cwd, 'binary.dat'), Buffer.from([0, 1, 255, 2]));
    await rm(path.join(cwd, 'src/b.ts'));
    await rename(path.join(cwd, 'src/util/c.ts'), path.join(cwd, 'src/util/renamed.ts'));
    const beforeStatus = fx.git('-C', cwd, 'status', '--porcelain');
    const beforeIndex = await index(cwd);
    const request = await reviewed(task.id);
    const review = (await engine.execute('task.review', { taskId: task.id }))!;
    expect((await engine.execute('review.file', { key: review.targetKey, file: 'README.md', side: 'new' })).content).toBe('Saved version\n');
    await engine.execute('task.deliver', { ...request, message: 'Squash saved workspace content' });
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toBe('Saved version\n');
    expect(await readFile(path.join(fx.root, 'binary.dat'))).toEqual(Buffer.from([0, 1, 255, 2]));
    expect(fx.git('diff', '--name-status', 'HEAD^', 'HEAD')).toContain('R100\tsrc/util/c.ts\tsrc/util/renamed.ts');
    expect(fx.git('status', '--porcelain')).toBe('');
    expect(fx.git('-C', cwd, 'rev-parse', 'HEAD').trim()).toBe(source);
    expect(await index(cwd)).toEqual(beforeIndex);
    expect(fx.git('-C', cwd, 'status', '--porcelain')).toBe(beforeStatus);
    const pending = (await engine.execute('task.review', { taskId: task.id }))!;
    expect((await engine.execute('review.files', { key: pending.targetKey })).files).toEqual([]);

    // The source HEAD remains unchanged through two deliveries; only the saved tree advances.
    await writeFile(path.join(cwd, 'new.txt'), 'Second increment\n');
    const second = (await engine.execute('task.review', { taskId: task.id }))!;
    expect((await engine.execute('review.files', { key: second.targetKey })).files.map((file) => file.path)).toEqual(['new.txt']);
    const preview = await engine.execute('preview.connect', { connectedIds: [task.id] });
    expect(preview.syncStatus).toBe('synced');
    await engine.execute('task.deliver', { ...(await reviewed(task.id)), message: 'Second saved increment' });
    expect(fx.git('diff', '--name-only', 'HEAD^', 'HEAD').trim()).toBe('new.txt');
    expect(fx.git('-C', cwd, 'rev-parse', 'HEAD').trim()).toBe(source);
    expect((await engine.execute('preview.get', undefined)).syncStatus).toBe('synced');
    const updated = (await engine.execute('workflow.get', undefined)).workflow!.changes[0]!;
    expect(updated.worktree && updated.deliveries).toHaveLength(2);
  });

  it('rejects saved edits made after review or during composition before touching primary', { timeout }, async () => {
    const task = await createTask('Pinned files');
    const file = path.join(task.worktree, 'new.txt');
    await writeFile(file, 'Reviewed\n');
    const request = await reviewed(task.id);
    const review = (await engine.execute('task.review', { taskId: task.id }))!;
    await writeFile(file, 'Changed without a source commit\n');
    expect((await engine.execute('review.file', { key: review.targetKey, file: 'new.txt', side: 'new' })).content).toBe('Reviewed\n');
    await expect(engine.execute('task.deliver', { ...request, message: 'Stale' })).rejects.toMatchObject({ code: 'review_changed' });
    const next = await reviewed(task.id);
    const original = GitSandbox.prototype.commit;
    vi.spyOn(GitSandbox.prototype, 'commit').mockImplementationOnce(async function (this: GitSandbox, message) {
      const commit = await original.call(this, message);
      await writeFile(file, 'Changed during composition\n');
      return commit;
    });
    await expect(engine.execute('task.deliver', { ...next, message: 'Racing' })).rejects.toMatchObject({ code: 'review_changed' });
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(request.developmentHead);
    expect(fx.git('status', '--porcelain')).toBe('');
    expect((await engine.execute('workflow.get', undefined)).preparation).toBeUndefined();
  });

  it('preserves normal hooks and snapshot boundaries through failure and later committed progress', { timeout }, async () => {
    const task = await createTask('Hooks and follow-up');
    const cwd = task.worktree;
    await writeFile(path.join(cwd, 'first.txt'), 'First\n');
    const hook = path.join(fx.root, '.git/hooks/pre-commit');
    await writeFile(hook, '#!/bin/sh\necho blocked >&2\nexit 1\n');
    await chmod(hook, 0o755);
    await expect(engine.execute('task.deliver', { ...(await reviewed(task.id)), message: 'First delivery' })).rejects.toMatchObject({ code: 'commit_failed' });
    await rm(hook);
    const preparation = (await engine.execute('workflow.get', undefined)).preparation!;
    await engine.execute('task.accept', {
      taskId: task.id,
      mode: 'commit',
      developmentHead: preparation.head!,
      indexFingerprint: preparation.indexFingerprint!,
      message: 'Retry first',
    });
    await writeFile(path.join(cwd, 'second.txt'), 'Second\n');
    fx.git('-C', cwd, 'add', '.');
    fx.git('-C', cwd, 'commit', '-qm', 'Agent checkpoint after first delivery');
    const review = (await engine.execute('task.review', { taskId: task.id }))!;
    expect((await engine.execute('review.files', { key: review.targetKey })).files.map((file) => file.path)).toEqual(['second.txt']);
    await engine.execute('task.deliver', { ...(await reviewed(task.id)), message: 'Only the second increment' });
    expect(fx.git('diff', '--name-only', 'HEAD^', 'HEAD').trim()).toBe('second.txt');
    const checks = await engine.execute('rebase.check', undefined);
    const check = checks.checks[0]!;
    expect(check.status).toBe('ready');
    const result = await engine.execute('rebase.run', { items: [{ changeId: task.id, sourceHead: check.sourceHead, developmentHead: check.developmentHead }] });
    expect(result.results[0]!.status).toBe('updated');
    expect(fx.git('-C', cwd, 'rev-parse', 'HEAD').trim()).toBe(fx.git('rev-parse', 'HEAD').trim());
    const updated = (await engine.execute('workflow.get', undefined)).workflow!.changes[0]!;
    expect(updated.worktree && updated.sourceTree).toBeUndefined();
  });
});
