import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpBinding, DevelopmentChange, RebaseBatchRequest } from '@warden/shared';
import { Engine } from '../packages/engine/src/engine.js';
import { StateStore } from '../packages/engine/src/state.js';
import * as backups from '../packages/engine/src/backups.js';
import { AcpSessionStorage } from '../packages/vscode/src/acp/storage.js';
import { resolveAcpBinding } from '../packages/vscode/src/acp/binding.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let directory: string;
let engine: Engine;
let task: DevelopmentChange;
let binding: AcpBinding;
let request: RebaseBatchRequest;
let original: string;
const head = () => fx.git('-C', task.worktree, 'rev-parse', 'HEAD').trim();
const storage = (validateClaim?: () => Promise<void>) => new AcpSessionStorage(path.join(directory, 'acp'), binding, validateClaim);

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-automatic-rebase-');
  directory = await mkdtemp(path.join(os.tmpdir(), 'warden-automatic-rebase-data-'));
  engine = await Engine.open(fx.root, path.join(directory, 'state.json'));
  await engine.execute('workflow.configure', { branch: 'main' });
  const created = await engine.execute('task.create', { title: 'Keep agent activity separate from rebase' });
  if (!created.worktree) throw new Error(created.workspaceError?.message ?? 'Missing task workspace');
  task = created;
  await writeFile(path.join(task.worktree, 'task.txt'), 'Task commit\n');
  fx.git('-C', task.worktree, 'add', '.');
  fx.git('-C', task.worktree, 'commit', '-qm', 'Task progress');
  original = head();
  await fx.write('primary.txt', 'New primary baseline\n');
  fx.git('add', '.');
  fx.git('commit', '-qm', 'Advance primary');
  binding = await resolveAcpBinding(engine, task.id);
  const check = (await engine.execute('rebase.check', undefined)).checks.find((row) => row.changeId === task.id)!;
  expect(check.status).toBe('ready');
  request = { automatic: true, items: [{ changeId: task.id, sourceHead: check.sourceHead, developmentHead: check.developmentHead }] };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine?.close();
  if (task?.worktree) await rm(task.worktree, { recursive: true, force: true });
  await fx.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe('automatic rebase connection ownership', () => {
  it.each(['unreserved', 'foreign'] as const)('skips a live %s connection without changing the workspace', async (kind) => {
    const record = storage();
    const release = await record.claim();
    const owner = JSON.parse(await readFile(record.ownerFile, 'utf8'));
    if (kind === 'foreign') {
      await writeFile(record.ownerFile, JSON.stringify({ ...owner, hostname: `${os.hostname()}-other-host` }));
      request.items[0]!.connectionToken = owner.token;
    }
    const index = await readFile(path.join(task.worktree, '.git', 'index'));
    const backup = vi.spyOn(backups, 'createSafetyBackup');
    try {
      expect((await engine.execute('task.deleteCheck', { taskId: task.id })).agentConnected).toBe(true);
      const result = await engine.execute('rebase.run', request, { developmentBranch: 'main' });
      expect(result.results).toEqual([{ changeId: task.id, status: 'skipped', message: expect.stringContaining('idle state cannot be verified') }]);
      expect(head()).toBe(original);
      expect(await readFile(path.join(task.worktree, '.git', 'index'))).toEqual(index);
      expect(fx.git('-C', task.worktree, 'status', '--porcelain')).toBe('');
      expect(backup).not.toHaveBeenCalled();
    } finally {
      await writeFile(record.ownerFile, JSON.stringify(owner));
      await release();
    }
  });

  it('rebases an idle connection reserved by the owning host without releasing its claim', async () => {
    const record = storage();
    const release = await record.claim();
    const owner = JSON.parse(await readFile(record.ownerFile, 'utf8'));
    request.items[0]!.connectionToken = owner.token;
    try {
      expect((await engine.execute('rebase.run', request)).results).toEqual([{ changeId: task.id, status: 'updated' }]);
      expect(head()).not.toBe(original);
      expect(fx.git('-C', task.worktree, 'rev-parse', 'HEAD^').trim()).toBe(request.items[0]!.developmentHead);
      expect(JSON.parse(await readFile(record.ownerFile, 'utf8'))).toEqual(owner);
      expect((await engine.execute('task.deleteCheck', { taskId: task.id })).agentConnected).toBe(true);
    } finally {
      await release();
    }
  });

  it.each(['replaced', 'removed'] as const)('rejects a %s claim after an automatic request has queued for the repository lock', async (change) => {
    const first = storage();
    const releaseFirst = await first.claim();
    request.items[0]!.connectionToken = JSON.parse(await readFile(first.ownerFile, 'utf8')).token;
    let unlock!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => (entered = resolve));
    const lock = new StateStore(engine.store.file, fx.root).withRepositoryLock(async () => {
      entered();
      await new Promise<void>((resolve) => (unlock = resolve));
    });
    await enteredLock;
    const pending = engine.execute('rebase.run', request);
    let releaseSecond: (() => Promise<void>) | undefined;
    try {
      await releaseFirst();
      if (change === 'replaced') releaseSecond = await storage().claim();
    } finally {
      unlock();
      await lock;
    }
    try {
      expect((await pending).results[0]).toMatchObject({ status: 'skipped' });
      expect(head()).toBe(original);
    } finally {
      await releaseSecond?.();
    }
  });

  it('blocks explicit rebase and setup retry while an earlier setup still has a live owner', async () => {
    await engine.store.update((state) => {
      const current = state.workflow!.changes.find((row) => row.id === task.id)!;
      if (!current.worktree) throw new Error('Missing task workspace');
      current.workspaceHook = { event: 'create', command: 'setup', status: 'running', owner: { pid: process.pid, hostname: os.hostname() } };
    });
    const { automatic: _automatic, ...explicit } = request;
    expect((await engine.execute('rebase.run', explicit)).results[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('setup') });
    await expect(engine.execute('task.hook', { taskId: task.id })).rejects.toMatchObject({ code: 'setup_running' });
    expect(head()).toBe(original);
  });

  it('keeps new connection claims outside an automatic rebase until Git has finished', async () => {
    const createBackup = backups.createSafetyBackup;
    let resume!: () => void;
    let entered!: () => void;
    const backingUp = new Promise<void>((resolve) => (entered = resolve));
    vi.spyOn(backups, 'createSafetyBackup').mockImplementation(async (...args) => {
      entered();
      await new Promise<void>((resolve) => (resume = resolve));
      return createBackup(...args);
    });
    const pending = engine.execute('rebase.run', request);
    await backingUp;
    let claimHead: string | undefined;
    const claiming = storage(async () => {
      claimHead = head();
    }).claim();
    // Let the independent claimant attempt its real filesystem lock while backup is held.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const observedWhileHeld = claimHead;
    resume();
    const result = await pending;
    const release = await claiming;
    try {
      expect(observedWhileHeld).toBeUndefined();
      expect(result.results[0]).toMatchObject({ status: 'updated' });
      expect(claimHead).toBe(head());
      expect(claimHead).not.toBe(original);
    } finally {
      await release();
    }
  });
});
