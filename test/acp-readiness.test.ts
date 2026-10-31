import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AcpReadinessCheck } from '../packages/vscode/src/acp/readiness.js';
import type { AcpProfile } from '../packages/vscode/src/acp/contracts.js';

const agent = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
let directory: string;
let check: AcpReadinessCheck;
let log: string;
let states: string[];
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
  check = new AcpReadinessCheck(() => states.push(check.snapshot().status), 3000);
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
  expect(() => process.kill(wire[0].pid, 0)).not.toThrow();
  await check.close();
  await stopped();
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
  await stopped();
});

it('requires authentication before becoming ready and accepts only advertised methods', async () => {
  await check.check(profile('auth'), directory);
  expect(check.snapshot().status).toBe('authentication_required');
  expect(check.snapshot().authMethods?.map((method) => method.id)).toEqual(['login']);
  expect(states).not.toContain('ready');
  await expect(check.authenticate('terminal-login')).rejects.toThrow('offered');
  await check.authenticate('login');
  expect(check.snapshot().status).toBe('ready');
  const wire = await events();
  expect(wire.map((row) => row.method)).toEqual(['initialize', 'session/new', 'authenticate', 'session/new']);
  expect(() => process.kill(wire[0].pid, 0)).not.toThrow();
  await check.close();
  await stopped();
});

it('cancels an in-flight check and rejects late readiness', async () => {
  const pending = check.check(profile('initialize-hangs'), directory);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await check.reset();
  await pending;
  expect(check.snapshot().status).toBe('unchecked');
  expect(states).not.toContain('ready');
});

it('cancels startup permission requests without granting agent tools', async () => {
  await check.check(profile('setup-permission'), directory);
  expect(check.snapshot().status).toBe('ready');
  const answer = (await events()).find((row) => row.result?.outcome);
  expect(answer.result.outcome.outcome).toBe('cancelled');
  await check.close();
  await stopped();
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
