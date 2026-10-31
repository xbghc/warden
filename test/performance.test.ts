import { afterEach, expect, it, vi } from 'vitest';
import { PerformanceLog } from '../packages/vscode/src/performance.js';
import type { PerformanceRecord } from '../packages/vscode/src/performance.js';

afterEach(() => vi.restoreAllMocks());

it('records pending and overlapping phases with monotonic durations and independent parent IDs', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const rows: PerformanceRecord[] = [];
  const log = new PerformanceLog((line) => rows.push(JSON.parse(line.slice('[performance] '.length))));
  const parent = log.start('repository.refresh');
  let release!: () => void;
  const pending = parent.measure(
    'workflow.get',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  now.mockReturnValue(115);
  const other = log.start('acp.connect');
  expect(rows.map((row) => row.event)).toEqual(['start', 'start', 'start']);
  now.mockReturnValue(140);
  release();
  await pending;
  parent.end();
  other.end('cancelled');
  other.end();
  const ended = rows.filter((row) => row.event === 'end');
  expect(ended).toHaveLength(3);
  expect(ended[0]).toMatchObject({ stage: 'workflow.get', parent: parent.id, durationMs: 40, elapsedMs: 40, outcome: 'ok' });
  expect(ended[2]).toMatchObject({ stage: 'acp.connect', durationMs: 25, elapsedMs: 40, outcome: 'cancelled' });
  expect(new Set(rows.map((row) => row.run)).size).toBe(1);
});

it('records synchronous and asynchronous failures without logging their contents or replacing them', async () => {
  const lines: string[] = [];
  const log = new PerformanceLog((line) => lines.push(line));
  const error = new Error('private-path token=secret');
  await expect(
    log.measure('engine.open', () => {
      throw error;
    }),
  ).rejects.toBe(error);
  await expect(
    log.measure(
      'acp.initialize',
      () => Promise.reject(error),
      undefined,
      () => 'timeout',
    ),
  ).rejects.toBe(error);
  const rows = lines.map((line): PerformanceRecord => JSON.parse(line.slice('[performance] '.length)));
  expect(rows.filter((row) => row.event === 'end').map((row) => row.outcome)).toEqual(['error', 'timeout']);
  expect(lines.join('\n')).not.toMatch(/private-path|secret/);
});

it('keeps operations usable when diagnostic output is unavailable', async () => {
  const log = new PerformanceLog(() => {
    throw new Error('Output channel disposed');
  });
  await expect(log.measure('engine.open', () => 'ready')).resolves.toBe('ready');
  const failure = new Error('Operation failed');
  await expect(log.measure('engine.open', () => Promise.reject(failure))).rejects.toBe(failure);
});
