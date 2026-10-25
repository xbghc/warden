import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpBinding, AcpRecord } from '@warden/shared';
import type { AcpProfile, AcpStorage } from '../packages/vscode/src/acp/contracts.js';
import { AcpSession } from '../packages/vscode/src/acp/session.js';
import { AcpSessionStorage } from '../packages/vscode/src/acp/storage.js';

const agent = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const sessions: AcpSession[] = [];
let directory: string;
let primary: string;

class MemoryStorage implements AcpStorage {
  record?: AcpRecord;
  archived: AcpRecord[] = [];
  claimed = false;
  async load() {
    return this.record ? structuredClone(this.record) : undefined;
  }
  async save(record: AcpRecord) {
    this.record = structuredClone(record);
  }
  async archive(record: AcpRecord) {
    this.archived.push(structuredClone(record));
  }
  async claim() {
    if (this.claimed) throw new Error('Conversation already has an owner');
    this.claimed = true;
    return async () => {
      this.claimed = false;
    };
  }
}

interface WireMessage {
  pid: number;
  cwd: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { outcome?: { outcome: string; optionId?: string } };
  error?: { code: number; message: string };
}

async function journal(file: string): Promise<WireMessage[]> {
  return (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function fixture(name = 'task', mode = 'normal', timeoutMs = 15_000) {
  const workspace = path.join(directory, name);
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'context.txt'), `${name} context\n`);
  const file = path.join(directory, `${name}.wire`);
  const binding: AcpBinding = { repository: primary, taskId: name, title: name, workspace, branch: `agent/${name}`, identity: `allocation-${name}` };
  const profile: AcpProfile = { id: `fixture-${name}`, label: 'Fixture ACP agent', command: process.execPath, args: [agent, file, mode] };
  const storage = new MemoryStorage();
  const validate = vi.fn(async () => {});
  const changed = vi.fn();
  const create = (persistence: AcpStorage = storage) => {
    const session = new AcpSession({ binding, storage: persistence, validate, changed, timeoutMs });
    sessions.push(session);
    return session;
  };
  const session = create();
  await session.initialize();
  return { session, create, profile, storage, validate, changed, workspace, file, binding };
}

function transcript(session: AcpSession) {
  return session
    .snapshot()
    .record.messages.filter((message) => message.role === 'user' || message.role === 'agent')
    .map(({ role, text }) => ({ role, text }));
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-acp-')));
  primary = path.join(directory, 'primary');
  await mkdir(primary);
  await writeFile(path.join(primary, 'human.txt'), 'Human baseline\n');
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await rm(directory, { recursive: true, force: true });
});

describe('ACP subprocess conversations', () => {
  it('launches only on explicit connect and leaves the agent responsible for its own task file operations', async () => {
    const f = await fixture();
    expect(await journal(f.file)).toEqual([]);
    expect(f.session.snapshot().status).toBe('disconnected');
    await f.session.connect(f.profile, { resume: false });
    const wire = await journal(f.file);
    expect(wire.find((message) => message.method === 'initialize')?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(wire.find((message) => message.method === 'session/new')?.params).toMatchObject({ cwd: f.workspace, mcpServers: [] });
    expect(wire.every((message) => path.resolve(message.cwd) === path.resolve(f.workspace))).toBe(true);
    await f.session.send('own-edit');
    expect(await readFile(path.join(f.workspace, 'agent-output.txt'), 'utf8')).toMatch(/^task context edited by \d+\n$/);
    expect(await readFile(path.join(primary, 'human.txt'), 'utf8')).toBe('Human baseline\n');
    expect(await readdir(primary)).toEqual(['human.txt']);
    expect(transcript(f.session)).toEqual([
      { role: 'user', text: 'own-edit' },
      { role: 'agent', text: `Edited ${f.workspace}` },
    ]);
    expect(f.session.snapshot().status).toBe('connected');
    expect(f.validate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.changed).toHaveBeenCalled();
  });

  it('persists oversized tool IDs without losing update identity or retaining the conversation owner', async () => {
    const f = await fixture();
    const storage = new AcpSessionStorage(path.join(directory, 'data'), f.binding);
    const session = f.create(storage);
    await session.initialize();
    await session.connect(f.profile, { resume: false });
    await session.send('long-tool-id');
    const tools = session.snapshot().record.messages.filter((message) => message.role === 'tool');
    expect(tools.map((message) => [message.text, message.status])).toEqual([
      ['Finished one', 'completed'],
      ['Finished two', 'completed'],
    ]);
    expect(new Set(tools.map((message) => message.toolCallId)).size).toBe(2);
    expect(tools.every((message) => message.toolCallId && message.toolCallId.length <= 4096)).toBe(true);
    const saved = await storage.load();
    expect(saved?.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(
      tools.map((message) => message.toolCallId),
    );
    await session.disconnect();
    await expect(readFile(storage.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const release = await new AcpSessionStorage(path.join(directory, 'data'), f.binding).claim();
    await release();
  });

  it('replaces tool content independently of its title across live updates and restored sessions', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    const observed: string[] = [];
    f.changed.mockImplementation(() => {
      const progress = f.session.snapshot().record.messages.find((message) => message.toolCallId === 'progress');
      if (progress) observed.push(progress.text);
    });
    await f.session.send('tool-progress');
    expect(observed).toContain('Run tests\nFinal output');
    const expected = [
      { toolCallId: 'progress', text: 'Tests completed\nFinal output', status: 'completed' },
      { toolCallId: 'clear', text: 'Clear output', status: 'completed' },
    ];
    const tools = (session: AcpSession) =>
      session
        .snapshot()
        .record.messages.filter((message) => message.role === 'tool')
        .map(({ toolCallId, text, status }) => ({ toolCallId, text, status }));
    expect(tools(f.session)).toEqual(expected);
    await f.session.disconnect();
    f.changed.mockReset();
    const restored = f.create();
    await restored.initialize();
    expect(tools(restored)).toEqual(expected);
    await restored.connect(f.profile, { resume: true });
    expect(tools(restored)).toEqual(expected);
    await restored.send('tool-refresh');
    expect(tools(restored)).toEqual([{ ...expected[0], text: 'Tests completed\nFollow-up output' }, expected[1]]);
  });

  it('bounds escaped JSON bytes before real storage writes and can release ownership after a large streamed response', async () => {
    const f = await fixture();
    const storage = new AcpSessionStorage(path.join(directory, 'data'), f.binding);
    const session = f.create(storage);
    await session.initialize();
    await session.connect(f.profile, { resume: false });
    await session.send('expanded-controls');
    const saved = await storage.load();
    expect((await readFile(storage.file)).length).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(saved?.messages.some((message) => message.text.includes('\u0000'))).toBe(true);
    expect(saved?.messages.some((message) => message.status === 'history_truncated')).toBe(true);
    expect(saved?.messages.find((message) => message.role === 'user' && message.text === 'expanded-controls')).toMatchObject({ uncertain: false });
    expect(saved?.messages.at(-1)?.text).toBe('Control stream complete');
    await session.disconnect();
    await expect(readFile(storage.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = f.create(new AcpSessionStorage(path.join(directory, 'data'), f.binding));
    await restored.initialize();
    expect(restored.snapshot().record.messages.at(-1)?.text).toBe('Control stream complete');
  });

  it('rejects an incompatible protocol before creating an agent session and releases ownership', async () => {
    const f = await fixture('task', 'incompatible');
    await expect(f.session.connect(f.profile, { resume: false })).rejects.toThrow();
    expect((await journal(f.file)).map((message) => message.method)).toEqual(['initialize']);
    expect(f.session.snapshot().status).toBe('error');
    expect(f.storage.claimed).toBe(false);
  });

  it('releases ownership when the configured executable cannot start', async () => {
    const f = await fixture();
    await expect(f.session.connect({ ...f.profile, command: path.join(directory, 'missing-agent') }, { resume: false })).rejects.toThrow();
    expect(f.session.snapshot().status).toBe('error');
    expect(f.storage.claimed).toBe(false);
    expect(await journal(f.file)).toEqual([]);
    await f.session.connect(f.profile, { resume: false });
    expect(f.session.snapshot().status).toBe('connected');
  });

  it('rejects a second live owner without launching or disturbing the first conversation', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('first owner');
    const second = f.create();
    await second.initialize();
    const wire = await journal(f.file);
    await expect(second.connect(f.profile, { resume: true })).rejects.toThrow('Conversation already has an owner');
    expect(await journal(f.file)).toEqual(wire);
    expect(f.storage.claimed).toBe(true);
    await f.session.send('still connected');
    expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: still connected' });
  });

  it('returns only an actually offered permission option and preserves the pending request after an invalid choice', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    const sent = f.session.send('permission');
    await expect.poll(() => f.session.snapshot().permissions.length, { timeout: 5_000 }).toBe(1);
    const permission = f.session.snapshot().permissions[0]!;
    expect(permission.options.map((option) => option.id)).toEqual(['allow-once', 'reject-once']);
    expect(f.session.snapshot().status).toBe('waiting_permission');
    await expect(f.session.respondPermission(permission.id, 'invented-allow')).rejects.toThrow();
    expect(f.session.snapshot().permissions).toHaveLength(1);
    expect((await journal(f.file)).some((message) => message.result?.outcome)).toBe(false);
    await f.session.respondPermission(permission.id, 'allow-once');
    await sent;
    expect((await journal(f.file)).find((message) => message.result?.outcome)?.result?.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    expect(await readFile(path.join(f.workspace, 'agent-output.txt'), 'utf8')).toBe('Permission granted\n');
    expect(f.session.snapshot().permissions).toEqual([]);
  });

  it('cancels both the active turn and pending permissions without granting a write', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    const sent = f.session.send('permission');
    await expect.poll(() => f.session.snapshot().permissions.length, { timeout: 5_000 }).toBe(1);
    const permission = f.session.snapshot().permissions[0]!;
    await f.session.cancel();
    await sent;
    const wire = await journal(f.file);
    expect(wire.some((message) => message.method === 'session/cancel')).toBe(true);
    expect(wire.find((message) => message.result?.outcome)?.result?.outcome).toEqual({ outcome: 'cancelled' });
    expect(f.session.snapshot().permissions).toEqual([]);
    await expect(f.session.respondPermission(permission.id, 'allow-once')).rejects.toThrow();
    await expect(readFile(path.join(f.workspace, 'agent-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a permission response when the task allocation changed while approval was pending', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    const sent = f.session.send('permission');
    await expect.poll(() => f.session.snapshot().permissions.length, { timeout: 5_000 }).toBe(1);
    const permission = f.session.snapshot().permissions[0]!;
    f.validate.mockRejectedValueOnce(new Error('Workspace allocation changed'));
    await expect(f.session.respondPermission(permission.id, 'allow-once')).rejects.toThrow('Workspace allocation changed');
    await sent;
    expect((await journal(f.file)).find((message) => message.result?.outcome)?.result?.outcome).toEqual({ outcome: 'cancelled' });
    await expect(readFile(path.join(f.workspace, 'agent-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps concurrent tasks, identical agent request IDs and permission responses separate', async () => {
    const [a, b] = await Promise.all([fixture('one'), fixture('two')]);
    await Promise.all([a.session.connect(a.profile, { resume: false }), b.session.connect(b.profile, { resume: false })]);
    const sentA = a.session.send('permission');
    const sentB = b.session.send('permission');
    await expect.poll(() => a.session.snapshot().permissions.length + b.session.snapshot().permissions.length, { timeout: 5_000 }).toBe(2);
    expect(a.session.snapshot().record.sessionId).not.toBe(b.session.snapshot().record.sessionId);
    await a.session.respondPermission(a.session.snapshot().permissions[0]!.id, 'allow-once');
    await sentA;
    expect(b.session.snapshot().status).toBe('waiting_permission');
    expect(b.session.snapshot().permissions).toHaveLength(1);
    await expect(readFile(path.join(b.workspace, 'agent-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await b.session.respondPermission(b.session.snapshot().permissions[0]!.id, 'reject-once');
    await sentB;
    expect(await readFile(path.join(a.workspace, 'agent-output.txt'), 'utf8')).toBe('Permission granted\n');
    expect((await journal(a.file)).every((message) => path.resolve(message.cwd) === a.workspace)).toBe(true);
    expect((await journal(b.file)).every((message) => path.resolve(message.cwd) === b.workspace)).toBe(true);
  });

  it('loads history only explicitly and preserves repeated equal messages across different replay chunk boundaries', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('same');
    await f.session.send('same');
    const expected = transcript(f.session);
    expect(expected.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(expected.filter((message) => message.role === 'agent')).toHaveLength(2);
    await f.session.disconnect();
    const previous = await journal(f.file);
    const restored = f.create();
    await restored.initialize();
    expect(await journal(f.file)).toEqual(previous);
    expect(transcript(restored)).toEqual(expected);
    await restored.connect(f.profile, { resume: true });
    expect(transcript(restored)).toEqual(expected);
    const requests = await journal(f.file);
    expect(requests.filter((message) => message.method === 'session/load')).toHaveLength(1);
    expect(requests.filter((message) => message.method === 'session/prompt')).toHaveLength(2);
    await restored.send('next');
    expect(transcript(restored).at(-1)).toEqual({ role: 'agent', text: 'Echo: next' });
  });

  it('requires a new conversation when the agent cannot load and archives rather than silently resending the old transcript', async () => {
    const f = await fixture('task', 'no-load');
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('remember me');
    const expected = transcript(f.session);
    const id = f.session.snapshot().record.id;
    await f.session.disconnect();
    await expect(f.session.connect(f.profile, { resume: true })).rejects.toThrow();
    expect(transcript(f.session)).toEqual(expected);
    expect((await journal(f.file)).filter((message) => message.method === 'session/load')).toEqual([]);
    await f.session.newConversation();
    expect(f.session.snapshot().record.id).not.toBe(id);
    expect(f.storage.archived.some((record) => record.id === id)).toBe(true);
    await f.session.connect(f.profile, { resume: false });
    expect((await journal(f.file)).filter((message) => message.method === 'session/prompt')).toHaveLength(1);
    expect(transcript(f.session)).toEqual([]);
  });

  it('retains local history when an advertised session load fails', async () => {
    const f = await fixture('task', 'load-fails');
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('saved locally');
    const expected = transcript(f.session);
    await f.session.disconnect();
    await expect(f.session.connect(f.profile, { resume: true })).rejects.toThrow();
    expect(transcript(f.session)).toEqual(expected);
    expect((await journal(f.file)).filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  });

  it('authenticates only a supported advertised method and starts no prompt during login', async () => {
    const f = await fixture('task', 'auth');
    await expect(f.session.connect(f.profile, { resume: false })).rejects.toThrow();
    expect(f.session.snapshot().authMethods.some((method) => method.id === 'login')).toBe(true);
    await expect(f.session.authenticate('invented')).rejects.toThrow();
    await expect(f.session.authenticate('terminal-login')).rejects.toThrow();
    expect((await journal(f.file)).filter((message) => message.method === 'authenticate')).toEqual([]);
    await f.session.authenticate('login');
    expect(f.session.snapshot().status).toBe('connected');
    expect((await journal(f.file)).filter((message) => message.method === 'authenticate').map((message) => message.params)).toEqual([{ methodId: 'login' }]);
    expect((await journal(f.file)).some((message) => message.method === 'session/prompt')).toBe(false);
    await f.session.send('authenticated');
    expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: authenticated' });
  });

  it('retries an authenticated load and restores replay before allowing the next prompt', async () => {
    const f = await fixture('task', 'auth');
    await expect(f.session.connect(f.profile, { resume: false })).rejects.toThrow();
    await f.session.authenticate('login');
    await f.session.send('before login again');
    const expected = transcript(f.session);
    await f.session.disconnect();
    await expect(f.session.connect(f.profile, { resume: true })).rejects.toThrow();
    await f.session.authenticate('login');
    expect((await journal(f.file)).filter((message) => message.method === 'session/load')).toHaveLength(2);
    expect(transcript(f.session)).toEqual(expected);
    await f.session.send('after login again');
    expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: after login again' });
  });

  it('stops a timed-out authenticated load before a fresh connection can replay history', async () => {
    const f = await fixture('task', 'auth-delayed-load', 5_000);
    await expect(f.session.connect(f.profile, { resume: false })).rejects.toThrow();
    await f.session.authenticate('login');
    await f.session.send('confirmed before timeout');
    const expected = transcript(f.session);
    await f.session.disconnect();

    await expect(f.session.connect(f.profile, { resume: true })).rejects.toThrow();
    await expect(f.session.authenticate('login')).rejects.toThrow('恢复会话超时');
    const timedOutPid = Number(await readFile(`${f.file}.delayed-load`, 'utf8'));
    expect(f.session.snapshot().status).toBe('error');
    expect(f.storage.claimed).toBe(false);
    expect(transcript(f.session)).toEqual(expected);
    const afterTimeout = await journal(f.file);
    await expect(f.session.authenticate('login')).rejects.toThrow();
    await expect(f.session.send('must not be sent on the timed-out connection')).rejects.toThrow();
    expect(await journal(f.file)).toEqual(afterTimeout);

    await expect(f.session.connect(f.profile, { resume: true })).rejects.toThrow();
    await f.session.authenticate('login');
    const restoredRequests = await journal(f.file);
    const restoredLoad = restoredRequests.filter((message) => message.method === 'session/load').at(-1)!;
    expect(restoredLoad.pid).not.toBe(timedOutPid);
    expect(f.session.snapshot().status).toBe('connected');
    expect(transcript(f.session)).toEqual(expected);
    expect(JSON.stringify(f.session.snapshot())).not.toContain('TIMED_OUT_REPLAY');
    expect(restoredRequests.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
    await f.session.send('fresh process');
    expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: fresh process' });
  });

  it('reloads the latest owned history when another window updated the same conversation and loading is unavailable', async () => {
    const f = await fixture('task', 'no-load');
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('initial message');
    const other = f.create();
    await other.initialize();
    await f.session.send('written after the other window opened');
    const latest = transcript(f.session);
    await f.session.disconnect();
    await expect(other.connect(f.profile, { resume: true })).rejects.toThrow();
    expect(transcript(other)).toEqual(latest);
    expect(f.storage.record?.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect((await journal(f.file)).filter((message) => message.method === 'session/prompt')).toHaveLength(2);
  });

  it('does not resurrect a stale record after another window explicitly starts a new conversation', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('old conversation');
    const other = f.create();
    await other.initialize();
    const oldId = other.snapshot().record.id;
    await f.session.newConversation();
    const replacementId = f.session.snapshot().record.id;
    expect(replacementId).not.toBe(oldId);
    const wire = await journal(f.file);
    await expect(other.connect(f.profile, { resume: true })).rejects.toThrow();
    expect(await journal(f.file)).toEqual(wire);
    expect(other.snapshot().record.id).toBe(replacementId);
    expect(f.storage.record?.id).toBe(replacementId);
    expect(transcript(other)).toEqual([]);
  });

  it('ignores foreign session updates and rejects unsupported client callbacks', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('wrong-session');
    expect(JSON.stringify(f.session.snapshot())).not.toContain('WRONG_SESSION_OUTPUT');
    await f.session.send('foreign-permission');
    expect(f.session.snapshot().permissions).toEqual([]);
    expect((await journal(f.file)).find((message) => message.result?.outcome)?.result?.outcome).toEqual({ outcome: 'cancelled' });
    await f.session.send('unsupported-client');
    expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Unsupported callback: -32601' });
  });

  it('recovers from an invalid JSON line through the SDK parse-error response without losing the active turn', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    await f.session.send('recoverable-json');
    expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: recoverable-json' });
    await expect.poll(async () => (await journal(f.file)).some((message) => message.error?.code === -32700), { timeout: 5_000 }).toBe(true);
    expect(f.session.snapshot().status).toBe('connected');
  });

  it('allows only one active prompt per task and cancellation does not queue the rejected prompt', async () => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    const sent = f.session.send('hold');
    await expect.poll(async () => (await journal(f.file)).some((message) => message.method === 'session/prompt'), { timeout: 5_000 }).toBe(true);
    await expect(f.session.send('must not be queued')).rejects.toThrow();
    await f.session.cancel();
    await sent;
    expect((await journal(f.file)).filter((message) => message.method === 'session/prompt')).toHaveLength(1);
    expect(transcript(f.session).some((message) => message.text === 'must not be queued')).toBe(false);
  });

  it.each(['cancel', 'disconnect'] as const)('settles a pre-send %s exposed by a pending render while saving the prompt', async (action) => {
    const f = await fixture();
    vi.spyOn(f.storage, 'save').mockImplementation(async (record) => {
      if (record.messages.some((message) => message.status === '发送中')) await new Promise((resolve) => setTimeout(resolve, 150));
      f.storage.record = structuredClone(record);
    });
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    let requested = false;
    const stopped = new Promise<void>((resolve, reject) => {
      // Connecting schedules a panel render that can observe the next send while
      // its initial save is pending, before runPrompt reaches its own notification.
      f.changed.mockImplementation(() => {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
          renderTimer = undefined;
          if (requested || f.session.snapshot().status !== 'running') return;
          requested = true;
          void f.session[action]().then(resolve, reject);
        }, 40);
      });
    });
    try {
      await f.session.connect(f.profile, { resume: false });
      const sent = f.session.send('cancel before delivery');
      await Promise.all([sent, stopped]);
    } finally {
      clearTimeout(renderTimer);
      f.changed.mockReset();
    }
    expect(requested).toBe(true);
    expect(f.session.snapshot()).toMatchObject({
      status: action === 'cancel' ? 'connected' : 'disconnected',
      record: {
        interrupted: false,
        messages: [{ role: 'user', text: 'cancel before delivery', status: '发送前已取消', uncertain: false }],
      },
    });
    expect(f.storage.record?.messages[0]).toMatchObject({ status: '发送前已取消', uncertain: false });
    expect((await journal(f.file)).some((message) => message.method === 'session/prompt' || message.method === 'session/cancel')).toBe(false);
    if (action === 'cancel') {
      await f.session.send('next prompt');
      expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: next prompt' });
    }
  });

  it.each(['crash', 'malformed'])('marks a %s-interrupted prompt uncertain and never sends it again on initialization', async (command) => {
    const f = await fixture();
    await f.session.connect(f.profile, { resume: false });
    const sent = f.session.send(command).catch(() => undefined);
    await expect.poll(() => f.session.snapshot().status, { timeout: 5_000 }).toBe('error');
    await sent;
    expect(f.session.snapshot().record.messages.some((message) => message.role === 'user' && message.text === command && message.uncertain)).toBe(true);
    await f.session.close();
    const before = await journal(f.file);
    const restored = f.create();
    await restored.initialize();
    expect(restored.snapshot().record.messages.some((message) => message.text === command && message.uncertain)).toBe(true);
    expect(await journal(f.file)).toEqual(before);
    expect(before.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  });

  it('bounds cancellation when the agent never finishes and preserves the uncertain prompt without an automatic retry', async () => {
    const f = await fixture('task', 'normal', 5_000);
    await f.session.connect(f.profile, { resume: false });
    const sent = f.session.send('neverfinish').catch(() => undefined);
    await expect.poll(async () => (await journal(f.file)).some((message) => message.method === 'session/prompt'), { timeout: 5_000 }).toBe(true);
    await f.session.cancel().catch(() => undefined);
    expect(f.session.snapshot().status).toBe('error');
    await f.session.disconnect();
    await sent;
    expect(f.session.snapshot().record.messages.some((message) => message.text === 'neverfinish' && message.uncertain)).toBe(true);
    expect((await journal(f.file)).filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  });

  it('drops late output from a disconnected process before explicitly reconnecting', async () => {
    const f = await fixture('task', 'late-on-disconnect');
    await f.session.connect(f.profile, { resume: false });
    const sent = f.session.send('hold').catch(() => undefined);
    await expect.poll(async () => (await journal(f.file)).some((message) => message.method === 'session/prompt'), { timeout: 5_000 }).toBe(true);
    await f.session.disconnect();
    await sent;
    expect(JSON.stringify(f.session.snapshot())).not.toContain('LATE_DISCONNECTED_OUTPUT');
    expect(f.session.snapshot().record.messages.some((message) => message.text === 'hold' && message.uncertain)).toBe(true);
    await f.session.connect(f.profile, { resume: true });
    await f.session.send('new process');
    expect(transcript(f.session).at(-1)).toEqual({ role: 'agent', text: 'Echo: new process' });
    expect(JSON.stringify(f.session.snapshot())).not.toContain('LATE_DISCONNECTED_OUTPUT');
  });

  it('revalidates the allocation before launch and before sending to a connected agent', async () => {
    const f = await fixture();
    f.validate.mockRejectedValueOnce(new Error('Workspace allocation changed'));
    await expect(f.session.connect(f.profile, { resume: false })).rejects.toThrow('Workspace allocation changed');
    expect(await journal(f.file)).toEqual([]);
    await f.session.connect(f.profile, { resume: false });
    f.validate.mockRejectedValueOnce(new Error('Workspace allocation changed'));
    await expect(f.session.send('must not reach old allocation')).rejects.toThrow('Workspace allocation changed');
    expect((await journal(f.file)).some((message) => message.method === 'session/prompt')).toBe(false);
  });
});
