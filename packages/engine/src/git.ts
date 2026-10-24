import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { WardenError } from './errors.js';

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
  'config',
  'var',
  'fsck',
]);

/** The only forms of `git config` that read: anything else it takes (a value, `--unset`, `--edit`) writes. */
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp']);

/** Options that could make an otherwise read-only sub-command write somewhere. */
const FORBIDDEN_OPTION_PREFIXES = ['--output', '--ext-diff', '--textconv', '-c', '--config-env', '--exec-path', '--git-dir', '--work-tree'];

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Diffs parsed or applied by Warden need a stable format even under user display settings.
 * Textconv would substitute converted content, custom prefixes would change the paths apply
 * strips, and submodule summaries would hide gitlink changes. Keep context for ordinary apply.
 */
export const DIFF_OUTPUT_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '-U3'] as const;

export class GitError extends WardenError {
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
 * stands in for the real index. This is how snapshots are taken and read without the repository
 * seeing any of it (see snapshots.ts).
 */
export interface SnapshotEnv {
  objects: string;
  alternates: string;
  index?: string;
}

// Git exports repository-local variables to hooks and other child processes. A server started
// there must still operate on its validated cwd, never the caller's repository, index or objects.
// Keep normal user/system configuration and identity/signing settings for real delivery commits.
const REPOSITORY_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_SUPER_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_SHALLOW_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]);

export function gitEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    // Environment names are case-insensitive on Windows, including when the server runs in a worker.
    const name = key.toUpperCase();
    if (REPOSITORY_ENV.has(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete env[key];
  }
  return { ...env, LC_ALL: 'C', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', ...overrides };
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

export interface GitBufferResult {
  stdout: Buffer;
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
  // One read and one name or pattern, nothing else: `--file`, `--global` or a second argument
  // (the value to set) would each turn it into something other than a lookup in this repository.
  if (sub === 'config' && (!CONFIG_READS.has(args[1] ?? '') || args.length !== 3 || args[2]!.startsWith('-'))) {
    throw new GitError(`git config ${args.slice(1).join(' ')} is not allowed`, null, '', 400, 'git_subcommand_forbidden');
  }
  // These two variables only resolve attribute-file paths, used to decide whether an isolated
  // synchronization check has reusable inputs. Other `var` forms are outside this read API.
  if (sub === 'var' && (args.length !== 2 || !['GIT_ATTR_SYSTEM', 'GIT_ATTR_GLOBAL'].includes(args[1] ?? ''))) {
    throw new GitError(`git var ${args.slice(1).join(' ')} is not allowed`, null, '', 400, 'git_subcommand_forbidden');
  }
  // Backup verification may inspect object connectivity, but must never write lost-found
  // files or accept caller-selected objects and alternate fsck modes.
  if (sub === 'fsck' && (args.length !== 3 || args[1] !== '--full' || args[2] !== '--no-dangling')) {
    throw new GitError('only read-only backup fsck is allowed', null, '', 400, 'git_subcommand_forbidden');
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
  const result = await runGitBuffer(args, opts);
  return { ...result, stdout: result.stdout.toString('utf8') };
}

/** The same guarded read, preserving bytes for NUL protocols and lossless fingerprints. */
export async function runGitBuffer(args: readonly string[], opts: GitRunOptions): Promise<GitBufferResult> {
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
        encoding: 'buffer',
        env: gitEnvironment({
          // Never take the index lock / refresh the index as a side effect of diff/status.
          GIT_OPTIONAL_LOCKS: '0',
          ...snapshotVars(opts.snapshot),
        }),
        windowsHide: true,
      },
      (error, stdout, stderrBytes) => {
        const stderr = stderrBytes.toString('utf8');
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
 * Runs a git command that writes to the repository, without the read whitelist. worktrees.ts
 * and clones.ts call it for `worktree add`, `worktree remove`, `branch` (with `-d`, or `-D` to undo a
 * branch it made moments before), and in a slot it owns `switch`, `reset --hard` and `clean -fd`;
 * for a clone slot also `clone --local`, `remote add` / `remove` / `set-url` / `set-head` and
 * `fetch` — each with an argument list it composes itself from a branch name and a ref that were
 * validated first, a slot path of its own making, and remote names and URLs read from the main
 * worktree's config, so nothing from a request reaches git as an option. A failure carries git's
 * first stderr line, and `stderr` whole, so the caller can tell a refusal (dirty worktree, branch in
 * use) from a crash.
 * workflow.ts also composes local fetch, rebase/abort, recovery update-ref, squash merge without
 * committing, and ordinary commit commands in the selected development checkout after validation.
 *
 * `network` is for the one command that reaches the server, a clone's `fetch`: it gets minutes
 * rather than seconds, and runs in a session of its own, without the terminal warden was started
 * from, so that ssh wanting a passphrase fails at once instead of waiting on a prompt nobody sees.
 */
export async function runGitWrite(args: readonly string[], opts: { cwd: string; timeoutMs?: number; network?: boolean }): Promise<GitResult> {
  return execWrite(args, opts, {});
}

/** How long a command that reaches the server, or copies a whole repository, may take. */
export const LONG_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * The writes a snapshot needs, and nothing else: `add --all` (with `--intent-to-add` for a diff)
 * and `write-tree --missing-ok`, always into an index and an object directory of warden's own. No
 * alternates are set here, deliberately: git "freshens" an object it finds in one — touches its
 * mtime — so the repository's objects would be written after all. Without them the entries git
 * does not re-hash point at objects this store lacks, which `--missing-ok` allows; reads of the
 * tree pass the alternates (see `SnapshotEnv`). Only snapshots.ts calls it, with fixed arguments.
 */
export async function runGitSnapshot(args: readonly string[], opts: { cwd: string; objects: string; index: string; timeoutMs?: number }): Promise<GitResult> {
  const allowed =
    (args[0] === 'add' && args[1] === '--all' && args.slice(2).every((a) => a === '--intent-to-add')) ||
    (args[0] === 'write-tree' && args[1] === '--missing-ok' && args.length === 2);
  if (!allowed) throw new GitError(`not a snapshot command: git ${args.join(' ')}`, null, '', 400, 'git_subcommand_forbidden');
  return execWrite(args, opts, { GIT_OBJECT_DIRECTORY: opts.objects, GIT_INDEX_FILE: opts.index });
}

/** How a command failed, as `execFile` reports it: an exit code, or `ENOENT` and the like. */
interface ExecFailure {
  message: string;
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
}
type ExecCallback = (error: ExecFailure | null, stdout: string, stderr: string) => void;

/**
 * `execFile` for a command that may reach the server: in a session of its own (`detached`, which
 * `execFile` does not pass on), so it has no terminal for ssh to prompt on, and killed as a whole
 * process group on timeout, ssh included. Reports the way `execFile` does.
 */
function execDetached(args: readonly string[], opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }, done: ExecCallback): void {
  const child = spawn('git', [...args], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  let killed = false;
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d;
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d;
  });
  const timer = setTimeout(() => {
    killed = true;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }, opts.timeout);
  // A spawn that fails (no git, no directory) reports `error` and then `close`; the first one answers.
  let settled = false;
  const settle: ExecCallback = (err, out, errOut) => {
    clearTimeout(timer);
    if (!settled) done(err, out, errOut);
    settled = true;
  };
  child.once('error', (e: NodeJS.ErrnoException) => settle({ message: e.message, code: e.code }, stdout, stderr));
  child.once('close', (code, signal) => {
    if (code === 0 && !killed) settle(null, stdout, stderr);
    else settle({ message: `git ${args[0]} exited with ${code ?? signal}`, code, killed, signal }, stdout, stderr);
  });
}

function execWrite(
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number; network?: boolean },
  extraEnv: Record<string, string>,
): Promise<GitResult> {
  for (const arg of args) if (arg.includes('\0')) throw new GitError('NUL byte in git argument', null, '', 400, 'git_bad_argument');
  return new Promise((resolve, reject) => {
    const done: ExecCallback = (err, stdout, stderr) => {
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
    };
    const env = gitEnvironment(extraEnv);
    if (opts.network) {
      execDetached(args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? LONG_GIT_TIMEOUT_MS, env }, done);
      return;
    }
    execFile(
      'git',
      [...args],
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env, windowsHide: true },
      (error, stdout, stderr) => done(error, stdout, stderr),
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
