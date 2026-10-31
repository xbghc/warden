import { expect, it } from 'vitest';
import { DiagnosticLog, redactDiagnostic } from './logging.js';

it('pairs concurrent operations and preserves failures without recording inputs or error payloads', async () => {
  const records: Array<{ level: string; [key: string]: unknown }> = [];
  const log = new DiagnosticLog((level, line) => records.push({ level, ...JSON.parse(line.slice('[diagnostic] '.length)) }), { run: 'run-1' });
  const first = log.child({ connection: 'first' }).start('request', { method: 'session/new' });
  const second = log.child({ connection: 'second' }).start('request', { method: 'session/load' });
  second.end('cancelled');
  first.end();
  first.end('error');
  const error = Object.assign(new Error('private prompt and command'), { code: -32000, data: { api_key: 'private-key' } });
  await expect(log.measure('authenticate', () => Promise.reject(error))).rejects.toBe(error);
  expect(records.filter((row) => row.event === 'request.end')).toHaveLength(2);
  for (const start of records.filter((row) => String(row.event).endsWith('.start'))) {
    const end = records.find((row) => String(row.event).endsWith('.end') && row.operation === start.operation)!;
    expect(end.run).toBe(start.run);
    expect(end.connection).toBe(start.connection);
    expect(Number(end.durationMs)).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(String(end.timestamp)))).toBe(false);
  }
  expect(records.at(-1)).toMatchObject({ event: 'authenticate.end', level: 'warn', outcome: 'authentication_required', code: -32000 });
  expect(JSON.stringify(records)).not.toContain('private');
});

it('does not fail successful operations or replace errors when output is disposed', async () => {
  const log = new DiagnosticLog(() => {
    throw new Error('Output is closed');
  });
  expect(await log.measure('read', () => 42)).toBe(42);
  const error = new Error('Original failure');
  await expect(
    log.measure('write', () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

it('redacts before truncation and escapes multiline diagnostics into one bounded JSON record', () => {
  const lines: string[] = [];
  const secret = 'known/private+credential';
  const log = new DiagnosticLog((_level, line) => lines.push(line), {}, [secret, '1']);
  log.write('error', 'failure', {
    apiKey: 'hidden-key',
    prompt: 'hidden-prompt',
    diagnostic: `first line\n${secret} ${encodeURIComponent(secret)} password=hidden-password\n${'x'.repeat(20_000)}`,
  });
  const line = lines[0]!;
  expect(line.split('\n')).toHaveLength(1);
  expect(line.length).toBeLessThan(17_000);
  for (const value of [secret, encodeURIComponent(secret), 'hidden-key', 'hidden-prompt', 'hidden-password']) expect(line).not.toContain(value);
  expect(JSON.parse(line.slice('[diagnostic] '.length)).diagnostic).toContain('first line\n');
  expect(Number.isNaN(Date.parse(JSON.parse(line.slice('[diagnostic] '.length)).timestamp))).toBe(false);
  expect(redactDiagnostic('Bearer abc https://user:pass@example.com?token=abcdef')).not.toMatch(/abc|user:pass/);
});
