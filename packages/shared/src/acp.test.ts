import { describe, expect, it } from 'vitest';
import { parseAcpAction, type AcpAction } from './acp.js';

const actions: AcpAction[] = [
  { type: 'send', text: 'Keep `$(git status)` as message text.\n第二行', profileId: 'local-agent', version: 0, revision: 1 },
  { type: 'connect', profileId: 'local-agent', resume: false },
  { type: 'connect', profileId: 'local-agent', resume: true },
  { type: 'cancel' },
  { type: 'disconnect' },
  { type: 'new' },
  { type: 'configure' },
  { type: 'review' },
  { type: 'draft', text: '', version: 2, revision: 3 },
  { type: 'permission', requestId: 'request-2', optionId: 'reject-once' },
  { type: 'authenticate', methodId: 'agent-login' },
];

describe('ACP panel action validation', () => {
  it.each(actions)('accepts $type and forwards only its defined fields', (action) => {
    const payload = {
      ...action,
      command: '/untrusted/agent',
      args: ['--execute', 'anything'],
      env: { TOKEN: 'untrusted-value' },
      workspace: '/other-task',
      repository: '/other-primary',
      sessionId: 'other-session',
      binding: { taskId: 'other-task' },
      automaticApproval: true,
    };

    expect(parseAcpAction(payload)).toEqual(action);
  });

  it.each([null, undefined, false, 1, 'send', [], [{ type: 'cancel' }]])('rejects a non-object action: %j', (value) => {
    expect(() => parseAcpAction(value)).toThrow();
  });

  it.each([undefined, null, 1, 'execute', 'session/prompt', 'accept', 'rebase', 'connectPreview'])('rejects an unknown action: %j', (type) => {
    expect(() => parseAcpAction({ type })).toThrow();
  });

  it.each([undefined, null, 0, 1, 'false', 'true'])('requires an explicit boolean restore choice: %j', (resume) => {
    expect(() => parseAcpAction({ type: 'connect', profileId: 'local-agent', resume })).toThrow();
  });

  it.each([
    { action: { type: 'send', text: 'Hello', profileId: 'agent', version: 0, revision: 0 }, field: 'profileId' },
    { action: { type: 'connect', profileId: 'agent', resume: false }, field: 'profileId' },
    { action: { type: 'permission', requestId: 'request', optionId: 'option' }, field: 'requestId' },
    { action: { type: 'permission', requestId: 'request', optionId: 'option' }, field: 'optionId' },
    { action: { type: 'authenticate', methodId: 'login' }, field: 'methodId' },
  ])('validates $action.type identifiers in $field without coercion', ({ action, field }) => {
    for (const invalid of [undefined, null, '', 0, {}, 'x'.repeat(501)]) {
      expect(() => parseAcpAction({ ...action, [field]: invalid })).toThrow();
    }
    const bounded = { ...action, [field]: 'x'.repeat(500) };
    expect(parseAcpAction(bounded)).toEqual(bounded);
  });

  it.each(['send', 'draft'] as const)('bounds %s text while preserving valid content', (type) => {
    const action = type === 'send' ? { type, profileId: 'agent', version: 0, revision: 0 } : { type, version: 0, revision: 0 };
    for (const invalid of [undefined, null, false, 12, {}, 'x'.repeat(100_001)]) {
      expect(() => parseAcpAction({ ...action, text: invalid })).toThrow();
    }
    for (const text of ['', 'Do not trim this draft.\n  ', 'x'.repeat(100_000)]) {
      expect(parseAcpAction({ ...action, text })).toEqual({ ...action, text });
    }
  });

  it.each(['send', 'draft'] as const)('requires bounded integer draft versions for %s', (type) => {
    for (const key of ['version', 'revision'])
      for (const invalid of [undefined, null, -1, 0.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1])
        expect(() => parseAcpAction({ type, profileId: 'agent', text: 'Text', version: 0, revision: 0, [key]: invalid })).toThrow();
  });
});
