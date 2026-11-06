import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetupCommand } from '../packages/engine/src/workspace.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fixture: FixtureRepo;
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

beforeEach(async () => {
  fixture = await makeFixtureRepo('warden-setup-process-');
});

afterEach(async () => {
  const pid = Number(await readFile(path.join(fixture.root, 'setup-child.pid'), 'utf8').catch(() => ''));
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Successful cleanup has already stopped and reaped this fixture child.
    }
  }
  await fixture.cleanup();
});

describe('owned setup process cleanup', () => {
  it.each(['timeout', 'stdout', 'stderr'])('stops foreground descendants before returning from %s failure', async (mode) => {
    const executable = quote(process.execPath.replaceAll('\\', '/'));
    const script = quote(path.resolve('test/fixtures/setup-child.mjs').replaceAll('\\', '/'));
    // The following shell builtin keeps a real parent shell around the foreground child.
    const command = `${executable} ${script} ${mode}; :`;
    const result = await runSetupCommand(fixture.root, fixture.root, command, {}, mode === 'timeout' ? 1500 : 10000);
    expect(result).toMatchObject({ status: 'failed', exitCode: null });
    expect(result.output).toContain(mode === 'timeout' ? 'time limit' : `${mode} exceeded`);
    expect(result.output!.length).toBeLessThanOrEqual(16000);
    expect(Number(await readFile(path.join(fixture.root, 'setup-child.pid'), 'utf8'))).toBeGreaterThan(0);
    const stopped = await readFile(path.join(fixture.root, 'setup-child-output.txt'), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await readFile(path.join(fixture.root, 'setup-child-output.txt'), 'utf8')).toBe(stopped);
  });
});
