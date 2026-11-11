import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentChange } from '@warden/shared';
import { assertSetupIdle, runSetupCommand, runWorkspaceHook, workspaceConfig, workspaceShell } from './workspace.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({ access: vi.fn() }));

type Completion = (error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void;
const installation = 'C:\\Portable Tools\\Git';
const execPath = `${installation}\\mingw64\\libexec\\git-core\n`;
const change = {
  id: 'task-123',
  worktree: path.resolve('workspace with spaces'),
  branch: 'task/validation',
  developmentBranch: 'feature/orders',
} as DevelopmentChange;
const root = path.resolve('primary checkout');

function simulatedProcess(stdout = 'hook output\n', stderr = '', code: number | null = 0, error?: NodeJS.ErrnoException) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  queueMicrotask(() => {
    if (error) child.emit('error', error);
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code, null);
  });
  return child as unknown as ChildProcess;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(execFile).mockImplementation((...args) => {
    const done = args[3] as Completion;
    done(null, args[0] === 'git' ? execPath : 'hook output\n', '');
    return {} as ChildProcess;
  });
  vi.mocked(spawn).mockImplementation(() => simulatedProcess());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('workspace hook configuration', () => {
  it('keeps only lifecycle hooks and preserves script text literally', () => {
    const create = 'printf "%s\\n" "$WARDEN_WORKTREE"; ./setup.sh "a quoted argument"';
    expect(workspaceConfig({ hooks: { create, reuse: '  ', unknown: 'exit 9' }, commands: [] })).toEqual({ hooks: { create } });
    expect(workspaceConfig({ hooks: {} })).toEqual({ hooks: {} });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { hooks: null }, { hooks: [] }, { hooks: 'script' }, { hooks: { create: 1 } }, { hooks: { reuse: 'echo\0bad' } }])(
    'rejects invalid configuration without starting a process: %j',
    (config) => {
      expect(() => workspaceConfig(config)).toThrow();
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it('rejects scripts above the input limit', () => {
    expect(() => workspaceConfig({ hooks: { create: 'x'.repeat(20001) } })).toThrow('A hook must be a shell command string.');
  });
});

describe('workspace shell selection', () => {
  it.each(['linux', 'darwin'] as const)('keeps /bin/sh on %s', async (platform) => {
    expect(await workspaceShell(root, platform)).toBe('/bin/sh');
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['mingw32', 'mingw64', 'ucrt64', 'clangarm64'])('finds the shell in a portable %s Git installation behind a PATH shim', async (toolchain) => {
    vi.stubEnv('GIT_EXEC_PATH', 'C:\\unrelated\\git-core');
    vi.stubEnv('GIT_DIR', 'C:\\unrelated\\.git');
    vi.mocked(execFile).mockImplementation((...args) => {
      (args[3] as Completion)(null, `${installation}\\${toolchain}\\libexec\\git-core\n`, '');
      return {} as ChildProcess;
    });
    expect(await workspaceShell(root, 'win32')).toBe(path.win32.join(installation, 'bin', 'sh.exe'));
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['--exec-path'],
      expect.objectContaining({ cwd: root, timeout: 5000, windowsHide: true }),
      expect.any(Function),
    );
    const options = vi.mocked(execFile).mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env.GIT_EXEC_PATH).toBeUndefined();
    expect(options.env.GIT_DIR).toBeUndefined();
  });

  it('accepts the usr/bin shell when the Git installation has no bin wrapper', async () => {
    const shell = path.win32.join(installation, 'usr', 'bin', 'sh.exe');
    vi.mocked(access).mockImplementation(async (file) => {
      if (file !== shell) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(await workspaceShell(root, 'win32')).toBe(shell);
  });

  it('finds a per-user installation when Git cannot be resolved from PATH', async () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\Reviewer\\AppData\\Local');
    const shell = 'C:\\Users\\Reviewer\\AppData\\Local\\Programs\\Git\\bin\\sh.exe';
    vi.mocked(execFile).mockImplementation((...args) => {
      (args[3] as Completion)(Object.assign(new Error('missing git'), { code: 'ENOENT' }), '', '');
      return {} as ChildProcess;
    });
    vi.mocked(access).mockImplementation(async (file) => {
      if (file !== shell) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(await workspaceShell(root, 'win32')).toBe(shell);
  });

  it('reports a missing Git for Windows shell explicitly', async () => {
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(workspaceShell(root, 'win32')).rejects.toThrow('sh.exe from Git for Windows was not found');
  });
});

describe('workspace hook process contract', () => {
  it.each(['create', 'reuse'] as const)('runs %s with the selected checkout, task context and bounded output', async (event) => {
    const command = 'printf "%s" "$WARDEN_TASK_ID"; printf "%s" "a quoted argument"';
    vi.stubEnv('GIT_WORK_TREE', '/unrelated');
    vi.stubEnv('GIT_INDEX_FILE', '/unrelated/index');
    vi.stubEnv('GIT_AUTHOR_NAME', 'Configured author');
    vi.stubEnv('WARDEN_TASK_ID', 'stale task');
    const result = await runWorkspaceHook(root, change, event, command);
    expect(result).toEqual({ event, command, status: 'succeeded', exitCode: 0, output: 'hook output\n' });
    const invocation = vi.mocked(spawn).mock.calls[0]!;
    expect(invocation[0]).toBe(process.platform === 'win32' ? path.win32.join(installation, 'bin', 'sh.exe') : '/bin/sh');
    expect(invocation[1]).toEqual(['-c', command]);
    expect(invocation[2]).toMatchObject({
      cwd: change.worktree,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        WARDEN_REPO: root,
        WARDEN_WORKTREE: change.worktree,
        WARDEN_BRANCH: change.branch,
        WARDEN_DEVELOPMENT_BRANCH: change.developmentBranch,
        WARDEN_TASK_ID: change.id,
        WARDEN_HOOK_EVENT: event,
        GIT_AUTHOR_NAME: 'Configured author',
      },
    });
    const options = invocation[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.GIT_WORK_TREE).toBeUndefined();
    expect(options.env.GIT_INDEX_FILE).toBeUndefined();
  });

  it('retains a failed command exit code and the tail of its diagnostics', async () => {
    vi.mocked(spawn).mockImplementation(() => simulatedProcess('x'.repeat(17000), 'validation failed', 7));
    const result = await runWorkspaceHook(root, change, 'create', 'exit 7');
    expect(result).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(result.output).toHaveLength(16000);
    expect(result.output).toMatch(/validation failed\nSetup script exited with 7\.$/);
  });

  it('exposes shell startup failures as a failed hook with a useful message', async () => {
    vi.mocked(spawn).mockImplementation(() => simulatedProcess('', '', null, Object.assign(new Error('spawn sh ENOENT'), { code: 'ENOENT' })));
    expect(await runWorkspaceHook(root, change, 'reuse', 'echo ready')).toMatchObject({
      status: 'failed',
      exitCode: null,
      output: expect.stringContaining('Cannot run the workspace setup script: shell not found'),
    });
  });

  it.skipIf(process.platform === 'win32')('rejects uncertain process cleanup instead of returning a retryable failed setup', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345 });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Cannot terminate the process group'), { code: 'EPERM' });
    });
    const result = runSetupCommand(root, change.worktree, 'setup', {}, 100);
    const checked = expect(result).rejects.toMatchObject({ code: 'setup_cleanup_failed' });
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
  });

  it.each([false, true])('waits for Windows tree termination and reports cleanup failure = %s', async (failed) => {
    vi.useFakeTimers();
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345 });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    let completeKill: Completion | undefined;
    vi.mocked(execFile).mockImplementation((...args) => {
      if (args[0] === 'git') (args[3] as Completion)(null, execPath, '');
      else completeKill = args[3] as Completion;
      return {} as ChildProcess;
    });
    const result = runSetupCommand(root, change.worktree, 'setup', {}, 100);
    const checked = failed
      ? expect(result).rejects.toMatchObject({ code: 'setup_cleanup_failed', message: expect.stringContaining('PID 12345') })
      : expect(result).resolves.toMatchObject({ status: 'failed', exitCode: null, output: expect.stringContaining('time limit') });
    let settled = false;
    void result.finally(() => (settled = true)).catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '12345', '/T', '/F'],
      expect.objectContaining({ windowsHide: true, timeout: 5000 }),
      expect.any(Function),
    );
    child.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    completeKill!(failed ? Object.assign(new Error('Access denied'), { code: 1 }) : null, '', '');
    await checked;
  });
});

describe('setup ownership guard', () => {
  const running = { status: 'running' as const, owner: { pid: 12345, hostname: os.hostname() } };

  it('allows an interrupted setup only when its valid same-host owner has exited', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No process'), { code: 'ESRCH' });
    });
    expect(() => assertSetupIdle(running)).not.toThrow();
    expect(() => assertSetupIdle(undefined)).not.toThrow();
    expect(() => assertSetupIdle({ status: 'failed' })).not.toThrow();
  });

  it('stays running while the setup process group outlives its host', () => {
    const group = 4321;
    const owner = { ...running.owner, group, startedAt: new Date().toISOString() };
    // The host is gone; only the detached group answers.
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -group) return true;
      throw Object.assign(new Error('No process'), { code: 'ESRCH' });
    });
    expect(() => assertSetupIdle({ ...running, owner })).toThrow('still running');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('No process'), { code: 'ESRCH' });
    });
    expect(() => assertSetupIdle({ ...running, owner })).not.toThrow();
  });

  it('treats a run recorded before this host started as ended', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(() => assertSetupIdle({ ...running, owner: { ...running.owner, group: 4321, startedAt: '2000-01-01T00:00:00.000Z' } })).not.toThrow();
  });

  it('blocks live, unowned, foreign-host and unverifiable setup processes', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(() => assertSetupIdle(running)).toThrow('still running');
    expect(() => assertSetupIdle({ status: 'running' })).toThrow('still running');
    expect(() => assertSetupIdle({ ...running, owner: { ...running.owner, hostname: `${os.hostname()}-other` } })).toThrow('still running');
    expect(() => assertSetupIdle({ ...running, owner: { ...running.owner, pid: -1 } })).toThrow('still running');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
    });
    expect(() => assertSetupIdle(running)).toThrow('still running');
  });
});
