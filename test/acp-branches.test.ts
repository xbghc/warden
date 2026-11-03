import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine, WorkflowService } from '@warden/engine';
import type { AcpBinding } from '@warden/shared';
import { resolveAcpBinding, validateAcpBinding } from '../packages/vscode/src/acp/binding.js';
import { AcpSession } from '../packages/vscode/src/acp/session.js';
import { AcpSessionStorage } from '../packages/vscode/src/acp/storage.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

const agent = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const timeout = process.platform === 'win32' ? 90_000 : 45_000;
const sessions: AcpSession[] = [];
const engines: Engine[] = [];
const workspaces = new Set<string>();
let fixture: FixtureRepo;
let directory: string;
let engine: Engine;

async function openEngine() {
  const opened = await Engine.open(fixture.root, path.join(directory, 'state.json'));
  engines.push(opened);
  return opened;
}

beforeEach(async () => {
  fixture = await makeFixtureRepo('warden-acp-branches-');
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-acp-branches-data-')));
  engine = await openEngine();
  await engine.execute('workflow.configure', { branch: 'main' });
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(engines.splice(0).map((opened) => opened.close()));
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
  workspaces.clear();
  await fixture.cleanup();
  await rm(directory, { recursive: true, force: true });
});

async function allocate(title: string, kind: 'shared' | 'clone' = 'shared') {
  const plan = await new WorkflowService(engine.repo, engine.store).create({ title });
  const task = await engine.execute('task.start', { taskId: plan.id, kind });
  workspaces.add(task.worktree);
  return task;
}

async function conversation(binding: AcpBinding, owner = engine) {
  const file = path.join(directory, `${binding.taskId}.jsonl`);
  const validate = () => validateAcpBinding(owner, binding);
  const storage = new AcpSessionStorage(path.join(directory, 'acp'), binding, validate);
  const session = new AcpSession({ binding, storage, validate, changed: () => {}, timeoutMs: timeout });
  const profile = { id: 'fixture', label: 'Fixture', command: process.execPath, args: [agent, file] };
  const journal = async () =>
    (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { pid: number; cwd: string; method?: string; params?: { sessionId?: string; cwd?: string } });
  sessions.push(session);
  await session.initialize();
  return { session, storage, profile, journal };
}

const transcript = (session: AcpSession) => session.snapshot().record.messages.map(({ role, text }) => ({ role, text }));

describe('task conversations across primary branch changes', () => {
  it.each(['shared', 'clone'] as const)(
    'keeps a %s task session and pending permission through branch changes and restores it from disk on another branch',
    { timeout },
    async (kind) => {
      const task = await allocate('Original requirement', kind);
      const binding = await resolveAcpBinding(engine, task.id);
      const chat = await conversation(binding);
      await chat.session.connect(chat.profile, { resume: false });
      await chat.session.send('Remember the original requirement');
      const before = chat.session.snapshot().record;
      const turn = chat.session.send('permission');
      void turn.catch(() => {});
      await expect.poll(() => chat.session.snapshot().permissions.length, { timeout: 15_000 }).toBe(1);
      const permission = chat.session.snapshot().permissions[0]!;
      const primaryHead = fixture.git('rev-parse', 'HEAD').trim();

      // A different Engine represents the workbench or another window changing the shared context.
      const navigation = await openEngine();
      fixture.git('switch', '-qc', 'feature/other');
      await navigation.execute('workflow.configure', { branch: 'feature/other' });
      const other = await allocate('Other requirement', kind);
      expect(fixture.git('rev-parse', 'HEAD').trim()).toBe(primaryHead);
      fixture.git('commit', '--allow-empty', '-qm', 'Advance the other requirement');
      const savedTasks = (await engine.store.load()).workflow!.changes;

      for (const args of [
        ['switch', 'feature/other'],
        ['switch', '-c', 'untracked'],
        ['switch', '--detach'],
        ['switch', 'feature/other'],
      ]) {
        fixture.git(...args);
        await validateAcpBinding(engine, binding);
        expect(chat.session.snapshot()).toMatchObject({
          status: 'waiting_permission',
          record: { id: before.id, sessionId: before.sessionId, binding },
          permissions: [{ id: permission.id }],
        });
        expect((await engine.store.load()).workflow!.changes).toEqual(savedTasks);
        expect(fixture.git('-C', task.worktree, 'branch', '--show-current').trim()).toBe(task.branch);
        expect(fixture.git('-C', task.worktree, 'rev-parse', 'HEAD').trim()).toBe(primaryHead);
      }

      await chat.session.respondPermission(permission.id, 'allow-once');
      await turn;
      expect(await readFile(path.join(task.worktree, 'agent-output.txt'), 'utf8')).toBe('Permission granted\n');
      await expect(access(path.join(fixture.root, 'agent-output.txt'))).rejects.toThrow();
      await expect(access(path.join(other.worktree, 'agent-output.txt'))).rejects.toThrow();
      const history = transcript(chat.session);
      await chat.session.close();
      await engine.close();

      const reopened = await openEngine();
      const restoredBinding = await resolveAcpBinding(reopened, task.id);
      expect(restoredBinding).toEqual(binding);
      const restored = await conversation(restoredBinding, reopened);
      expect(transcript(restored.session)).toEqual(history);
      await restored.session.connect(restored.profile, { resume: true });
      expect(restored.session.snapshot().record.sessionId).toBe(before.sessionId);
      expect(transcript(restored.session)).toEqual(history);
      const requests = await restored.journal();
      expect(requests.filter((row) => row.method === 'session/new')).toHaveLength(1);
      expect(requests.filter((row) => row.method === 'session/prompt')).toHaveLength(2);
      expect(requests.filter((row) => row.method === 'session/load')).toEqual([
        expect.objectContaining({ cwd: task.worktree, params: { sessionId: before.sessionId, cwd: task.worktree, mcpServers: [] } }),
      ]);
      expect(requests.every((row) => row.cwd === task.worktree)).toBe(true);

      fixture.git('switch', 'main');
      await reopened.execute('workflow.configure', { branch: 'main' });
      await restored.session.send('Continue the original requirement');
      expect(transcript(restored.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: Continue the original requirement' });
      expect(fixture.git('status', '--porcelain')).toBe('');
    },
  );

  it.each(['unrelated branch', 'detached HEAD'])(
    'refuses permission and prompt delivery after the task workspace moves to %s without losing the saved session',
    { timeout },
    async (destination) => {
      const task = await allocate('Task with changed workspace');
      const binding = await resolveAcpBinding(engine, task.id);
      const chat = await conversation(binding);
      await chat.session.connect(chat.profile, { resume: false });
      const sessionId = chat.session.snapshot().record.sessionId;
      const turn = chat.session.send('permission');
      void turn.catch(() => {});
      await expect.poll(() => chat.session.snapshot().permissions.length, { timeout: 15_000 }).toBe(1);
      const permission = chat.session.snapshot().permissions[0]!;
      fixture.git('-C', task.worktree, 'switch', ...(destination === 'detached HEAD' ? ['--detach'] : ['-c', 'unrelated-task']));
      await expect(chat.session.respondPermission(permission.id, 'allow-once')).rejects.toThrow('The task workspace changed');
      await turn;
      await expect(access(path.join(task.worktree, 'agent-output.txt'))).rejects.toThrow();
      const history = transcript(chat.session);
      await expect(chat.session.send('Do not send to this checkout')).rejects.toThrow('The task workspace changed');
      expect(transcript(chat.session)).toEqual(history);
      expect((await chat.journal()).filter((row) => row.method === 'session/prompt')).toHaveLength(1);
      await chat.session.close();

      fixture.git('-C', task.worktree, 'switch', task.branch);
      const restored = await conversation(await resolveAcpBinding(engine, task.id));
      expect(transcript(restored.session)).toEqual(history);
      await restored.session.connect(restored.profile, { resume: true });
      expect(restored.session.snapshot().record.sessionId).toBe(sessionId);
      await restored.session.send('Continue after restoring the task branch');
      expect(transcript(restored.session).at(-1)?.text).toBe('Echo: Continue after restoring the task branch');
    },
  );

  it.each(['renamed', 'deleted'])(
    'retains the task conversation when its primary base branch is %s without migrating the requirement',
    { timeout },
    async (change) => {
      const task = await allocate('Task on a missing base branch');
      const binding = await resolveAcpBinding(engine, task.id);
      const chat = await conversation(binding);
      await chat.session.connect(chat.profile, { resume: false });
      await chat.session.send('Remember this requirement');
      const sessionId = chat.session.snapshot().record.sessionId;
      fixture.git('switch', '-c', 'other');
      if (change === 'renamed') fixture.git('branch', '-m', 'main', 'renamed-main');
      else fixture.git('branch', '-D', 'main');
      const workflow = await engine.execute('workflow.get', undefined);
      expect(workflow.error).toBeTruthy();
      expect(workflow.workflow?.developmentBranch).toBe('main');
      expect(workflow.workflow?.changes.find((row) => row.id === task.id)?.developmentBranch).toBe('main');
      expect(await resolveAcpBinding(engine, task.id)).toEqual(binding);
      await chat.session.send('Continue in the original task workspace');
      expect(chat.session.snapshot().record.sessionId).toBe(sessionId);
      expect(transcript(chat.session).at(-1)?.text).toBe('Echo: Continue in the original task workspace');
      expect(fixture.git('-C', task.worktree, 'branch', '--show-current').trim()).toBe(task.branch);
    },
  );
});
