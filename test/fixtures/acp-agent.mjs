import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { terminalOutputScenario } from './acp-terminal-output.mjs';

// A real subprocess with no model or credentials. Its own tools edit only its cwd;
// Warden is responsible for the ACP conversation, not these filesystem operations.
const [journal, mode = 'normal'] = process.argv.slice(2);
const historyFile = `${journal}.history`;
const pending = new Map();
let sequence = 0;
let sessionId;
let turn;
let authenticated = mode === 'auth-external' && existsSync(`${journal}.auth`);
let delayedLoad;
let delayedConfig;
let model = 'fast';
let thinking = false;
const customEffort = mode.startsWith('controls-effort');
let effort = customEffort ? 'auto' : 'medium';
let agentMode = 'code';
const controlsMode = mode.startsWith('controls');
const legacyMode = mode.startsWith('legacy-mode');
const modes = {
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: '询问' },
    { id: 'code', name: '编码' },
  ],
};
const configOptions = () => [
  {
    id: mode === 'controls-model-alias' ? 'provider/model' : 'model',
    name: '模型',
    ...(mode === 'controls-uncategorized' ? {} : { category: 'model' }),
    type: 'select',
    currentValue: model,
    options:
      mode === 'controls-grouped'
        ? [
            {
              group: 'recommended',
              name: '推荐',
              options: [
                { value: 'fast', name: '快速' },
                { value: 'deep', name: '深入' },
              ],
            },
          ]
        : [
            { value: 'fast', name: '快速' },
            { value: 'deep', name: '深入' },
          ],
  },
  { id: 'thinking', name: '显示思考', type: 'boolean', currentValue: thinking },
  ...(customEffort
    ? [
        {
          id: 'thinking-budget',
          name: 'Thinking budget',
          ...(mode === 'controls-effort-uncategorized' ? {} : { category: 'thought_level' }),
          type: 'select',
          currentValue: effort,
          options: (model === 'deep' ? ['disabled', 'max'] : ['auto', '1024', '8192']).map((value) => ({ value, name: value })),
        },
      ]
    : []),
  ...(mode === 'controls-composer'
    ? [
        {
          id: 'effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: effort,
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: agentMode,
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'code', name: 'Code' },
          ],
        },
      ]
    : []),
];
const requiresAuth = mode === 'auth' || mode === 'auth-delayed-load' || mode === 'auth-external';
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const batch = (...messages) => process.stdout.write(messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
const result = (id, value) => write({ id, result: value });
const error = (id, code, message, data) => write({ id, error: { code, message, data } });
const notify = (update, target = sessionId) => write({ method: 'session/update', params: { sessionId: target, update } });
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
    if (mode === 'initialize-hangs') return;
    const authMethods = [
      { id: 'login', name: 'Fixture login' },
      { type: 'terminal', id: 'terminal-login', name: 'External login', args: ['login'] },
    ];
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
    if (mode === 'session-new-fails') return error(id, -32603, 'Provider is unavailable');
    if (mode === 'diagnostics-fails') {
      const secret = process.env.WARDEN_FIXTURE_LOG_VALUE;
      process.stderr.write(`Provider diagnostics: ${secret.slice(0, 7)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.stderr.write(`${secret.slice(7)}\nAuthorization: Bearer private-stderr-value\n`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return error(id, -32603, 'Provider setup failed', { details: `Failed with ${secret}`, rawInput: 'private-tool-input', prompt: 'private-prompt' });
    }
    if (mode === 'session-internal-fails') {
      process.stderr.write('Fixture stderr: workspace could not be opened\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
      return error(id, -32603, 'Internal error', { details: 'Unable to open task workspace', api_key: 'sk-fixture-secret' });
    }
    if (mode === 'setup-permission')
      await request('session/request_permission', {
        sessionId: 'check-session',
        toolCall: { toolCallId: 'setup', title: 'Unexpected startup tool', kind: 'execute' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
    if (method === 'session/load' && mode === 'no-load') return error(id, -32601, 'Loading is unsupported');
    if (method === 'session/load' && mode === 'load-fails') return error(id, -32001, 'Saved session is unavailable');
    if (method === 'session/load' && mode.startsWith('missing-rollout')) {
      if (mode === 'missing-rollout-replay') update('agent', 'A previous reply', params.sessionId);
      writeFileSync(`${journal}.missing-rollout`, 'missing');
      return error(id, -32603, 'Internal error', { details: `no rollout found for thread id ${params.sessionId}` });
    }
    if (method === 'session/new' && mode === 'missing-rollout-new-fails' && existsSync(`${journal}.missing-rollout`))
      return error(id, -32603, 'Provider is unavailable');
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
    if (controlsMode || legacyMode) {
      notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'foreign', description: 'Foreign command' }] }, `${sessionId}-foreign`);
      notify({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'explain', description: '解释选中内容', input: { hint: '问题或路径' } },
          ...(mode === 'controls-composer' ? [{ name: 'review', description: 'Review the current changes' }] : []),
        ],
      });
      notify({ sessionUpdate: 'session_info_update', title: '初始会话标题' });
    }
    result(id, {
      ...(method === 'session/new' ? { sessionId } : {}),
      ...(controlsMode || legacyMode ? { modes } : {}),
      ...(controlsMode ? { configOptions: mode === 'controls-empty' ? [] : configOptions() } : {}),
    });
    return;
  }
  if (method === 'session/set_config_option') {
    if (mode === 'controls-reject') return error(id, -32602, 'Model is unavailable');
    if (mode === 'controls-response-race' || mode === 'controls-response-before') {
      model = 'deep';
      const response = configOptions();
      model = 'fast';
      const messages = [
        { id, result: { configOptions: response } },
        { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: configOptions() } } },
      ];
      batch(...(mode === 'controls-response-before' ? messages.reverse() : messages));
      return;
    }
    if (mode === 'controls-delayed') await new Promise((resolve) => setTimeout(resolve, 300));
    if (mode === 'controls-timeout' && !existsSync(`${journal}.delayed-config`)) {
      writeFileSync(`${journal}.delayed-config`, String(process.pid));
      delayedConfig = { id };
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    if (params.configId === 'model' || (mode === 'controls-model-alias' && params.configId === 'provider/model')) {
      model = params.value;
      if (customEffort) effort = model === 'deep' ? 'disabled' : 'auto';
    } else if (params.configId === 'thinking' && params.type === 'boolean') thinking = params.value;
    else if (params.configId === 'thinking-budget' && customEffort) effort = params.value;
    else if (params.configId === 'effort' && mode === 'controls-composer') effort = params.value;
    else if (params.configId === 'mode' && mode === 'controls-composer') agentMode = params.value;
    else return error(id, -32602, 'Unknown config option');
    // Changing one choice can also change another, so clients must replace the full result.
    if (model === 'deep') thinking = true;
    result(id, { configOptions: configOptions() });
    return;
  }
  if (method === 'session/set_mode') {
    if (mode === 'legacy-mode-response-race' || mode === 'legacy-mode-response-before') {
      const messages = [
        { id, result: {} },
        { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' } } },
      ];
      batch(...(mode === 'legacy-mode-response-before' ? messages.reverse() : messages));
      return;
    }
    modes.currentModeId = params.modeId;
    notify({ sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
    result(id, {});
    return;
  }
  if (method === 'session/cancel') {
    if (turn) turn.cancelled = true;
    if (turn?.text === 'hold' || turn?.text === 'terminal-hold') {
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
  if (text === 'controls-update') {
    notify({
      sessionUpdate: 'config_option_update',
      configOptions: [{ ...configOptions()[0], currentValue: 'deep', options: [{ value: 'deep', name: '深入' }] }],
    });
    notify({ sessionUpdate: 'current_mode_update', currentModeId: 'code' });
    answer(id, 'Controls updated');
    return;
  }
  if (text === 'clear-controls') {
    notify({ sessionUpdate: 'config_option_update', configOptions: [] });
    notify({ sessionUpdate: 'available_commands_update', availableCommands: [] });
    answer(id, 'Controls cleared');
    return;
  }
  if (text === 'session-updates') {
    toolUpdate({ sessionUpdate: 'agent_thought_chunk', messageId: 'thought-one', content: { type: 'text', text: '正在检查' } });
    toolUpdate({ sessionUpdate: 'agent_thought_chunk', messageId: 'thought-one', content: { type: 'text', text: '任务上下文' } });
    notify({ sessionUpdate: 'usage_update', used: 1200, size: 8000, cost: { amount: 0.02, currency: 'USD' } });
    notify({ sessionUpdate: 'session_info_update', title: '测试会话标题' });
    notify({ sessionUpdate: 'notice', title: '会话更新提示', severity: 'warning', description: 'Agent 已更新会话状态' });
    toolUpdate({ sessionUpdate: 'compaction_update', compactionId: 'ui-compaction', status: 'in_progress' });
    toolUpdate({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'ui-compaction', content: { type: 'text', text: '已保留任务目标与关键结论' } });
    toolUpdate({ sessionUpdate: 'compaction_update', compactionId: 'ui-compaction', status: 'completed' });
    answer(id, 'Session updated');
    return;
  }
  if (text === 'idle-updates') {
    answer(id, 'Idle updates scheduled');
    // These are legitimate live updates even without an active prompt.
    setTimeout(() => {
      notify({ sessionUpdate: 'usage_update', used: 1400, size: 8000, cost: null });
      notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'idle', description: 'Idle command' }] });
      notify({ sessionUpdate: 'config_option_update', configOptions: [{ ...configOptions()[0], currentValue: 'deep' }] });
      notify({ sessionUpdate: 'session_info_update', updatedAt: new Date().toISOString() });
      notify({ sessionUpdate: 'notice', title: 'Idle notice', severity: 'info' });
    }, 30);
    return;
  }
  if (text === 'compactions') {
    const chunk = (compactionId, text) => toolUpdate({ sessionUpdate: 'compaction_summary_chunk', compactionId, content: { type: 'text', text } });
    const patch = (compactionId, fields) => toolUpdate({ sessionUpdate: 'compaction_update', compactionId, ...fields });
    chunk('first', 'Draft');
    patch('first', { status: 'in_progress', error: 'Temporary error' });
    chunk('first', ' summary');
    update('agent', 'Between compactions');
    patch('second', { status: 'failed', summary: [{ type: 'text', text: 'Second summary' }], error: 'Second failure' });
    patch('first', { status: 'failed', summary: [{ type: 'text', text: 'Replacement' }], error: 'First failure' });
    patch('first', { status: 'completed', error: null });
    patch('first', { status: 'in_progress', summary: null });
    chunk('first', 'Final');
    patch('first', { status: 'completed' });
    patch('second', { status: 'cancelled', summary: [], error: null });
    answer(id, 'Compactions completed');
    return;
  }
  if (text === 'large-compaction') {
    toolUpdate({
      sessionUpdate: 'compaction_update',
      compactionId: 'large',
      status: 'failed',
      summary: [{ type: 'text', text: 's'.repeat(260_000) }],
      error: 'e'.repeat(260_000),
    });
    answer(id, 'Large compaction completed');
    return;
  }
  if (text === 'compaction-followup') {
    toolUpdate({ sessionUpdate: 'compaction_update', compactionId: 'first', status: 'failed', error: 'Follow-up failure' });
    answer(id, 'Compaction patched');
    return;
  }
  if (terminalOutputScenario(text, toolUpdate, answer, id)) return;
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
  if (text === 'activity-batch') {
    for (let index = 1; index <= 4; index++)
      toolUpdate({ sessionUpdate: 'tool_call', toolCallId: `batch-${index}`, title: `Completed activity ${index}`, status: 'completed' });
    toolUpdate({ sessionUpdate: 'tool_call', toolCallId: 'batch-failure', title: 'Visible failed check', status: 'failed' });
    answer(id, 'Activity summary is still visible');
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
  if (text.startsWith('read-permission ')) {
    const input = JSON.parse(text.slice('read-permission '.length));
    const permission = await request('session/request_permission', {
      sessionId: input.foreign ? `${sessionId}-foreign` : sessionId,
      toolCall: {
        toolCallId: 'read-source',
        title: 'Read source',
        kind: 'read',
        locations: [{ path: input.path }],
        rawInput: { path: input.path },
        ...input.toolCall,
      },
      options: input.options ?? [
        { optionId: 'remember-read', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'read-once', name: 'Allow this read', kind: 'allow_once' },
        { optionId: 'reject-read', name: 'Reject', kind: 'reject_once' },
      ],
    });
    let contents = '';
    if (permission.result?.outcome?.outcome === 'selected' && permission.result.outcome.optionId === 'read-once' && !turn?.cancelled)
      contents = readFileSync(input.path, 'utf8');
    answer(id, `Read permission: ${JSON.stringify(permission.result)} ${contents}`);
    return;
  }
  if (text === 'permission' || text === 'permission-long' || text === 'permission-command' || text === 'foreign-permission') {
    const permission = await request('session/request_permission', {
      sessionId: text === 'foreign-permission' ? `${sessionId}-foreign` : sessionId,
      toolCall: {
        toolCallId: 'write-output',
        title: 'Write agent-output.txt',
        kind: 'edit',
        status: 'pending',
        rawInput:
          text === 'permission-command' || text === 'permission-long'
            ? {
                command: JSON.stringify(
                  text === 'permission-command'
                    ? 'printf "first line\\n"\nprintf "second line\\n"'
                    : `printf "approved\\n" > /tmp/${'acceptance-'.repeat(12)}marker.txt`,
                ),
                cwd: process.cwd(),
                justification: 'Write a disposable test marker',
              }
            : { path: 'agent-output.txt' },
      },
      options: [
        { optionId: 'allow-once', name: 'Allow this write', kind: 'allow_once' },
        ...(text === 'permission-long'
          ? [
              {
                optionId: 'allow-always',
                name: `Yes, and don't ask again for commands that start with \`printf approved > /tmp/${'acceptance-'.repeat(12)}marker.txt\``,
                kind: 'allow_always',
              },
            ]
          : []),
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
if (mode === 'controls-timeout') {
  process.on('SIGTERM', () => {
    if (delayedConfig) {
      notify({ sessionUpdate: 'session_info_update', title: 'LATE_TIMED_OUT_CONFIG' });
      result(delayedConfig.id, { configOptions: [{ ...configOptions()[0], currentValue: 'deep' }] });
    }
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
