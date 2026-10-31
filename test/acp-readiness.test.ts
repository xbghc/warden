import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AcpReadinessCheck } from '../packages/vscode/src/acp/readiness.js';
import type { AcpProfile } from '../packages/vscode/src/acp/contracts.js';
import { PerformanceLog } from '../packages/vscode/src/performance.js';
import type { PerformanceRecord } from '../packages/vscode/src/performance.js';
import { DiagnosticLog } from '@warden/shared';

const agent = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
let directory: string;
let check: AcpReadinessCheck;
let log: string;
let states: string[];
let timings: PerformanceRecord[];
let diagnostics: Array<{ level: string; [key: string]: unknown }>;
const completed = (stage: PerformanceRecord['stage']) => timings.filter((row) => row.stage === stage && row.event === 'end');
const events = async () =>
  (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const profile = (mode = 'normal'): AcpProfile => ({ id: 'fixture', label: 'Fixture', command: process.execPath, args: [agent, log, mode] });
const stopped = async () => {
  const pid = (await events())[0].pid;
  expect(() => process.kill(pid, 0)).toThrow();
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'warden-agent-check-'));
  log = path.join(directory, 'agent.jsonl');
  states = [];
  timings = [];
  diagnostics = [];
  check = new AcpReadinessCheck(
    () => states.push(check.snapshot().status),
    3000,
    new PerformanceLog((line) => timings.push(JSON.parse(line.slice('[performance] '.length)))),
    new DiagnosticLog((level, line) => diagnostics.push({ level, ...JSON.parse(line.slice('[diagnostic] '.length)) })),
  );
});
afterEach(async () => {
  await check.close();
  await rm(directory, { recursive: true, force: true });
});

it('keeps the initialized ACP connection alive without a prompt until Warden closes it', async () => {
  expect(check.snapshot().status).toBe('unchecked');
  await expect(readFile(log)).rejects.toThrow();
  await check.check(profile(), directory);
  expect(check.snapshot().status).toBe('ready');
  const wire = await events();
  expect(wire.map((row) => row.method)).toEqual(['initialize', 'session/new']);
  expect(wire[0].params.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false });
  expect(wire[0].params.clientCapabilities.terminal).toBe(false);
  expect(wire[1].params.cwd).toBe(directory);
  const connection = completed('acp.connect')[0]!;
  expect(connection.outcome).toBe('ok');
  for (const stage of ['acp.cleanup', 'acp.spawn', 'acp.initialize', 'acp.session.new'] as const) {
    expect(completed(stage)).toHaveLength(1);
    expect(completed(stage)[0]).toMatchObject({ parent: connection.span, outcome: 'ok' });
    expect(completed(stage)[0]!.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(JSON.stringify(timings)).not.toContain(directory);
  expect(JSON.stringify(timings)).not.toContain(process.execPath);
  expect(() => process.kill(wire[0].pid, 0)).not.toThrow();
  await check.close();
  await stopped();
});

it('logs provider failure details and redacts credentials across stderr chunks', async () => {
  await check.check({ ...profile('diagnostics-fails'), env: { WARDEN_FIXTURE_LOG_VALUE: 'private-configured-value' } }, directory);
  expect(check.snapshot().status).toBe('error');
  const failure = diagnostics.find((row) => row.event === 'acp.connection.failed');
  expect(failure).toMatchObject({ level: 'error', code: -32603, profile: 'fixture' });
  expect(failure?.diagnostic).toContain('Provider diagnostics:');
  expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'acp.session.new.end', outcome: 'error', connection: failure?.connection }));
  for (const value of ['private-configured-value', 'private-stderr-value', 'private-tool-input', 'private-prompt'])
    expect(JSON.stringify(diagnostics)).not.toContain(value);
});

it('keeps a missing executable unavailable', async () => {
  let signals = 0;
  const signal = () => {
    signals++;
  };
  if (process.platform !== 'win32') process.on('SIGPIPE', signal);
  try {
    await check.check({ ...profile(), command: path.join(directory, 'missing-agent') }, directory);
    expect(check.snapshot().status).toBe('error');
    expect(check.snapshot().message).toMatch(/ENOENT|start the agent/);
    expect(states).not.toContain('ready');
    expect(completed('acp.spawn')[0]?.outcome).toBe('error');
    expect(completed('acp.connect')[0]?.outcome).toBe('error');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(signals).toBe(0);
  } finally {
    if (process.platform !== 'win32') process.removeListener('SIGPIPE', signal);
  }
});

it.each(['incompatible', 'initialize-hangs', 'session-new-fails'])('keeps failed protocol/session checks blocked: %s', async (mode) => {
  await check.check(profile(mode), directory);
  expect(check.snapshot().status).toBe('error');
  expect(states).not.toContain('ready');
  const stage = mode === 'session-new-fails' ? 'acp.session.new' : 'acp.initialize';
  const outcome = mode === 'initialize-hangs' ? 'timeout' : 'error';
  expect(completed(stage)[0]?.outcome).toBe(outcome);
  expect(completed('acp.connect')[0]?.outcome).toBe(outcome);
  await stopped();
});

it('requires authentication before becoming ready and accepts only advertised methods', async () => {
  await check.check(profile('auth'), directory);
  expect(check.snapshot().status).toBe('authentication_required');
  expect(check.snapshot().authMethods?.map((method) => method.id)).toEqual(['login']);
  expect(states).not.toContain('ready');
  expect(completed('acp.connect')[0]?.outcome).toBe('authentication_required');
  await expect(check.authenticate('terminal-login')).rejects.toThrow('offered');
  await check.authenticate('login');
  expect(completed('acp.authenticate')[0]?.outcome).toBe('ok');
  expect(check.snapshot().status).toBe('ready');
  const wire = await events();
  expect(wire.map((row) => row.method)).toEqual(['initialize', 'session/new', 'authenticate', 'session/new']);
  expect(() => process.kill(wire[0].pid, 0)).not.toThrow();
  await check.close();
  await stopped();
});

it('cancels an in-flight check and rejects late readiness', async () => {
  const pending = check.check(profile('initialize-hangs'), directory);
  await vi.waitFor(() => expect(timings.some((row) => row.stage === 'acp.initialize' && row.event === 'start')).toBe(true));
  await check.reset();
  await pending;
  expect(check.snapshot().status).toBe('unchecked');
  expect(states).not.toContain('ready');
  expect(completed('acp.initialize')[0]?.outcome).toBe('cancelled');
  expect(completed('acp.connect')[0]?.outcome).toBe('cancelled');
});

it('cancels startup permission requests without granting agent tools', async () => {
  await check.check(profile('setup-permission'), directory);
  expect(check.snapshot().status).toBe('ready');
  const answer = (await events()).find((row) => row.result?.outcome);
  expect(answer.result.outcome.outcome).toBe('cancelled');
  await check.close();
  await stopped();
});

it('keeps overlapping replacement timings separate from the cancelled connection', async () => {
  const pending = check.check(profile('initialize-hangs'), directory);
  await vi.waitFor(() => expect(timings.some((row) => row.stage === 'acp.initialize' && row.event === 'start')).toBe(true));
  await check.check(profile(), directory);
  await pending;
  const connections = completed('acp.connect');
  expect(connections.map((row) => row.outcome).sort()).toEqual(['cancelled', 'ok']);
  expect(new Set(connections.map((row) => row.span)).size).toBe(2);
  const succeeded = connections.find((row) => row.outcome === 'ok')!;
  expect(completed('acp.session.new')[0]).toMatchObject({ parent: succeeded.span, outcome: 'ok' });
  expect(check.snapshot().status).toBe('ready');
});

it('observes an unexpected exit after initialization and retires the live connection', async () => {
  await check.check(profile(), directory);
  expect(check.snapshot().status).toBe('ready');
  process.kill((await events())[0].pid, 'SIGTERM');
  await vi.waitFor(() => expect(check.snapshot().status).toBe('error'));
  await stopped();
});

it('stops the old process before replacing a connection', async () => {
  await check.check(profile(), directory);
  const oldPid = (await events())[0].pid;
  const replacementLog = path.join(directory, 'replacement.jsonl');
  const replacement = { ...profile(), args: [agent, replacementLog, 'normal'] };
  await check.check(replacement, directory);
  expect(check.snapshot().status).toBe('ready');
  expect(() => process.kill(oldPid, 0)).toThrow();
  const nextPid = JSON.parse((await readFile(replacementLog, 'utf8')).split('\n')[0]!).pid;
  expect(() => process.kill(nextPid, 0)).not.toThrow();
  await check.close();
  expect(() => process.kill(nextPid, 0)).toThrow();
});

it('invalidates a verified agent after an observed connection failure without confusing another profile', async () => {
  const configured = profile();
  await check.check(configured, directory);
  check.unavailable({ ...configured, id: 'other' }, 'Other agent failed');
  expect(check.snapshot().status).toBe('ready');
  check.unavailable(configured, 'Connection lost');
  expect(check.snapshot()).toMatchObject({ status: 'error', message: 'Connection lost' });
});
