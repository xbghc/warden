import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

// A real subprocess with no model or credentials. Its own tools edit only its cwd;
// Warden is responsible for the ACP conversation, not these filesystem operations.
const [journal, mode = 'normal'] = process.argv.slice(2);
const historyFile = `${journal}.history`;
const pending = new Map();
let sequence = 0;
let sessionId;
let turn;
let authenticated = false;
let delayedLoad;
const requiresAuth = mode === 'auth' || mode === 'auth-delayed-load';
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const result = (id, value) => write({ id, result: value });
const error = (id, code, message) => write({ id, error: { code, message } });
const remember = (role, text) => appendFileSync(historyFile, `${JSON.stringify({ role, text })}\n`);
const update = (role, text, target = sessionId) =>
  write({ method: 'session/update', params: { sessionId: target, update: { sessionUpdate: `${role}_message_chunk`, content: { type: 'text', text } } } });
const toolUpdate = (update) => {
  appendFileSync(historyFile, `${JSON.stringify({ update })}\n`);
  write({ method: 'session/update', params: { sessionId, update } });
};
const request = (method, params) => {
  const id = `agent-${++sequence}`;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  write({ id, method, params });
  return promise;
};
const answer = (id, text) => {
  remember('agent', text);
  update('agent', text.slice(0, 3));
  update('agent', text.slice(3));
  result(id, { stopReason: turn?.cancelled ? 'cancelled' : 'end_turn' });
  turn = undefined;
};

async function handle(message) {
  appendFileSync(journal, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...message })}\n`);
  if (!message.method) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
    return;
  }
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    const authMethods = requiresAuth
      ? [
          { id: 'login', name: 'Fixture login' },
          { type: 'terminal', id: 'terminal-login', name: 'External login', args: ['login'] },
        ]
      : [];
    result(id, {
      protocolVersion: mode === 'incompatible' ? 999 : 1,
      agentCapabilities: { loadSession: mode !== 'no-load' },
      agentInfo: { name: 'warden-fixture-agent', version: '1.0.0' },
      authMethods,
    });
    return;
  }
  if (method === 'authenticate') {
    authenticated = params.methodId === 'login';
    if (authenticated) result(id, {});
    else error(id, -32602, 'Unknown authentication method');
    return;
  }
  if (method === 'session/new' || method === 'session/load') {
    if (requiresAuth && !authenticated) return error(id, -32000, 'Authentication required');
    if (method === 'session/load' && mode === 'no-load') return error(id, -32601, 'Loading is unsupported');
    if (method === 'session/load' && mode === 'load-fails') return error(id, -32001, 'Saved session is unavailable');
    sessionId = method === 'session/load' ? params.sessionId : `fixture-${process.pid}-${++sequence}`;
    if (method === 'session/new') writeFileSync(historyFile, '');
    if (method === 'session/load' && mode === 'auth-delayed-load' && !existsSync(`${journal}.delayed-load`)) {
      writeFileSync(`${journal}.delayed-load`, String(process.pid));
      delayedLoad = { id };
      update('agent', 'PARTIAL_TIMED_OUT_REPLAY');
      // Longer than the client's test timeout. A second process skips this delay;
      // retrying on this same process would leave the old replay in flight.
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      update('agent', 'LATE_TIMED_OUT_REPLAY');
      delayedLoad = undefined;
    }
    if (method === 'session/load' && existsSync(historyFile)) {
      for (const line of readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.update) {
          write({ method: 'session/update', params: { sessionId, update: message.update } });
          continue;
        }
        // Replay deliberately uses different chunk boundaries from live output.
        update(message.role, message.text.slice(0, 1));
        update(message.role, message.text.slice(1));
      }
    }
    result(id, method === 'session/new' ? { sessionId } : {});
    return;
  }
  if (method === 'session/cancel') {
    if (turn) turn.cancelled = true;
    if (turn?.text === 'hold') {
      result(turn.id, { stopReason: 'cancelled' });
      turn = undefined;
    }
    return;
  }
  if (method !== 'session/prompt') return error(id, -32601, 'Unsupported fixture method');
  const text = params.prompt
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  turn = { id, text, cancelled: false };
  remember('user', text);
  if (text === 'crash') return process.exit(17);
  if (text === 'malformed') return result(id, { stopReason: 42 });
  if (text === 'recoverable-json') process.stdout.write('not valid JSON\n');
  if (text === 'hold' || text === 'neverfinish') return;
  if (text === 'tool-progress') {
    const content = (text) => [{ type: 'content', content: { type: 'text', text } }];
    toolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'progress', title: 'Run tests', status: 'in_progress', content: content('Partial output') });
    toolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'progress', content: content('Final output') });
    toolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'progress', title: 'Tests completed' });
    toolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'progress', status: 'completed' });
    toolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'clear', title: 'Clear output', content: content('Temporary output') });
    toolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'clear', content: [], status: 'completed' });
    answer(id, 'Tool progress completed');
    return;
  }
  if (text === 'tool-refresh') {
    toolUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'progress',
      content: [{ type: 'content', content: { type: 'text', text: 'Follow-up output' } }],
    });
    answer(id, 'Tool output refreshed');
    return;
  }
  if (text === 'long-tool-id') {
    const prefix = 'tool-' + 'x'.repeat(5_000);
    for (const suffix of ['one', 'two'])
      write({
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: `${prefix}${suffix}`, title: `Start ${suffix}`, status: 'pending' } },
      });
    for (const suffix of ['one', 'two'])
      write({
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: `${prefix}${suffix}`, title: `Finished ${suffix}`, status: 'completed' },
        },
      });
    answer(id, 'Long tool IDs completed');
    return;
  }
  if (text === 'expanded-controls') {
    // Each wire line stays below the stream limit, but JSON escaping makes the
    // combined history exceed storage's byte limit despite a modest text length.
    for (let index = 0; index < 8; index++)
      write({
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', messageId: `control-${index}`, content: { type: 'text', text: '\u0000'.repeat(190_000) } },
        },
      });
    answer(id, 'Control stream complete');
    return;
  }
  if (text === 'own-edit') {
    const context = readFileSync(path.join(process.cwd(), 'context.txt'), 'utf8');
    writeFileSync(path.join(process.cwd(), 'agent-output.txt'), `${context.trim()} edited by ${process.pid}\n`);
    answer(id, `Edited ${process.cwd()}`);
    return;
  }
  if (text === 'permission' || text === 'foreign-permission') {
    const permission = await request('session/request_permission', {
      sessionId: text === 'foreign-permission' ? `${sessionId}-foreign` : sessionId,
      toolCall: { toolCallId: 'write-output', title: 'Write agent-output.txt', kind: 'edit', status: 'pending', rawInput: { path: 'agent-output.txt' } },
      options: [
        { optionId: 'allow-once', name: 'Allow this write', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject this write', kind: 'reject_once' },
      ],
    });
    if (permission.result?.outcome?.outcome === 'selected' && permission.result.outcome.optionId === 'allow-once' && !turn?.cancelled)
      writeFileSync(path.join(process.cwd(), 'agent-output.txt'), 'Permission granted\n');
    answer(id, `Permission result: ${JSON.stringify(permission.result)}`);
    return;
  }
  if (text === 'unsupported-client') {
    const response = await request('fs/read_text_file', { sessionId, path: path.join(process.cwd(), 'context.txt') });
    answer(id, `Unsupported callback: ${response.error?.code}`);
    return;
  }
  if (text === 'wrong-session') update('agent', 'WRONG_SESSION_OUTPUT', `${sessionId}-foreign`);
  answer(id, `Echo: ${text}`);
}

if (mode === 'auth-delayed-load') {
  process.on('SIGTERM', () => {
    if (delayedLoad) {
      update('agent', 'LATE_TIMED_OUT_REPLAY');
      result(delayedLoad.id, {});
    }
    setTimeout(() => process.exit(0), 10);
  });
}
if (mode === 'late-on-disconnect') {
  process.on('SIGTERM', () => {
    update('agent', 'LATE_DISCONNECTED_OUTPUT');
    setTimeout(() => process.exit(0), 10);
  });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    Promise.resolve(handle(JSON.parse(line))).catch((failure) => {
      process.stderr.write(`${failure.stack}\n`);
      process.exitCode = 1;
    });
  } catch (failure) {
    process.stderr.write(`${failure.stack}\n`);
    process.exitCode = 1;
  }
});
