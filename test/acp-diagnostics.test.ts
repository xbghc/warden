import { describe, expect, it } from 'vitest';
import { AcpStderr, acpErrorDiagnostic, acpErrorMessage, acpFailureLog, redactAcpDiagnostic } from '../packages/vscode/src/acp/diagnostics.js';

describe('ACP failure diagnostics', () => {
  it('buffers split credentials and drops oversized stderr lines without leaking their tails', () => {
    const stderr = new AcpStderr();
    stderr.append('Starting\nAuthorization: Bear');
    stderr.append('er private-value\nKnown secret: split-');
    stderr.append('credential\n');
    const diagnostic = redactAcpDiagnostic(stderr.text, ['split-credential']);
    expect(diagnostic).toContain('Starting');
    expect(diagnostic).not.toMatch(/private-value|split-credential/);
    stderr.append('password=' + 'x'.repeat(20_000));
    stderr.append('secret-tail');
    expect(stderr.text).not.toContain('secret-tail');
    stderr.append('\nUseful final error\n');
    expect(stderr.text).toContain('Useful final error');
    expect(stderr.text.length).toBeLessThanOrEqual(8_192);
  });
  it('retains the RPC code and nested cause behind a generic internal error', () => {
    const error = Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { details: 'Unable to open the saved session', cause: new Error('Session file is missing') },
    });
    const output = acpFailureLog('session/load', error, { taskId: 'task-1', profileId: 'codex', stderr: 'Agent could not load its session file' });
    expect(output).toContain('session/load failed; task=task-1; profile=codex');
    expect(output).toContain('Internal error (-32603)');
    expect(output).toContain('Session file is missing');
    expect(output).toContain('Agent stderr:');
    expect(acpErrorMessage(error)).toContain('Unable to open the saved session');
  });

  it('redacts credentials and request payloads from structured data and stderr', () => {
    const secret = 'private credential/value';
    const error = Object.assign(new Error('Internal error'), {
      code: -32603,
      data: {
        access_token: 'hidden-access',
        nested: { authorization: 'hidden-header', env: { OTHER: 'hidden-env' }, prompt: 'hidden-prompt' },
        details: `Request failed: ${secret}; retry ${encodeURIComponent(secret)}; Bearer hidden-bearer`,
      },
    });
    const output = acpFailureLog('session/new', error, {
      taskId: 'task',
      secrets: [secret],
      stderr: 'api_key="hidden-key" https://user:pass@example.com/?code=hidden-code&state=hidden-state sk-hidden-secret',
    });
    for (const value of [
      secret,
      encodeURIComponent(secret),
      'hidden-access',
      'hidden-header',
      'hidden-env',
      'hidden-prompt',
      'hidden-bearer',
      'hidden-key',
      'hidden-code',
      'hidden-state',
      'sk-hidden-secret',
      'user:pass',
    ])
      expect(output).not.toContain(value);
    expect(output).toContain('Request failed');
    expect(output).toContain('[Redacted]');
  });

  it('bounds diagnostic output and tolerates cyclic error data', () => {
    const data: Record<string, unknown> = { details: 'x'.repeat(30_000) };
    data.cause = data;
    const error = Object.assign(new Error('Internal error'), { data });
    expect(acpErrorDiagnostic(error).length).toBeLessThan(12_100);
    expect(acpErrorMessage(error).length).toBeLessThan(2_100);
  });
});
