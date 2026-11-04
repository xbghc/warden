import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import type { AcpBinding } from '@warden/shared';
import { AcpSession } from '../packages/vscode/src/acp/session.js';
import { AcpSessionStorage } from '../packages/vscode/src/acp/storage.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-acp-output-')));
  const workspace = path.join(directory, 'task');
  await mkdir(workspace);
  const repository = path.join(directory, 'primary');
  await mkdir(repository);
  const binding: AcpBinding = { repository, taskId: 'output', title: 'Output', workspace, branch: 'agent/output', baseBranch: 'main', identity: 'output' };
  const storage = new AcpSessionStorage(path.join(directory, 'data'), binding);
  const journal = path.join(directory, 'wire.jsonl');
  const profile = {
    id: 'fixture',
    label: 'Fixture',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url)), journal],
  };
  const session = new AcpSession({ binding, storage, validate: async () => {}, changed: () => {} });
  cleanups.push(async () => {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });
  await session.initialize();
  await session.connect(profile, { resume: false });
  return { session, storage, profile, journal };
}

it('shows streamed command output and exit codes, preserves them on replay, and never advertises execution tools', async () => {
  const { session, storage, profile, journal } = await fixture();
  await session.send('terminal-output');
  const tools = () => session.snapshot().record.messages.filter((message) => message.role === 'tool');
  const first = tools().find((message) => message.toolCallId === 'command-a')!;
  expect(first.status).toBe('failed');
  expect(first.text).toContain('first line\nfailure detail\n');
  expect(first.text).toContain('Check context');
  expect(first.text).toContain('Exit code: 7');
  expect(first.exitCode).toBe(7);
  expect(first.text).not.toMatch(/wrong terminal|other command|99|invalid/);
  const second = tools().find((message) => message.toolCallId === 'command-b')!;
  expect(second.text).toContain('other command\n');
  expect(second.text).toContain('Exit code: 0');
  expect(second.exitCode).toBe(0);
  expect(second.text).not.toContain('failure detail');
  const terminal = tools().find((message) => message.toolCallId === 'terminal-with-output')!;
  expect(terminal).toMatchObject({ status: 'failed', exitCode: 1 });
  expect(terminal.text).toContain('Actual terminal output');
  expect(terminal.text).not.toContain('this terminal is not managed by Warden');
  const fallback = tools().find((message) => message.toolCallId === 'terminal-without-output')!;
  expect(fallback.exitSignal).toBe('SIGTERM');
  expect(fallback.text).toContain('this terminal is not managed by Warden');
  const literal = tools().find((message) => message.toolCallId === 'literal-output')!;
  expect(literal.text).toContain('this terminal is not managed by Warden');
  expect(literal.exitCode).toBeUndefined();
  const result = ({ toolCallId, text, status, exitCode, exitSignal }: typeof first) => ({ toolCallId, text, status, exitCode, exitSignal });
  const expected = tools().map(result);
  expect((await storage.load())?.messages.filter((message) => message.role === 'tool').map(result)).toEqual(expected);
  await session.disconnect();
  await session.connect(profile, { resume: true });
  expect(tools().map(result)).toEqual(expected);
  const wire = (await readFile(journal, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const entry of wire.filter((entry) => entry.method === 'initialize')) {
    expect(entry.params.clientCapabilities.terminal).toBe(false);
    expect(entry.params.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false });
  }
});

it('bounds accumulated command output before saving and restoring a conversation', async () => {
  const { session, storage, profile } = await fixture();
  await session.send('large-terminal-output');
  const saved = (await storage.load())?.messages.find((message) => message.toolCallId === 'large-output');
  expect(saved?.text).toContain('x'.repeat(100));
  expect(saved?.text).toContain('y'.repeat(100));
  expect(saved?.text.length).toBeLessThanOrEqual(256_000);
  expect(saved?.text.endsWith('[Content truncated]')).toBe(true);
  expect(saved?.text).not.toContain('ignored tail');
  await session.disconnect();
  await session.connect(profile, { resume: true });
  expect(session.snapshot().record.messages.find((message) => message.toolCallId === 'large-output')?.text).toBe(saved?.text);
});

it('keeps unfinished tool outcomes uncertain after cancellation and replay without claiming their commands stopped', async () => {
  const { session, storage, profile } = await fixture();
  const turn = session.send('terminal-hold');
  await expect
    .poll(() => session.snapshot().record.messages.find((message) => message.toolCallId === 'running-at-stop')?.text)
    .toContain('Output before cancellation');
  await session.cancel();
  await turn;
  const check = () => {
    const messages = session.snapshot().record.messages;
    expect(messages.find((message) => message.toolCallId === 'running-at-stop')).toMatchObject({ status: 'in_progress', uncertain: true });
    expect(messages.find((message) => message.toolCallId === 'pending-at-stop')).toMatchObject({ status: 'pending', uncertain: true });
    expect(messages.find((message) => message.toolCallId === 'finished-before-stop')?.uncertain).not.toBe(true);
    expect(messages.find((message) => message.toolCallId === 'running-at-stop')?.text).toContain('Output before cancellation');
  };
  check();
  expect((await storage.load())?.messages.find((message) => message.toolCallId === 'running-at-stop')?.uncertain).toBe(true);
  await session.disconnect();
  await session.connect(profile, { resume: true });
  check();
});
