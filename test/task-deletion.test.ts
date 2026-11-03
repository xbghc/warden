import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, PreviewService, WorkflowService } from '@warden/engine';
import type { AcpBinding } from '@warden/shared';
import * as git from '../packages/engine/src/git.js';
import { AcpSessionStorage } from '../packages/vscode/src/acp/storage.js';
import { validateAcpBinding, resolveAcpBinding } from '../packages/vscode/src/acp/binding.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fixture: FixtureRepo;
let directory: string;
let engine: Engine;
beforeEach(async () => {
  fixture = await makeFixtureRepo('warden-delete-');
  directory = await mkdtemp(path.join(os.tmpdir(), 'warden-delete-data-'));
  await fixture.write('.gitignore', 'node_modules/\n.env\n');
  fixture.git('add', '.gitignore');
  fixture.git('commit', '-qm', 'Ignore local environment');
  engine = await Engine.open(fixture.root, path.join(directory, 'state.json'));
  await engine.execute('workflow.configure', { branch: 'main' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  for (const suffix of ['-1', '-2', '-3', '-old', '-extra']) await rm(`${fixture.root}${suffix}`, { recursive: true, force: true });
  await fixture.cleanup();
  await rm(directory, { recursive: true, force: true });
});
const task = (title = 'Disposable task') => engine.execute('task.create', { title });
const remove = async (taskId: string) => {
  const check = await engine.execute('task.deleteCheck', { taskId });
  return engine.execute('task.delete', { taskId, confirmation: check.confirmation });
};
const currentTasks = async () => (await engine.store.load()).workflow!.changes;

describe('confirmed task deletion', () => {
  it('discards saved and staged work without a backup, keeps the directory and ignored environment, and allocates a fresh logical workspace on reuse', async () => {
    const created = await task();
    const cwd = created.worktree!;
    const primary = fixture.git('rev-parse', 'HEAD');
    await writeFile(path.join(cwd, 'source.txt'), 'Source commit\n');
    fixture.git('-C', cwd, 'add', 'source.txt');
    fixture.git('-C', cwd, 'commit', '-qm', 'Undelivered source');
    await writeFile(path.join(cwd, 'README.md'), 'Staged version\n');
    fixture.git('-C', cwd, 'add', 'README.md');
    await writeFile(path.join(cwd, 'README.md'), 'Later saved version\n');
    await writeFile(path.join(cwd, 'discard.txt'), 'Untracked work\n');
    await mkdir(path.join(cwd, 'node_modules'));
    await writeFile(path.join(cwd, 'node_modules', 'installed'), 'Keep dependencies\n');
    await writeFile(path.join(cwd, '.env'), 'Keep local configuration\n');
    expect(created).toMatchObject({ ownsBranch: true });
    const check = await engine.execute('task.deleteCheck', { taskId: created.id });
    expect(check).toMatchObject({ dirty: 2, deleteBranch: true, agentConnected: false });
    const result = await engine.execute('task.delete', { taskId: created.id, confirmation: check.confirmation });
    expect(result).toMatchObject({ taskId: created.id, worktree: cwd, retainedBranch: undefined });
    expect(await currentTasks()).toEqual([]);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(primary);
    expect(fixture.git('-C', cwd, 'status', '--porcelain')).toBe('');
    expect(fixture.git('-C', cwd, 'branch', '--show-current')).toBe('');
    expect(fixture.git('-C', cwd, 'branch', '--list', created.branch!)).toBe('');
    expect(await readFile(path.join(cwd, '.env'), 'utf8')).toBe('Keep local configuration\n');
    expect(await readFile(path.join(cwd, 'node_modules', 'installed'), 'utf8')).toBe('Keep dependencies\n');
    expect(await readdir(directory)).not.toContain('backups');
    const next = await task('Fresh task');
    expect(next.worktree).toBe(cwd);
    expect(next.id).not.toBe(created.id);
    expect(next.branch).not.toBe(created.branch);
    expect(fixture.git('-C', cwd, 'rev-parse', 'HEAD')).toBe(primary);
    expect(await readdir(cwd)).not.toContain('source.txt');
    expect(await engine.execute('task.delete', { taskId: created.id, confirmation: check.confirmation })).toEqual({ taskId: created.id });
    expect((await currentTasks()).map((row) => row.id)).toEqual([next.id]);
  });

  it('requires fresh confirmation even when content changes keep the same dirty status', async () => {
    const created = await task();
    await writeFile(path.join(created.worktree!, 'README.md'), 'First version\n');
    const check = await engine.execute('task.deleteCheck', { taskId: created.id });
    await writeFile(path.join(created.worktree!, 'README.md'), 'Other version\n');
    await expect(engine.execute('task.delete', { taskId: created.id, confirmation: check.confirmation })).rejects.toMatchObject({
      code: 'task_delete_changed',
    });
    await expect(engine.execute('task.delete', { taskId: created.id, confirmation: '' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await currentTasks())[0]!.deletion).toBeUndefined();
    expect(await readFile(path.join(created.worktree!, 'README.md'), 'utf8')).toBe('Other version\n');
  });

  it('removes only this contribution from preview and preserves ordinary primary edits', async () => {
    const a = await task('A');
    const b = await task('B');
    await writeFile(path.join(a.worktree!, 'a.txt'), 'A\n');
    await writeFile(path.join(b.worktree!, 'b.txt'), 'B\n');
    await fixture.write('human.txt', 'Saved human work\n');
    const preview = await engine.execute('preview.connect', { connectedIds: [a.id, b.id] });
    const primaryIndex = await readFile(path.join(fixture.root, '.git', 'index'));
    await remove(a.id);
    expect((await engine.execute('preview.get', undefined)).connectedIds).toEqual([b.id]);
    expect(await readdir(preview.worktree!)).not.toContain('a.txt');
    expect(await readFile(path.join(preview.worktree!, 'b.txt'), 'utf8')).toBe('B\n');
    expect(await readFile(path.join(preview.worktree!, 'human.txt'), 'utf8')).toBe('Saved human work\n');
    expect(await readFile(path.join(fixture.root, '.git', 'index'))).toEqual(primaryIndex);
    expect(await readFile(path.join(fixture.root, 'human.txt'), 'utf8')).toBe('Saved human work\n');
  });

  it('retains the task and source after failed preview disconnection and completes an explicit retry', async () => {
    const a = await task();
    await writeFile(path.join(a.worktree!, 'change.txt'), 'Task work\n');
    const preview = await engine.execute('preview.connect', { connectedIds: [a.id] });
    await writeFile(path.join(preview.worktree!, 'README.md'), 'Unexpected preview edit\n');
    await expect(remove(a.id)).rejects.toMatchObject({ code: 'preview_dirty' });
    expect((await currentTasks())[0]!.deletion).toMatchObject({ phase: 'disconnecting', error: expect.any(String) });
    expect((await engine.execute('preview.get', undefined)).connectedIds).toEqual([a.id]);
    expect(await readFile(path.join(a.worktree!, 'change.txt'), 'utf8')).toBe('Task work\n');
    await expect(engine.execute('task.update', { taskId: a.id, title: 'Changed' })).rejects.toMatchObject({ code: 'task_deleting' });
    await writeFile(path.join(preview.worktree!, 'README.md'), '# fixture\n');
    await remove(a.id);
    expect(await currentTasks()).toEqual([]);
    expect((await engine.execute('preview.get', undefined)).connectedIds).toEqual([]);
  });

  it('rejects source edits occurring while preview is being disconnected', async () => {
    const a = await task();
    await writeFile(path.join(a.worktree!, 'change.txt'), 'Confirmed\n');
    await engine.execute('preview.connect', { connectedIds: [a.id] });
    const disconnect = PreviewService.prototype.disconnectTaskLocked;
    vi.spyOn(PreviewService.prototype, 'disconnectTaskLocked').mockImplementation(async function (this: PreviewService, id) {
      const result = await disconnect.call(this, id);
      await writeFile(path.join(a.worktree!, 'change.txt'), 'New agent work\n');
      return result;
    });
    await expect(remove(a.id)).rejects.toMatchObject({ code: 'task_delete_changed' });
    expect(await readFile(path.join(a.worktree!, 'change.txt'), 'utf8')).toBe('New agent work\n');
    expect((await engine.execute('preview.get', undefined)).connectedIds).toEqual([]);
  });

  it('releases clone workspaces without deleting their repository or dependencies', async () => {
    const workflow = new WorkflowService(engine.repo, engine.store);
    const clone = await workflow.start((await workflow.create({ title: 'Clone' })).id, { kind: 'clone' });
    await writeFile(path.join(clone.worktree, '.env'), 'Retained\n');
    await writeFile(path.join(clone.worktree, 'discard.txt'), 'Discard\n');
    await remove(clone.id);
    expect(await readdir(clone.worktree)).toContain('.git');
    expect(await readFile(path.join(clone.worktree, '.env'), 'utf8')).toBe('Retained\n');
    expect((await engine.execute('workspaces.list', undefined)).worktrees.find((row) => row.path === clone.worktree)).toMatchObject({
      clone: true,
      free: true,
    });
  });

  it('deletes unallocated and missing tasks without allocating or deleting a directory', async () => {
    const planned = await new WorkflowService(engine.repo, engine.store).create({ title: 'Unallocated' });
    await remove(planned.id);
    expect((await engine.execute('workspaces.list', undefined)).worktrees).toHaveLength(1);
    const created = await task();
    await rm(created.worktree!, { recursive: true });
    await remove(created.id);
    expect(await currentTasks()).toEqual([]);
    expect((await engine.execute('workspaces.list', undefined)).worktrees).toHaveLength(1);
  });

  it('preserves a legacy branch whose creation ownership is unknown', async () => {
    const created = await task();
    await engine.store.update((state) => {
      delete (state.workflow!.changes[0] as typeof created & { ownsBranch?: boolean }).ownsBranch;
    });
    expect(await remove(created.id)).toMatchObject({ retainedBranch: created.branch });
    expect(fixture.git('-C', created.worktree!, 'branch', '--list', created.branch!)).toContain(created.branch);
  });

  it('preserves base-branch commits and their task associations after deletion', async () => {
    const created = await task();
    await writeFile(path.join(created.worktree!, 'delivered.txt'), 'Delivered\n');
    const review = (await engine.execute('task.review', { taskId: created.id }))!;
    const delivered = await engine.execute('task.deliver', {
      taskId: created.id,
      ...review,
      sourceHead: review.sourceHead!,
      developmentHead: review.developmentHead!,
      message: 'Deliver saved work',
    });
    const commit = delivered.deliveries!.at(-1)!.commit;
    await remove(created.id);
    expect(fixture.git('rev-parse', 'HEAD').trim()).toBe(commit);
    expect(await readFile(path.join(fixture.root, 'delivered.txt'), 'utf8')).toBe('Delivered\n');
    expect((await engine.execute('history.get', undefined)).commits.find((row) => row.sha === commit)).toMatchObject({ changeId: created.id });
  });

  it('preserves ignored files even when discarding the task’s ignore rules makes the retained slot unavailable for reuse', async () => {
    const created = await task();
    await writeFile(path.join(created.worktree!, '.gitignore'), 'node_modules/\n.env\nlocal-cache/\n');
    await mkdir(path.join(created.worktree!, 'local-cache'));
    await writeFile(path.join(created.worktree!, 'local-cache', 'data'), 'Retain ignored data\n');
    await remove(created.id);
    expect(await readFile(path.join(created.worktree!, 'local-cache', 'data'), 'utf8')).toBe('Retain ignored data\n');
    expect((await engine.execute('workspaces.list', undefined)).worktrees.find((row) => row.path === created.worktree)).toMatchObject({ free: false });
    expect((await task('Next task')).worktree).not.toBe(created.worktree);
  });

  it('does not clean files while a live Git index operation owns the checkout', async () => {
    const created = await task();
    const lock = fixture.git('-C', created.worktree!, 'rev-parse', '--git-path', 'index.lock').trim();
    await writeFile(path.resolve(created.worktree!, lock), '');
    await writeFile(path.join(created.worktree!, 'keep.txt'), 'Do not remove\n');
    await expect(remove(created.id)).rejects.toMatchObject({ code: 'task_workspace_busy' });
    expect(await readFile(path.join(created.worktree!, 'keep.txt'), 'utf8')).toBe('Do not remove\n');
    expect((await currentTasks())[0]!.deletion).toBeUndefined();
  });

  it('preserves a nested repository obstructing a tracked file instead of letting reset overwrite it', async () => {
    const created = await task();
    const nested = path.join(created.worktree!, 'README.md');
    await rm(nested);
    await mkdir(nested);
    fixture.git('-C', nested, 'init', '-q');
    await writeFile(path.join(nested, 'keep.txt'), 'Independent repository data\n');
    await expect(remove(created.id)).rejects.toMatchObject({ code: 'task_delete_unsupported' });
    expect(await readFile(path.join(nested, 'keep.txt'), 'utf8')).toBe('Independent repository data\n');
    expect((await currentTasks())[0]!.deletion).toBeUndefined();
  });

  it('accepts a fresh confirmation after a source commit changes before workspace release', async () => {
    const created = await task();
    await writeFile(path.join(created.worktree!, 'pending.txt'), 'Task work\n');
    const preview = await engine.execute('preview.connect', { connectedIds: [created.id] });
    await writeFile(path.join(preview.worktree!, 'README.md'), 'Unexpected edit\n');
    await expect(remove(created.id)).rejects.toMatchObject({ code: 'preview_dirty' });
    fixture.git('-C', created.worktree!, 'add', 'pending.txt');
    fixture.git('-C', created.worktree!, 'commit', '-qm', 'Changed source after failed disconnection');
    await writeFile(path.join(preview.worktree!, 'README.md'), '# fixture\n');
    await remove(created.id);
    expect(await currentTasks()).toEqual([]);
  });

  it('blocks only the task with a pending primary commit, leaving unrelated tasks deletable', async () => {
    const a = await task('Pending commit');
    const b = await task('Other task');
    await writeFile(path.join(a.worktree!, 'pending.txt'), 'Pending\n');
    const review = (await engine.execute('task.review', { taskId: a.id }))!;
    await engine.execute('task.prepare', { taskId: a.id, ...review, sourceHead: review.sourceHead!, developmentHead: review.developmentHead! });
    const index = await readFile(path.join(fixture.root, '.git', 'index'));
    await expect(remove(a.id)).rejects.toMatchObject({ code: 'task_commit_pending' });
    await remove(b.id);
    expect(await readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect((await currentTasks()).map((row) => row.id)).toEqual([a.id]);
  });

  it('resumes after release fails, reserves the old slot, and never cleans a replacement checkout', async () => {
    const created = await task();
    const write = git.runGitWrite;
    vi.spyOn(git, 'runGitWrite').mockImplementation(async (args, options) => {
      if (args[0] === 'reset' && options?.cwd === created.worktree) throw new Error('Simulated reset failure');
      return write(args, options);
    });
    await expect(remove(created.id)).rejects.toThrow('Simulated reset failure');
    vi.restoreAllMocks();
    expect((await currentTasks())[0]!.deletion).toMatchObject({ phase: 'releasing' });
    const other = await task('A new task');
    expect(other.worktree).not.toBe(created.worktree);
    await engine.close();
    engine = await Engine.open(fixture.root, path.join(directory, 'state.json'));
    await rename(created.worktree!, `${fixture.root}-old`);
    await mkdir(created.worktree!);
    fixture.git('clone', '-q', fixture.root, created.worktree!);
    await expect(remove(created.id)).rejects.toMatchObject({ code: 'invalid_change_checkout' });
    await rm(created.worktree!, { recursive: true });
    await rename(`${fixture.root}-old`, created.worktree!);
    await remove(created.id);
    expect((await currentTasks()).map((row) => row.id)).toEqual([other.id]);
  });

  it('requires live connection release and removes only the deleted task’s local conversation records', async () => {
    const created = await task();
    const other = await task('Other chat');
    const bind = (id: string) => resolveAcpBinding(engine, id);
    const storage = (binding: AcpBinding) => new AcpSessionStorage(path.join(directory, 'acp'), binding, () => validateAcpBinding(engine, binding));
    const first = storage(await bind(created.id));
    const second = storage(await bind(other.id));
    const save = async (store: AcpSessionStorage, binding: AcpBinding) => {
      const record = { schemaVersion: 1 as const, id: 'conversation', binding, canLoad: false, messages: [], updatedAt: new Date().toISOString() };
      await store.save(record);
      await store.archive(record);
    };
    await save(first, await bind(created.id));
    await save(second, await bind(other.id));
    const release = await first.claim();
    expect((await engine.execute('task.deleteCheck', { taskId: created.id })).agentConnected).toBe(true);
    await expect(remove(created.id)).rejects.toMatchObject({ code: 'task_agent_connected' });
    expect((await currentTasks())[0]!.deletion).toBeUndefined();
    await release();
    await remove(created.id);
    await expect(readFile(first.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await second.load()).toBeDefined();
    await expect(first.claim()).rejects.toThrow('workspace is not ready');
  });

  it('discards a stopped task rebase while preserving the physical directory', async () => {
    const created = await task();
    await writeFile(path.join(created.worktree!, 'README.md'), 'Task branch\n');
    fixture.git('-C', created.worktree!, 'add', 'README.md');
    fixture.git('-C', created.worktree!, 'commit', '-qm', 'Task commit');
    await fixture.write('README.md', 'Primary branch\n');
    fixture.git('add', 'README.md');
    fixture.git('commit', '-qm', 'Primary commit');
    fixture.git('-C', created.worktree!, 'fetch', fixture.root, 'main');
    expect(() => fixture.git('-C', created.worktree!, 'rebase', 'FETCH_HEAD')).toThrow();
    expect((await engine.execute('task.deleteCheck', { taskId: created.id })).operation).toBe('rebase');
    await remove(created.id);
    expect((await engine.execute('workspaces.list', undefined)).worktrees.find((row) => row.path === created.worktree)).toMatchObject({ free: true });
    expect(await readFile(path.join(fixture.root, 'README.md'), 'utf8')).toBe('Primary branch\n');
  });
});
