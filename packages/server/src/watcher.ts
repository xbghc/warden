import path from 'node:path';
import { stat } from 'node:fs/promises';
import { runGit } from './git.js';
import { currentBranch } from './repo.js';

export const DEFAULT_POLL_INTERVAL_MS = 1_500;

export interface RepoChange {
  head: string;
  branch: string;
  at: string;
}

export type ChangeListener = (change: RepoChange) => void;

/**
 * `git status --porcelain -z` output, as the paths it mentions. Rename and copy entries carry the
 * origin path in a second NUL-separated field, which has to be consumed or it is read as an entry.
 */
export function statusPaths(out: string): string[] {
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const p = entry.slice(3);
    if (p) paths.push(p);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const origin = parts[++i];
      if (origin) paths.push(origin);
    }
  }
  return paths;
}

/**
 * Polls one worktree and reports that something changed. Only runs while somebody is subscribed.
 *
 * The signature covers more than `git status` alone: editing an already-modified file leaves the
 * porcelain output byte-identical, so the mtime and size of every path status mentions are folded
 * in as well. The branch name is part of it too — checking out a different branch that points at
 * the same commit is still a change worth reporting.
 */
export class RepoWatcher {
  private readonly listeners = new Set<ChangeListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private signature: string | null = null;
  private polling = false;

  constructor(
    private readonly root: string,
    private readonly intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  get subscriberCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // The next subscriber re-baselines rather than being handed a change it never saw.
    this.signature = null;
  }

  /**
   * Runs one comparison. Returns the change that was broadcast, or undefined when nothing moved.
   * The first poll of a watch only records the baseline. Public so tests can step it deterministically.
   */
  async poll(): Promise<RepoChange | undefined> {
    if (this.polling) return undefined;
    this.polling = true;
    try {
      const snap = await this.snapshot();
      const baseline = this.signature === null;
      if (this.signature === snap.signature) return undefined;
      this.signature = snap.signature;
      if (baseline) return undefined;
      const change: RepoChange = { head: snap.head, branch: snap.branch, at: new Date().toISOString() };
      for (const listener of [...this.listeners]) {
        try {
          listener(change);
        } catch {
          /* a failing subscriber must not stop the others */
        }
      }
      return change;
    } catch {
      // A transient git failure (index.lock held by another process) is not a change.
      return undefined;
    } finally {
      this.polling = false;
    }
  }

  private async snapshot(): Promise<{ signature: string; head: string; branch: string }> {
    const [statusRes, headRes, branch] = await Promise.all([
      runGit(['status', '--porcelain', '-z'], { cwd: this.root }),
      runGit(['rev-parse', 'HEAD'], { cwd: this.root }).catch(() => ({ stdout: '' })),
      // The same label getRepoInfo reports, so the branch identity the client filters todos by
      // never flips between `HEAD` and a short sha depending on which of the two spoke last.
      currentBranch(this.root),
    ]);
    const head = headRes.stdout.trim();
    const stats = await Promise.all(
      statusPaths(statusRes.stdout).map(async (rel) => {
        try {
          const st = await stat(path.join(this.root, rel));
          return `${rel}\t${st.mtimeMs}\t${st.size}`;
        } catch {
          return `${rel}\t-`;
        }
      }),
    );
    return { signature: [head, branch, statusRes.stdout, ...stats].join('\n'), head, branch };
  }
}
