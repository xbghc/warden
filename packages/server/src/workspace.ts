import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { DevelopmentChange, WorkspaceConfig, WorkspaceHookResult } from '@warden/shared';
import { badRequest } from './errors.js';
import { gitEnvironment } from './git.js';

/** Configuration is saved explicitly by the user, never loaded from a task branch. */
export function workspaceConfig(value: unknown): WorkspaceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('工作区配置必须是对象');
  const row = value as WorkspaceConfig;
  if (!row.hooks || typeof row.hooks !== 'object' || Array.isArray(row.hooks)) throw badRequest('请提供 hooks 对象');
  const hooks: WorkspaceConfig['hooks'] = {};
  for (const event of ['create', 'reuse'] as const) {
    const command = row.hooks[event];
    if (command !== undefined && (typeof command !== 'string' || command.length > 20000 || command.includes('\0')))
      throw badRequest('hook 应是 shell 命令字符串');
    if (command?.trim()) hooks[event] = command;
  }
  return { hooks };
}

/** Git's own installation supplies the POSIX shell on Windows, including portable installations. */
export async function workspaceShell(root: string, platform = process.platform): Promise<string> {
  if (platform !== 'win32') return '/bin/sh';
  const env = gitEnvironment();
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'GIT_EXEC_PATH') delete env[key];
  const execPath = await new Promise<string | undefined>((resolve) => {
    execFile('git', ['--exec-path'], { cwd: root, env, encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
  const roots: string[] = [];
  // Ask Git rather than resolving git.exe on PATH: package-manager shims need not be inside Git.
  if (execPath && path.win32.isAbsolute(execPath) && /[\\/]libexec[\\/]git-core[\\/]?$/i.test(execPath))
    roots.push(path.win32.resolve(execPath, '..', '..', '..'));
  const environment = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  for (const name of ['PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)']) {
    const dir = environment.get(name);
    if (dir) roots.push(path.win32.join(dir, 'Git'));
  }
  const local = environment.get('LOCALAPPDATA');
  if (local) roots.push(path.win32.join(local, 'Programs', 'Git'));
  for (const installation of new Set(roots)) {
    for (const directory of ['bin', path.win32.join('usr', 'bin')]) {
      const shell = path.win32.join(installation, directory, 'sh.exe');
      if (
        await access(shell).then(
          () => true,
          () => false,
        )
      )
        return shell;
    }
  }
  throw new Error('无法运行工作区 hook：未找到 Git for Windows 自带的 sh.exe，请安装 Git for Windows 并将 git 加入 PATH。');
}

/** A thin shell-command hook: cwd and environment in, output and exit status out. */
export async function runWorkspaceHook(root: string, change: DevelopmentChange, event: 'create' | 'reuse', command: string): Promise<WorkspaceHookResult> {
  let shell: string;
  try {
    shell = await workspaceShell(root);
  } catch (error) {
    return { event, command, status: 'failed', exitCode: null, output: error instanceof Error ? error.message : String(error) };
  }
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-c', command],
      {
        cwd: change.worktree,
        timeout: 60000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: {
          ...gitEnvironment(),
          WARDEN_REPO: root,
          WARDEN_WORKTREE: change.worktree,
          WARDEN_BRANCH: change.branch,
          WARDEN_DEVELOPMENT_BRANCH: change.developmentBranch,
          WARDEN_TASK_ID: change.id,
          WARDEN_HOOK_EVENT: event,
        },
      },
      (error, stdout, stderr) =>
        resolve({
          event,
          command,
          status: error ? 'failed' : 'succeeded',
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          output: [stdout, stderr, error?.code === 'ENOENT' ? `无法运行工作区 hook：找不到 shell（${shell}）。${error.message}` : error?.message]
            .filter(Boolean)
            .join('\n')
            .slice(-16000),
        }),
    );
  });
}
