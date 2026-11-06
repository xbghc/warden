import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DevelopmentChange, WorkspaceConfig, WorkspaceHookResult } from '@warden/shared';
import { badRequest, WardenError } from './errors.js';
import { gitEnvironment } from './git.js';

/** A failed cleanup leaves the running record occupied until its owner is known to be gone. */
export function assertSetupIdle(hook: Pick<WorkspaceHookResult, 'status' | 'owner'> | undefined, kind: 'workspace' | 'preview' = 'workspace'): void {
  if (hook?.status !== 'running') return;
  const owner = hook.owner;
  if (owner?.hostname === os.hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  throw new WardenError(
    409,
    `The ${kind} setup script is still running or its process state is unknown. Wait for it to finish. If cleanup failed, stop its commands and close the owning Warden window before retrying.`,
    'setup_running',
  );
}

/** Configuration is saved explicitly by the user, never loaded from a task branch. */
export function workspaceConfig(value: unknown): WorkspaceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Workspace configuration must be an object.');
  const row = value as WorkspaceConfig;
  if (!row.hooks || typeof row.hooks !== 'object' || Array.isArray(row.hooks)) throw badRequest('Provide a hooks object.');
  const hooks: WorkspaceConfig['hooks'] = {};
  for (const event of ['create', 'reuse'] as const) {
    const command = row.hooks[event];
    if (command !== undefined && (typeof command !== 'string' || command.length > 20000 || command.includes('\0')))
      throw badRequest('A hook must be a shell command string.');
    if (command?.trim()) hooks[event] = command;
  }
  const previewSetup = row.previewSetup;
  if (previewSetup !== undefined && (typeof previewSetup !== 'string' || previewSetup.length > 20000 || previewSetup.includes('\0')))
    throw badRequest('The preview setup script must be a shell command string.');
  return { hooks, ...(previewSetup?.trim() ? { previewSetup } : {}) };
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
  throw new Error('Cannot run the workspace setup script: sh.exe from Git for Windows was not found. Install Git for Windows and add git to PATH.');
}

/** A thin shell-command hook: cwd and environment in, output and exit status out. */
export async function runWorkspaceHook(root: string, change: DevelopmentChange, event: 'create' | 'reuse', command: string): Promise<WorkspaceHookResult> {
  return {
    event,
    command,
    ...(await runSetupCommand(root, change.worktree, command, {
      WARDEN_BRANCH: change.branch,
      WARDEN_DEVELOPMENT_BRANCH: change.developmentBranch,
      WARDEN_TASK_ID: change.id,
      WARDEN_HOOK_EVENT: event,
    })),
  };
}

/** Explicit user-configured commands only; preview scripts never come from task metadata. */
export async function runSetupCommand(
  root: string,
  cwd: string,
  command: string,
  environment: Record<string, string> = {},
  timeout = 600000,
): Promise<Pick<WorkspaceHookResult, 'status' | 'exitCode' | 'output'>> {
  let shell: string;
  try {
    shell = await workspaceShell(root);
  } catch (error) {
    return { status: 'failed', exitCode: null, output: error instanceof Error ? error.message : String(error) };
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    const env = { ...gitEnvironment(), WARDEN_REPO: root, WARDEN_WORKTREE: cwd, ...environment };
    const startupFailure = (error: NodeJS.ErrnoException) => {
      const message = error.code === 'ENOENT' ? `Cannot run the workspace setup script: shell not found (${shell}). ${error.message}` : error.message;
      resolve({ status: 'failed', exitCode: null, output: message });
    };
    try {
      // Setup scripts belong to Warden. A separate process group lets a limit stop their
      // foreground descendants before the repository lock is released for another write.
      child = spawn(shell, ['-c', command], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      startupFailure(error as NodeJS.ErrnoException);
      return;
    }
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: string | undefined;
    let startupError: NodeJS.ErrnoException | undefined;
    let stopping: Promise<void> | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let closed = false;
    let close: () => void;
    const closing = new Promise<void>((resolve) => {
      close = resolve;
    });
    const finish = () => {
      if (startupError) return startupFailure(startupError);
      const message = failure ?? (exitCode === 0 ? undefined : `Setup script exited with ${exitSignal ?? exitCode}.`);
      resolve({
        status: message ? 'failed' : 'succeeded',
        exitCode: failure ? null : exitCode,
        output: [stdout, stderr, message].filter(Boolean).join('\n').slice(-16000),
      });
    };
    const stop = (message: string) => {
      if (stopping) return;
      failure = message;
      clearTimeout(timer);
      stopping = (async () => {
        try {
          if (child.pid) await stopSetupTree(child.pid, env);
          if (!closed) {
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                closing,
                new Promise<never>((_resolve, reject) => {
                  deadline = setTimeout(() => reject(new Error('The setup process did not close after termination.')), 5000);
                }),
              ]);
            } finally {
              clearTimeout(deadline);
            }
          }
        } catch (error) {
          // Do not publish a retryable failed setup when its commands may still be writing.
          const identity = process.platform === 'win32' ? 'process tree rooted at PID' : 'process group';
          throw new WardenError(
            409,
            `Unable to stop setup ${identity} ${child.pid ?? 'unknown'}. Stop its commands and close the owning Warden window before retrying: ${String(error)}`,
            'setup_cleanup_failed',
          );
        }
      })();
      void stopping.then(finish, reject);
    };
    const timer = setTimeout(() => stop(`Setup script exceeded its ${timeout} ms time limit.`), timeout);
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      stdout = (stdout + chunk).slice(-16000);
      if (outputBytes > 128 * 1024) stop('Setup script stdout exceeded its 128 KiB output limit.');
    });
    child.stdout!.on('error', (error: Error) => stop(`Unable to read setup stdout: ${error.message}`));
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      errorBytes += Buffer.byteLength(chunk);
      stderr = (stderr + chunk).slice(-16000);
      if (errorBytes > 128 * 1024) stop('Setup script stderr exceeded its 128 KiB output limit.');
    });
    child.stderr!.on('error', (error: Error) => stop(`Unable to read setup stderr: ${error.message}`));
    child.once('error', (error: NodeJS.ErrnoException) => {
      startupError = error;
    });
    child.once('close', (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timer);
      close();
      if (!stopping) finish();
    });
  });
}

/** Force termination avoids a shell exiting while a child ignores a graceful signal. */
async function stopSetupTree(pid: number, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return;
  }
  const variables = new Map(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]));
  const windows = variables.get('SYSTEMROOT') ?? variables.get('WINDIR');
  if (!windows || !path.win32.isAbsolute(windows)) throw new Error('The Windows system directory is unavailable.');
  await new Promise<void>((resolve, reject) => {
    execFile(path.win32.join(windows, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, env }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
