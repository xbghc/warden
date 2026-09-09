import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { HttpError } from './errors.js';

/** Sub-commands the server is allowed to run. Everything else is rejected before spawning. */
const ALLOWED_SUBCOMMANDS = new Set(['rev-parse', 'diff', 'show', 'log', 'worktree', 'ls-files', 'status', 'merge-base']);

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
            // execFile reports a working directory that is gone exactly like a missing binary. The
            // former is a worktree deleted since it was listed: a request problem, not a setup one.
            if (opts.cwd && !existsSync(opts.cwd)) {
              reject(new GitError(`working directory no longer exists: ${opts.cwd}`, null, '', 400, 'unknown_worktree'));
              return;
            }
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

/**
 * The one write the server makes to a repository: apply a patch to the index (`git apply --cached`),
 * which is how selected lines are staged or, with `reverse`, unstaged. Deliberately not routed
 * through `runGit` and its whitelist: `apply` stays forbidden everywhere else, and this function
 * takes no arguments beyond the patch itself. It never touches the working tree or HEAD.
 */
export async function applyToIndex(cwd: string, patch: string, opts: { reverse?: boolean; timeoutMs?: number } = {}): Promise<void> {
  // A lock held by another process (an agent mid-`git add`) is usually gone within a moment.
  for (let attempt = 1; ; attempt++) {
    try {
      await applyOnce(cwd, patch, opts);
      return;
    } catch (e) {
      if (!(e instanceof GitError && e.code === 'index_locked') || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
}

async function applyOnce(cwd: string, patch: string, opts: { reverse?: boolean; timeoutMs?: number }): Promise<void> {
  const args = ['apply', '--cached', '--whitespace=nowarn'];
  if (opts.reverse) args.push('--reverse');
  args.push('-');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        if (!err) {
          resolve();
          return;
        }
        if (err.killed || err.signal === 'SIGTERM') {
          reject(new GitError('git apply timed out', null, stderr, 504, 'git_timeout'));
          return;
        }
        if (err.code === 'ENOENT') {
          if (!existsSync(cwd)) {
            reject(new GitError(`working directory no longer exists: ${cwd}`, null, '', 400, 'unknown_worktree'));
            return;
          }
          reject(new GitError('git executable not found in PATH', null, '', 500, 'git_missing'));
          return;
        }
        const code = typeof err.code === 'number' ? err.code : -1;
        const first = stderr.trim().split('\n')[0] || err.message;
        // Another process holds the index (an agent mid-`git add`, say): not our fault, try again shortly.
        if (/index\.lock/.test(stderr)) {
          reject(new GitError('the index is locked by another git process; try again', code, stderr, 409, 'index_locked'));
          return;
        }
        // The patch was built from a diff git just produced, so a refusal means the file, the index
        // or both moved since — the client must reload before choosing again.
        reject(new GitError(first.replace(/^error: /, ''), code, stderr, 409, 'apply_failed'));
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(patch);
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

/** Merge base of two refs; undefined when they share no history or a ref is unknown. */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  try {
    const r = await runGit(['merge-base', a, b], { cwd });
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
