import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../packages/engine/src/engine.js';
import { createSafetyBackup, discardOperationBackup } from '../packages/engine/src/backups.js';
import { GitSandbox } from '../packages/engine/src/git-sandbox.js';
import { PreviewService } from '../packages/engine/src/preview.js';
import { sharedRepositoryPath } from '../packages/engine/src/shared-repository.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let engine: Engine;
const timeout = process.platform === 'win32' ? 90_000 : 30_000;
// "中文" in GBK: valid text without NUL, invalid as UTF-8.
const gbk = Buffer.from([0x6e, 0x65, 0x77, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]);

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-regressions-');
  data = await mkdtemp(path.join(os.tmpdir(), 'warden-regressions-data-'));
  engine = await Engine.open(fx.root, path.join(data, 'state.json'));
  await engine.execute('workflow.configure', { branch: 'main' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  for (const slot of [1, 2]) await rm(`${fx.root}-${slot}`, { recursive: true, force: true });
  await rm(path.dirname(sharedRepositoryPath(fx.root)), { recursive: true, force: true });
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

async function reviewed(taskId: string) {
  const review = (await engine.execute('task.review', { taskId }))!;
  expect(review.sourceHead).toBeTruthy();
  return { taskId, sourceHead: review.sourceHead!, sourceTree: review.sourceTree, sourceBase: review.sourceBase, developmentHead: review.developmentHead! };
}

async function createTask(title: string) {
  const task = await engine.execute('task.create', { title });
  if (!task.worktree) throw new Error(task.workspaceError?.message ?? 'Workspace allocation failed');
  return task;
}

const files = async (taskId: string) => {
  const review = (await engine.execute('task.review', { taskId }))!;
  return (await engine.execute('review.files', { key: review.targetKey })).files.map((file) => file.path);
};

const task = async (id: string) => (await engine.execute('workflow.get', undefined as never)).workflow!.changes.find((row) => row.id === id)!;

describe('delivery and preview regressions', () => {
  it('keeps text in a legacy encoding byte-exact through preview and delivery', { timeout }, async () => {
    await fx.write('legacy.txt', Buffer.concat([gbk, Buffer.from('ascii line\n')]));
    fx.git('add', '.');
    fx.git('commit', '-qm', 'Add legacy text');
    const created = await createTask('Legacy encoding');
    await writeFile(path.join(created.worktree, 'added.txt'), gbk);
    // The legacy bytes are a context line here and a changed line below.
    await writeFile(path.join(created.worktree, 'legacy.txt'), Buffer.concat([gbk, Buffer.from('ascii changed\n'), gbk]));

    const preview = await engine.execute('preview.connect', { connectedIds: [created.id] });
    expect(preview.syncStatus).toBe('synced');
    expect(await readFile(path.join(preview.worktree!, 'added.txt'))).toEqual(gbk);
    await engine.execute('preview.connect', { connectedIds: [] });

    await engine.execute('task.deliver', { ...(await reviewed(created.id)), message: 'Deliver legacy text' });
    expect(await readFile(path.join(fx.root, 'added.txt'))).toEqual(gbk);
    expect(await readFile(path.join(fx.root, 'legacy.txt'))).toEqual(Buffer.concat([gbk, Buffer.from('ascii changed\n'), gbk]));
    expect(fx.git('status', '--porcelain')).toBe('');
  });

  it('leaves no preparation record when staging in primary is refused', { timeout }, async () => {
    const created = await createTask('Refused staging');
    const other = await createTask('Unrelated task');
    await writeFile(path.join(created.worktree, 'real.txt'), 'Task work\n');
    await writeFile(path.join(other.worktree, 'other.txt'), 'Other work\n');
    const lock = path.join(fx.root, '.git', 'index.lock');
    await writeFile(lock, '');
    await expect(engine.execute('task.deliver', { ...(await reviewed(created.id)), message: 'Blocked' })).rejects.toMatchObject({ code: 'git_failed' });
    await rm(lock);
    expect((await task(created.id)).status).toBe('working');
    expect((await task(created.id)).integration).toBeUndefined();

    // Later base commits must neither strand the task nor be mistaken for its delivery.
    await fx.write('human.txt', 'Human\n');
    fx.git('add', '.');
    fx.git('commit', '-qm', 'Unrelated human commit');
    expect((await engine.execute('workflow.get', undefined as never)).preparation).toBeUndefined();
    await engine.execute('task.deliver', { ...(await reviewed(other.id)), message: 'Deliver other' });
    expect(await files(created.id)).toEqual(['real.txt']);
  });

  it('discards an unprepared record left by an interrupted preparation after the base moved', { timeout }, async () => {
    const created = await createTask('Interrupted preparation');
    await writeFile(path.join(created.worktree, 'real.txt'), 'Task work\n');
    const pinned = await reviewed(created.id);
    // A host killed between the journal write and staging leaves exactly this record.
    await engine.store.update((state) => {
      const row = state.workflow!.changes.find((change) => change.id === created.id)!;
      row.status = 'integrating';
      row.integration = {
        id: 'interrupted',
        source: pinned.sourceHead,
        sourceTree: pinned.sourceTree,
        parent: pinned.developmentHead,
        worktree: fx.root,
        message: 'x',
      };
    });
    await fx.write('human.txt', 'Human\n');
    fx.git('add', '.');
    fx.git('commit', '-qm', 'Exactly one unrelated commit');
    const head = fx.git('rev-parse', 'HEAD').trim();

    const preparation = (await engine.execute('workflow.get', undefined as never)).preparation!;
    expect(preparation.state).toBe('blocked');
    expect(preparation.canRecord).toBeFalsy();
    await expect(engine.execute('task.accept', { taskId: created.id, mode: 'record', commit: head })).rejects.toMatchObject({ code: 'change_not_prepared' });
    await engine.execute('task.resume', { taskId: created.id });
    expect((await task(created.id)).integration).toBeUndefined();
    await engine.execute('task.deliver', { ...(await reviewed(created.id)), message: 'Deliver real work' });
    expect(await readFile(path.join(fx.root, 'real.txt'), 'utf8')).toBe('Task work\n');
  });

  it('keeps a manual merge boundary after a committed delivery when primary reverts', { timeout }, async () => {
    const created = await createTask('Committed boundary');
    await writeFile(path.join(created.worktree, 'first.txt'), 'First\n');
    fx.git('-C', created.worktree, 'add', '.');
    fx.git('-C', created.worktree, 'commit', '-qm', 'First increment');
    await engine.execute('task.deliver', { ...(await reviewed(created.id)), message: 'Deliver first' });
    await fx.write('human.txt', 'Primary contribution\n');
    fx.git('add', '.');
    fx.git('commit', '-qm', 'Add primary contribution');
    const incorporated = fx.git('rev-parse', 'HEAD').trim();
    fx.git('-C', created.worktree, 'fetch', '-q', fx.root, 'main');
    fx.git('-C', created.worktree, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
    await writeFile(path.join(created.worktree, 'second.txt'), 'Second\n');
    fx.git('-C', created.worktree, 'add', '.');
    fx.git('-C', created.worktree, 'commit', '-qm', 'Second increment');
    fx.git('rm', '-q', 'human.txt');
    fx.git('commit', '-qm', 'Remove primary contribution');

    expect((await engine.execute('task.review', { taskId: created.id }))!.sourceBase).toBe(incorporated);
    expect(await files(created.id)).toEqual(['second.txt']);
    await engine.execute('task.deliver', { ...(await reviewed(created.id)), message: 'Deliver second' });
    expect(fx.git('diff', '--name-only', 'HEAD^', 'HEAD').trim()).toBe('second.txt');
  });

  it('offers saved content again after its delivery commit is reset away', { timeout }, async () => {
    const created = await createTask('Undone delivery');
    await writeFile(path.join(created.worktree, 'first.txt'), 'First\n');
    await engine.execute('task.deliver', { ...(await reviewed(created.id)), message: 'Deliver first' });
    expect(await files(created.id)).toEqual([]);
    fx.git('reset', '-q', '--hard', 'HEAD^');
    expect(await files(created.id)).toEqual(['first.txt']);
    await engine.execute('task.deliver', { ...(await reviewed(created.id)), message: 'Deliver first again' });
    expect(await readFile(path.join(fx.root, 'first.txt'), 'utf8')).toBe('First\n');
  });

  it('applies primary local excludes to the preview folder', { timeout }, async () => {
    await mkdir(path.join(fx.root, '.git', 'info'), { recursive: true });
    await writeFile(path.join(fx.root, '.git', 'info', 'exclude'), 'local.env\n');
    await fx.write('local.env', 'SECRET=1\n');
    const created = await createTask('Local excludes');
    await writeFile(path.join(created.worktree, 'feature.txt'), 'One\n');
    const preview = await engine.execute('preview.connect', { connectedIds: [created.id] });
    // What a preview setup script does with WARDEN_REPO.
    await writeFile(path.join(preview.worktree!, 'local.env'), 'SECRET=1\n');
    await writeFile(path.join(created.worktree, 'feature.txt'), 'Two\n');
    const refreshed = await engine.execute('preview.refresh', undefined as never);
    expect(refreshed.syncStatus).toBe('synced');
    expect(await readFile(path.join(preview.worktree!, 'feature.txt'), 'utf8')).toBe('Two\n');

    // Primary can change its excludes later; the next synchronization follows.
    await writeFile(path.join(fx.root, '.git', 'info', 'exclude'), 'local.env\nscratch/\n');
    await mkdir(path.join(preview.worktree!, 'scratch'));
    await writeFile(path.join(preview.worktree!, 'scratch', 'note'), 'x\n');
    await writeFile(path.join(created.worktree, 'feature.txt'), 'Three\n');
    expect((await engine.execute('preview.refresh', undefined as never)).syncStatus).toBe('synced');
  });

  it('does not recompose or rewrite state while a failed preview has the same inputs', { timeout }, async () => {
    const a = await createTask('A');
    const b = await createTask('B');
    await writeFile(path.join(a.worktree, 'src', 'b.ts'), 'from a\n');
    await engine.execute('preview.connect', { connectedIds: [a.id] });
    await engine.execute('preview.connect', { connectedIds: [a.id, b.id] });
    await writeFile(path.join(b.worktree, 'src', 'b.ts'), 'from b\n');
    const preview = new PreviewService(engine.repo, engine.store, 0);
    const create = vi.spyOn(GitSandbox, 'create');
    await preview.tick();
    await preview.tick();
    expect((await preview.get()).syncStatus).toBe('conflict');
    const attempts = create.mock.calls.length;
    const state = await readFile(engine.store.file);
    for (let i = 0; i < 3; i++) await preview.tick();
    expect(create.mock.calls.length).toBe(attempts);
    expect(await readFile(engine.store.file)).toEqual(state);

    // New input is tried again without an explicit request.
    await writeFile(path.join(b.worktree, 'src', 'b.ts'), 'from a\n');
    await preview.tick();
    await preview.tick();
    expect((await preview.get()).syncStatus).toBe('synced');
  });

  it('returns an interrupted publication to the previous preview and continues', { timeout }, async () => {
    const created = await createTask('Interrupted publication');
    await writeFile(path.join(created.worktree, 'one.txt'), 'One\n');
    const preview = await engine.execute('preview.connect', { connectedIds: [created.id] });
    await writeFile(path.join(created.worktree, 'two.txt'), 'Two\n');
    await writeFile(path.join(created.worktree, 'three.txt'), 'Three\n');
    // Stop publication the way a killed `git apply` does: one candidate file written, the
    // index untouched, the pending record and the candidate sandbox retained.
    const original = GitSandbox.prototype.apply;
    vi.spyOn(GitSandbox.prototype, 'apply').mockImplementation(async function (this: GitSandbox, ...args: Parameters<GitSandbox['apply']>) {
      if (this.path !== preview.worktree) return original.apply(this, args);
      await writeFile(path.join(this.path, 'two.txt'), 'Two\n');
      throw new Error('killed');
    });
    await engine.execute('preview.refresh', undefined as never);
    vi.restoreAllMocks();
    expect((await engine.store.load()).connectionPreview?.pending).toBeTruthy();

    const recovered = await engine.execute('preview.refresh', undefined as never);
    expect(recovered.syncStatus).toBe('synced');
    expect(await readFile(path.join(preview.worktree!, 'three.txt'), 'utf8')).toBe('Three\n');

    // Content that is neither the previous nor the candidate version is never removed.
    await writeFile(path.join(created.worktree, 'four.txt'), 'Four\n');
    vi.spyOn(GitSandbox.prototype, 'apply').mockImplementation(async function (this: GitSandbox, ...args: Parameters<GitSandbox['apply']>) {
      if (this.path !== preview.worktree) return original.apply(this, args);
      await writeFile(path.join(this.path, 'mine.txt'), 'User edit\n');
      throw new Error('killed');
    });
    await engine.execute('preview.refresh', undefined as never);
    vi.restoreAllMocks();
    const blocked = await engine.execute('preview.refresh', undefined as never);
    expect(blocked.status).toBe('stale');
    expect(await readFile(path.join(preview.worktree!, 'mine.txt'), 'utf8')).toBe('User edit\n');
  });

  it('finishes removing a temporary backup whose removal was interrupted', async () => {
    const backup = await createSafetyBackup(engine.store, fx.root, 'rebase');
    // The state an interrupted removal leaves: renamed, manifest already gone.
    const discarding = path.join(path.dirname(backup.path), `.discarding-${backup.id}`);
    await rename(backup.path, discarding);
    await rm(path.join(discarding, 'manifest.json'));
    await discardOperationBackup(engine.store, backup);
    await expect(readFile(path.join(discarding, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await discardOperationBackup(engine.store, backup);
  });

  it('lists every commit when log.showSignature is enabled', async () => {
    const plain = await engine.execute('history.get', undefined as never);
    fx.git('config', 'log.showSignature', 'true');
    expect((await engine.execute('history.get', undefined as never)).commits.map((commit) => commit.sha)).toEqual(plain.commits.map((commit) => commit.sha));
  });
});
