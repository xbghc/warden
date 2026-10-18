import { createHash } from 'node:crypto';
import { DEFAULT_GIT_TIMEOUT_MS, gitEnvironment, GitError, runGitBuffer } from './git.js';
import { loadNativeBinding, type NativeWorktreeState } from './native.js';

/** One read of Git's status, HEAD and branch, without refreshing the repository's index. */
export type WorktreeState = NativeWorktreeState;

const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--no-ahead-behind', '-z'];

/**
 * Keep completed status reads uncached: agents and ordinary Git commands can change any checkout
 * outside Warden. Callers may share a read within their own request, but mutation guards must be
 * able to ask for a new observation. Native work runs on Tokio, away from the JavaScript thread.
 */
export async function readWorktreeState(cwd: string): Promise<WorktreeState> {
  const native = loadNativeBinding();
  if (!native) return readWorktreeStateWithGit(cwd);
  // A Node worker has its own process.env. Reading std::env in Rust would silently ignore that
  // worker's Git isolation (including the test suite's global/system configuration overrides).
  const environment = Object.fromEntries(Object.entries(gitEnvironment()).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const result = await native.readWorktreeState(cwd, environment);
  if (result.state) return result.state;
  const error = result.error;
  if (!error) throw new GitError('Native Git read returned no result', null, '', 500, 'git_failed');
  const [status, code]: [number, string] =
    error.kind === 'timeout'
      ? [504, 'git_timeout']
      : error.kind === 'missing_worktree'
        ? [400, 'unknown_worktree']
        : error.kind === 'missing_git'
          ? [500, 'git_missing']
          : [500, 'git_failed'];
  throw new GitError(error.message, error.exitCode ?? null, error.stderr, status, code);
}

/** Portable backend for platforms without a prebuilt native module, and the comparison baseline. */
export async function readWorktreeStateWithGit(cwd: string): Promise<WorktreeState> {
  const { stdout } = await runGitBuffer(STATUS_ARGS, { cwd, timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
  return parseWorktreeState(stdout);
}

/** Porcelain v2 fields are space-separated, but the final path can contain any non-NUL byte. */
function entryPath(entry: string, separators: number): string {
  let at = 0;
  for (let i = 0; i < separators; i++) {
    const space = entry.indexOf(' ', at);
    if (space < 0) throw invalidStatus();
    at = space + 1;
  }
  const value = entry.slice(at);
  if (!value) throw invalidStatus();
  return value;
}

function invalidStatus(): GitError {
  return new GitError('Invalid Git porcelain v2 status output', null, '', 500, 'git_failed');
}

export function parseWorktreeState(output: string | Buffer): WorktreeState {
  const state: WorktreeState = { dirtyCount: 0, statusFingerprint: createHash('sha256').update(output).digest('hex'), paths: [] };
  const stdout = typeof output === 'string' ? output : output.toString('utf8');
  const entries = stdout.split('\0');
  let sawHead = false;
  let sawBranch = false;
  if (!stdout.endsWith('\0')) throw invalidStatus();
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i]!;
    if (entry.startsWith('# branch.oid ')) {
      if (sawHead) throw invalidStatus();
      sawHead = true;
      const head = entry.slice('# branch.oid '.length);
      if (head !== '(initial)') {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw invalidStatus();
        state.head = head;
      }
    } else if (entry.startsWith('# branch.head ')) {
      if (sawBranch) throw invalidStatus();
      sawBranch = true;
      const branch = entry.slice('# branch.head '.length);
      if (!branch) throw invalidStatus();
      if (branch !== '(detached)') state.branch = branch;
    } else if (entry.startsWith('# ')) {
      // Headers can be added by newer Git versions; the porcelain contract says to ignore them.
    } else if (entry.startsWith('1 ')) {
      state.paths.push(entryPath(entry, 8));
      state.dirtyCount++;
    } else if (entry.startsWith('2 ')) {
      state.paths.push(entryPath(entry, 9));
      const origin = entries[++i];
      if (!origin || i >= entries.length - 1) throw invalidStatus();
      state.paths.push(origin);
      state.dirtyCount++;
    } else if (entry.startsWith('u ')) {
      state.paths.push(entryPath(entry, 10));
      state.dirtyCount++;
    } else if (entry.startsWith('? ')) {
      state.paths.push(entryPath(entry, 1));
      state.dirtyCount++;
    } else if (!entry.startsWith('! ')) {
      throw invalidStatus();
    }
  }
  if (!sawHead || !sawBranch) throw invalidStatus();
  return state;
}
