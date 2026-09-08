import os from 'node:os';
import path from 'node:path';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { Prefs, ReviewState, TargetState } from '@warden/shared';
import { commentScopeKey } from '@warden/shared';
import { sha1 } from './hash.js';

export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'warden');
}

export function repoHash(repoRoot: string): string {
  return sha1(repoRoot).slice(0, 12);
}

export function stateFilePath(repoRoot: string, baseDir = dataDir()): string {
  return path.join(baseDir, repoHash(repoRoot), 'state.json');
}

export function defaultPrefs(): Prefs {
  return { viewMode: 'unified', nvimSocketByRoot: {}, autoRefresh: true };
}

export function defaultState(repoRoot: string): ReviewState {
  return { schemaVersion: 1, repoRoot, targets: {}, issues: [], todos: [], prefs: defaultPrefs() };
}

export function ensureTarget(state: ReviewState, key: string): TargetState {
  let t = state.targets[key];
  if (!t) {
    t = { viewed: {}, comments: [] };
    state.targets[key] = t;
  }
  return t;
}

/** The fields the rest of the server dereferences without checking; anything else is a corrupt row. */
const usable = (v: unknown): boolean => !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';
const usableComment = (v: unknown): boolean => usable(v) && typeof (v as { anchor?: unknown }).anchor === 'object' && !!(v as { anchor?: unknown }).anchor;

function normalise(raw: unknown, repoRoot: string): ReviewState {
  const base = defaultState(repoRoot);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<ReviewState>;
  if (r.schemaVersion !== 1) return base;
  const targets: ReviewState['targets'] = {};
  for (const [k, v] of Object.entries(r.targets ?? {})) {
    if (!v || typeof v !== 'object') continue;
    targets[k] = {
      viewed: typeof v.viewed === 'object' && v.viewed ? v.viewed : {},
      comments: Array.isArray(v.comments) ? v.comments.filter(usableComment) : [],
      ...(typeof v.head === 'string' ? { head: v.head } : {}),
    };
  }
  migrateLocalComments(targets);
  return {
    schemaVersion: 1,
    repoRoot: r.repoRoot ?? repoRoot,
    targets,
    issues: Array.isArray(r.issues) ? r.issues.filter(usable) : [],
    todos: Array.isArray(r.todos) ? r.todos.filter(usable) : [],
    prefs: {
      ...defaultPrefs(),
      ...(r.prefs ?? {}),
      nvimSocketByRoot: r.prefs?.nvimSocketByRoot ?? {},
      autoRefresh: typeof r.prefs?.autoRefresh === 'boolean' ? r.prefs.autoRefresh : true,
    },
  };
}

/**
 * Comments used to live under the view they were written in (`working` / `staged` / `all`). They
 * now share one scope per worktree so they can follow the code across `git add`. Moves them in
 * place; `viewed` stays on the view key, which is still where it belongs.
 */
function migrateLocalComments(targets: ReviewState['targets']): void {
  // Sorted so a state file with several stale views migrates in a stable order.
  for (const key of Object.keys(targets).sort()) {
    const scope = commentScopeKey(key);
    if (scope === key) continue;
    const src = targets[key]!;
    if (src.comments.length === 0) continue;
    let dst = targets[scope];
    if (!dst) {
      dst = { viewed: {}, comments: [] };
      targets[scope] = dst;
    }
    dst.comments.push(...src.comments);
    src.comments = [];
  }
}

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * JSON state persisted outside the repository. Every mutation re-reads the file, applies the
 * change and writes atomically (tmp + rename) under a simple cross-process lock file, so several
 * warden instances on the same repo can coexist.
 */
export class StateStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly file: string,
    public readonly repoRoot: string,
  ) {}

  async load(): Promise<ReviewState> {
    try {
      const text = await readFile(this.file, 'utf8');
      return normalise(JSON.parse(text), this.repoRoot);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return defaultState(this.repoRoot);
      if (e instanceof SyntaxError) {
        // Corrupt file: keep a copy for forensics and start fresh.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
        return defaultState(this.repoRoot);
      }
      throw e;
    }
  }

  /** Apply a mutation under lock. The callback receives the freshest on-disk state. */
  update<T>(fn: (state: ReviewState) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const release = await this.acquireLock();
      try {
        const state = await this.load();
        const result = await fn(state);
        await this.writeAtomic(state);
        return result;
      } finally {
        await release();
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async writeAtomic(state: ReviewState): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await rename(tmp, this.file);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lock = `${this.file}.lock`;
    const started = Date.now();
    for (;;) {
      try {
        const fh = await open(lock, 'wx');
        await fh.writeFile(String(process.pid));
        await fh.close();
        return async () => {
          try {
            await unlink(lock);
          } catch {
            /* ignore */
          }
        };
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') throw e;
        try {
          const st = await stat(lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await unlink(lock).catch(() => undefined);
            continue;
          }
        } catch {
          continue; // lock vanished between calls
        }
        if (Date.now() - started > LOCK_WAIT_MS) {
          throw new Error(`timed out waiting for state lock ${lock}`);
        }
        await sleep(20);
      }
    }
  }
}
