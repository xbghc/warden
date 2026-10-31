import { createHash } from 'node:crypto';
import { DEFAULT_GIT_TIMEOUT_MS, GitError, runGitBuffer } from './git.js';

/** One read of Git's status, HEAD and branch, without refreshing the repository's index. */
export interface WorktreeState {
  head?: string;
  branch?: string;
  dirtyCount: number;
  statusFingerprint: string;
  paths: string[];
}

const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--no-ahead-behind', '-z'];
const STATUS_CONCURRENCY = 8;
let activeReads = 0;
const waitingReads = new Set<() => void>();

function statusTimeout(): GitError {
  return new GitError('git status timed out', null, '', 504, 'git_timeout');
}

async function acquireStatusSlot(deadline: number): Promise<void> {
  if (activeReads < STATUS_CONCURRENCY) {
    activeReads++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        waitingReads.delete(ready);
        reject(statusTimeout());
      },
      Math.max(1, Math.ceil(deadline - performance.now())),
    );
    waitingReads.add(ready);
  });
}

function releaseStatusSlot(): void {
  const next = waitingReads.values().next().value;
  if (next) {
    // Transfer the slot before waking the oldest waiter so new callers cannot bypass the queue.
    waitingReads.delete(next);
    next();
  } else {
    activeReads--;
  }
}

/**
 * Keep completed status reads uncached: agents and ordinary Git commands can change any checkout
 * outside Warden. Callers may share a read within their own request, but mutation guards must be
 * able to ask for a new observation. Bound concurrent Git processes and include queue time in
 * the deadline so a batch of workspaces cannot create an unbounded process burst or wait.
 */
export async function readWorktreeState(cwd: string): Promise<WorktreeState> {
  const deadline = performance.now() + DEFAULT_GIT_TIMEOUT_MS;
  await acquireStatusSlot(deadline);
  try {
    const timeoutMs = Math.ceil(deadline - performance.now());
    if (timeoutMs <= 0) throw statusTimeout();
    const { stdout } = await runGitBuffer(STATUS_ARGS, { cwd, timeoutMs });
    return parseWorktreeState(stdout);
  } finally {
    releaseStatusSlot();
  }
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
