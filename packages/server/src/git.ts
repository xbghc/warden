import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { HttpError } from './errors.js';

/** Sub-commands the server is allowed to run. Everything else is rejected before spawning. */
const ALLOWED_SUBCOMMANDS = new Set([
  'rev-parse',
  'diff',
  'show',
  'log',
  'worktree',
  'ls-files',
  'status',
  'merge-base',
  'rev-list',
  'for-each-ref',
  'check-ref-format',
  'grep',
]);

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

/**
 * Points git at warden's own object store instead of the repository's for one command. New objects
 * land in `objects`, the repository's are still read through `alternates`, and `index`, when given,
 * stands in for the real index. This is how checkpoints are taken and read without the repository
 * seeing any of it (see checkpoints.ts).
 */
export interface SnapshotEnv {
  objects: string;
  alternates: string;
  index?: string;
}

function snapshotVars(snapshot: SnapshotEnv | undefined): Record<string, string> {
  if (!snapshot) return {};
  return {
    GIT_OBJECT_DIRECTORY: snapshot.objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: snapshot.alternates,
    ...(snapshot.index ? { GIT_INDEX_FILE: snapshot.index } : {}),
  };
}

export interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Exit codes considered successful (default [0]). */
  okCodes?: number[];
  snapshot?: SnapshotEnv;
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
  // `grep -O` / `--open-files-in-pager` runs a program on the matches. Git takes any unambiguous
  // prefix of a long option, so everything that could be one is refused, not just the full name.
  if (sub === 'grep') {
    for (const arg of args.slice(1)) {
      if (arg === '--') break;
      const name = arg.split('=')[0]!;
      if (arg.startsWith('-O') || (name.length > 3 && '--open-files-in-pager'.startsWith(name))) {
        throw new GitError(`git option not allowed: ${arg}`, null, '', 400, 'git_option_forbidden');
      }
    }
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
          ...snapshotVars(opts.snapshot),
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

/**
 * Runs a git command that writes to the repository, without the read whitelist. Only worktrees.ts
 * calls it — `worktree add`, `worktree remove`, `branch` (with `-d`, or `-D` to undo a branch it
 * made moments before), and in a slot it owns `switch`, `reset --hard` and `clean -fd` — each with an argument
 * list it composes itself from a branch name and a ref that were validated first and a slot path
 * of its own making, so nothing from a request reaches git as an option. A failure carries git's
 * first stderr line, and `stderr` whole, so the caller can tell a refusal (dirty worktree, branch
 * in use) from a crash.
 */
export async function runGitWrite(args: readonly string[], opts: { cwd: string; timeoutMs?: number }): Promise<GitResult> {
  return execWrite(args, opts, {});
}

/**
 * The writes a checkpoint needs, and nothing else: `add --all` (with `--intent-to-add` for a diff)
 * and `write-tree --missing-ok`, always into an index and an object directory of warden's own. No
 * alternates are set here, deliberately: git "freshens" an object it finds in one — touches its
 * mtime — so the repository's objects would be written after all. Without them the entries git
 * does not re-hash point at objects this store lacks, which `--missing-ok` allows; reads of the
 * tree pass the alternates (see `SnapshotEnv`). Only checkpoints.ts calls it, with fixed arguments.
 */
export async function runGitSnapshot(args: readonly string[], opts: { cwd: string; objects: string; index: string; timeoutMs?: number }): Promise<GitResult> {
  const allowed =
    (args[0] === 'add' && args[1] === '--all' && args.slice(2).every((a) => a === '--intent-to-add')) ||
    (args[0] === 'write-tree' && args[1] === '--missing-ok' && args.length === 2);
  if (!allowed) throw new GitError(`not a snapshot command: git ${args.join(' ')}`, null, '', 400, 'git_subcommand_forbidden');
  return execWrite(args, opts, { GIT_OBJECT_DIRECTORY: opts.objects, GIT_INDEX_FILE: opts.index });
}

function execWrite(args: readonly string[], opts: { cwd: string; timeoutMs?: number }, extraEnv: Record<string, string>): Promise<GitResult> {
  for (const arg of args) if (arg.includes('\0')) throw new GitError('NUL byte in git argument', null, '', 400, 'git_bad_argument');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', ...extraEnv },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        if (!err) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        if (err.killed || err.signal === 'SIGTERM') {
          reject(new GitError(`git ${args[0]} timed out`, null, stderr, 504, 'git_timeout'));
          return;
        }
        if (err.code === 'ENOENT') {
          if (!existsSync(opts.cwd)) {
            reject(new GitError(`working directory no longer exists: ${opts.cwd}`, null, '', 400, 'unknown_worktree'));
            return;
          }
          reject(new GitError('git executable not found in PATH', null, '', 500, 'git_missing'));
          return;
        }
        const code = typeof err.code === 'number' ? err.code : -1;
        const first = stderr.split('\n').find((l) => l.trim()) ?? err.message;
        reject(new GitError(first.trim().replace(/^(fatal|error): /, ''), code, stderr, 500, 'git_failed'));
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

/** Merge base of two refs; undefined when they share no history or a ref is unknown. */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  try {
    const r = await runGit(['merge-base', a, b], { cwd });
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
