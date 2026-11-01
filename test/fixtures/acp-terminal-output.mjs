/** ACP v1 output shapes used by adapters that keep execution inside the agent. */
export function terminalOutputScenario(text, update, answer, id) {
  if (text === 'terminal-hold') {
    update({ sessionUpdate: 'tool_call', toolCallId: 'finished-before-stop', title: 'Finished check', status: 'completed' });
    update({ sessionUpdate: 'tool_call', toolCallId: 'running-at-stop', title: 'Long command', status: 'in_progress' });
    update({ sessionUpdate: 'tool_call', toolCallId: 'pending-at-stop', title: 'Queued command', status: 'pending' });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'running-at-stop',
      _meta: { terminal_output_delta: { terminal_id: 'running-at-stop', data: 'Output before cancellation\n' } },
    });
    return true;
  }
  if (text === 'terminal-output') {
    const emit = (toolCallId, fields) => update({ sessionUpdate: 'tool_call_update', toolCallId, ...fields });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'command-a',
      title: 'Run failing check',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'command-a' }],
    });
    emit('command-a', { _meta: { terminal_output_delta: { terminal_id: 'command-a', data: 'first line\n' } } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'command-b', title: 'Read file', status: 'in_progress' });
    emit('command-b', { _meta: { terminal_output_delta: { terminal_id: 'command-b', data: 'other command\n' } } });
    emit('command-a', { _meta: { terminal_output: { terminal_id: 'command-a', data: 'failure detail\n' } } });
    emit('command-a', { _meta: { terminal_output_delta: { terminal_id: 'command-b', data: 'wrong terminal' } } });
    emit('command-a', { _meta: { terminal_output_delta: { terminal_id: 'command-a', data: { invalid: true } } } });
    emit('command-a', { _meta: { terminal_exit: { terminal_id: 'command-b', exit_code: 99 } } });
    emit('command-a', { title: 'Check failed', content: [{ type: 'content', content: { type: 'text', text: 'Check context' } }] });
    emit('command-a', { status: 'failed', _meta: { terminal_exit: { terminal_id: 'command-a', exit_code: 7, signal: null } } });
    emit('command-b', { status: 'completed', rawOutput: { exit_code: 0 } });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'terminal-with-output',
      title: 'Inspect a diff',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'terminal-with-output' }],
    });
    emit('terminal-with-output', { _meta: { terminal_output_delta: { terminal_id: 'terminal-with-output', data: 'Actual terminal output\n' } } });
    emit('terminal-with-output', { status: 'failed', _meta: { terminal_exit: { terminal_id: 'terminal-with-output', exit_code: 1 } } });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'terminal-without-output',
      title: 'No output supplied',
      status: 'failed',
      content: [{ type: 'terminal', terminalId: 'terminal-without-output' }],
      _meta: { terminal_exit: { terminal_id: 'terminal-without-output', signal: 'SIGTERM', exit_code: null } },
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'literal-output',
      title: 'Read literal output',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Agent terminal activity (this terminal is not managed by Warden)\nExit code: 99' } }],
    });
    answer(id, 'Output reported');
    return true;
  }
  if (text === 'large-terminal-output') {
    update({ sessionUpdate: 'tool_call', toolCallId: 'large-output', title: 'Large output', status: 'in_progress' });
    for (const data of ['x'.repeat(200_000), 'y'.repeat(200_000), 'ignored tail'])
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'large-output', _meta: { terminal_output_delta: { terminal_id: 'large-output', data } } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'large-output', status: 'completed' });
    answer(id, 'Large output reported');
    return true;
  }
  return false;
}
