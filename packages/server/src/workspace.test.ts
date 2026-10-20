import path from 'node:path';
import { execFile, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentChange } from '@warden/shared';
import { runWorkspaceHook, workspaceConfig, workspaceShell } from './workspace.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(execFile).mockImplementation((...args) => {
    const done = args[3] as Completion;
    done(null, args[0] === 'git' ? execPath : 'hook output\n', '');
    return {} as ChildProcess;
  });
});

afterEach(() => vi.unstubAllEnvs());

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
    expect(() => workspaceConfig({ hooks: { create: 'x'.repeat(20001) } })).toThrow('hook 应是 shell 命令字符串');
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
    await expect(workspaceShell(root, 'win32')).rejects.toThrow('未找到 Git for Windows 自带的 sh.exe');
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
    const invocation = vi.mocked(execFile).mock.calls.find((call) => call[0] !== 'git')!;
    expect(invocation[0]).toBe(process.platform === 'win32' ? path.win32.join(installation, 'bin', 'sh.exe') : '/bin/sh');
    expect(invocation[1]).toEqual(['-c', command]);
    expect(invocation[2]).toMatchObject({
      cwd: change.worktree,
      timeout: 60000,
      maxBuffer: 128 * 1024,
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
    vi.mocked(execFile).mockImplementation((...args) => {
      const done = args[3] as Completion;
      if (args[0] === 'git') done(null, execPath, '');
      else done(Object.assign(new Error('Command exited with 7'), { code: 7 }), 'x'.repeat(17000), 'validation failed');
      return {} as ChildProcess;
    });
    const result = await runWorkspaceHook(root, change, 'create', 'exit 7');
    expect(result).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(result.output).toHaveLength(16000);
    expect(result.output).toMatch(/validation failed\nCommand exited with 7$/);
  });

  it('exposes shell startup failures as a failed hook with a useful message', async () => {
    vi.mocked(execFile).mockImplementation((...args) => {
      const done = args[3] as Completion;
      if (args[0] === 'git') done(null, execPath, '');
      else done(Object.assign(new Error('spawn sh ENOENT'), { code: 'ENOENT' }), '', '');
      return {} as ChildProcess;
    });
    expect(await runWorkspaceHook(root, change, 'reuse', 'echo ready')).toMatchObject({
      status: 'failed',
      exitCode: null,
      output: expect.stringContaining('无法运行工作区 hook：找不到 shell'),
    });
  });
});
