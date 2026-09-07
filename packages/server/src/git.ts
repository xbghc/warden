import { execFile } from 'node:child_process';
import { HttpError } from './errors.js';

/** Sub-commands the server is allowed to run. Everything else is rejected before spawning. */
const ALLOWED_SUBCOMMANDS = new Set(['rev-parse', 'diff', 'show', 'log', 'worktree', 'ls-files', 'status']);

/** Options that could make an otherwise read-only sub-command write somewhere. */
const FORBIDDEN_OPTION_PREFIXES = ['--output', '--ext-diff', '--textconv', '-c', '--config-env', '--exec-path', '--git-dir', '--work-tree'];

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class GitError extends HttpError {
  constructor(
    message: string,
    public exitCode: number | null,
    public stderr: string,
    status = 500,
    code = 'git_error',
  ) {
    super(status, message, code);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Exit codes considered successful (default [0]). */
  okCodes?: number[];
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function assertAllowedGitArgs(args: readonly string[]): void {
  const sub = args[0];
  if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new GitError(`git sub-command not allowed: ${sub ?? '(none)'}`, null, '', 400, 'git_subcommand_forbidden');
  }
  if (sub === 'worktree' && args[1] !== 'list') {
    throw new GitError(`git worktree ${args[1] ?? ''} is not allowed`, null, '', 400, 'git_subcommand_forbidden');
  }
  for (const arg of args.slice(1)) {
    if (arg.includes('\0')) throw new GitError('NUL byte in git argument', null, '', 400, 'git_bad_argument');
    for (const prefix of FORBIDDEN_OPTION_PREFIXES) {
      if (arg === prefix || arg.startsWith(prefix + '=')) {
        throw new GitError(`git option not allowed: ${arg}`, null, '', 400, 'git_option_forbidden');
      }
    }
  }
}

/**
 * Run a read-only git command. Arguments are passed as an array to execFile, never through a shell.
 */
export async function runGit(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
  assertAllowedGitArgs(args);
  const okCodes = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          // Never take the index lock / refresh the index as a side effect of diff/status.
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        if (err) {
          if (err.killed || err.signal === 'SIGTERM') {
            reject(new GitError(`git ${args[0]} timed out`, null, stderr, 504, 'git_timeout'));
            return;
          }
          if (err.code === 'ENOENT') {
            reject(new GitError('git executable not found in PATH', null, '', 500, 'git_missing'));
            return;
          }
          const code = typeof err.code === 'number' ? err.code : -1;
          if (okCodes.includes(code)) {
            resolve({ stdout, stderr, code });
            return;
          }
          const msg = stderr.trim().split('\n')[0] || err.message;
          reject(new GitError(msg, code, stderr, 500, 'git_failed'));
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
  });
}

/** Returns true when the ref resolves to a commit in the given cwd. */
export async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  try {
    const r = await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd });
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
