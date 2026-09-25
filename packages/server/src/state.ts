import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises';
import type { Checkpoint, Prefs, ReviewState, TargetState } from '@warden/shared';
import { commentScopeKey } from '@warden/shared';
import { sha1 } from './hash.js';
import { HttpError } from './errors.js';

export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg?.trim() ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'warden');
}

export function repoHash(repoRoot: string): string {
  return sha1(repoRoot).slice(0, 12);
}

export function stateFilePath(repoRoot: string, baseDir = dataDir()): string {
  return path.join(baseDir, repoHash(repoRoot), 'state.json');
}

export function defaultPrefs(): Prefs {
  return { viewMode: 'unified', nvimSocketByRoot: {}, autoRefresh: true, railOpen: false, ignoreDebug: true };
}

export function defaultState(repoRoot: string): ReviewState {
  return { schemaVersion: 1, repoRoot, targets: {}, todos: [], checkpoints: [], prefs: defaultPrefs() };
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
const usableCheckpoint = (v: unknown): boolean => {
  const c = v as Partial<Checkpoint> | null;
  return !!c && typeof c === 'object' && Number.isInteger(c.id) && typeof c.tree === 'string' && (c.worktree === undefined || typeof c.worktree === 'string');
};
const usableComment = (v: unknown): boolean => usable(v) && typeof (v as { anchor?: unknown }).anchor === 'object' && !!(v as { anchor?: unknown }).anchor;

/**
 * The schema this build reads and writes. It must stay 1: every warden up to 0.16 replaces a file
 * with any other version by an empty state on its next write, so bumping it would let an older copy
 * (a global install beside an `npx` run) wipe the review. New fields are added beside the old ones
 * instead, and `normalise` keeps the top-level fields it does not know, so this build does not drop
 * what a newer one wrote.
 */
const SCHEMA_VERSION = 1;
const KNOWN_KEYS = new Set(['schemaVersion', 'repoRoot', 'targets', 'todos', 'checkpoints', 'prefs', 'issues']);

/** A state file this build must not write over. */
class StateTooNew extends HttpError {
  constructor(file: string, version: number) {
    super(409, `${file} was written by a newer warden (schema ${version}); upgrade warden to use it`, 'state_too_new');
  }
}

/** A file that parses but is not a state file at all: set aside like one that does not parse. */
class NotAState extends Error {}

function normalise(raw: unknown, repoRoot: string, file: string): ReviewState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new NotAState();
  const r = raw as Partial<ReviewState> & Record<string, unknown>;
  if (typeof r.schemaVersion !== 'number') throw new NotAState();
  if (r.schemaVersion > SCHEMA_VERSION) throw new StateTooNew(file, r.schemaVersion);
  const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !KNOWN_KEYS.has(k)));
  const targets: ReviewState['targets'] = {};
  for (const [k, v] of Object.entries(r.targets ?? {})) {
    if (!v || typeof v !== 'object') continue;
    targets[k] = {
      viewed: typeof v.viewed === 'object' && v.viewed ? v.viewed : {},
      comments: Array.isArray(v.comments) ? v.comments.filter(usableComment) : [],
      ...(typeof v.head === 'string' ? { head: v.head } : {}),
    };
  }
  migrateLocalViews(targets);
  return {
    ...extra,
    schemaVersion: SCHEMA_VERSION,
    repoRoot: r.repoRoot ?? repoRoot,
    targets,
    // Issues were folded into todos (a todo links comments now); the few there were are let go,
    // and the next write leaves them out of the file.
    todos: Array.isArray(r.todos) ? r.todos.filter(usable) : [],
    checkpoints: Array.isArray(r.checkpoints) ? r.checkpoints.filter(usableCheckpoint) : [],
    prefs: {
      ...defaultPrefs(),
      ...(r.prefs ?? {}),
      nvimSocketByRoot: r.prefs?.nvimSocketByRoot ?? {},
      autoRefresh: typeof r.prefs?.autoRefresh === 'boolean' ? r.prefs.autoRefresh : true,
      railOpen: typeof r.prefs?.railOpen === 'boolean' ? r.prefs.railOpen : false,
      ignoreDebug: typeof r.prefs?.ignoreDebug === 'boolean' ? r.prefs.ignoreDebug : true,
    },
  };
}

/**
 * Nothing is kept under a local view key (`working` / `staged` / `all`) any more. Comments used to
 * live under the view they were written in; they now share one scope per worktree so they can
 * follow the code across `git add`, and are moved there. The 已读 marks of those views go with the
 * entry: a file there is reviewed once it is staged (see `tracksViewed`).
 */
function migrateLocalViews(targets: ReviewState['targets']): void {
  // Sorted so a state file with several stale views migrates in a stable order.
  for (const key of Object.keys(targets).sort()) {
    const scope = commentScopeKey(key);
    if (scope === key) continue;
    const src = targets[key]!;
    delete targets[key];
    if (src.comments.length === 0) continue;
    let dst = targets[scope];
    if (!dst) {
      dst = { viewed: {}, comments: [] };
      targets[scope] = dst;
    }
    dst.comments.push(...src.comments);
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
      return normalise(JSON.parse(text), this.repoRoot, this.file);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return defaultState(this.repoRoot);
      if (e instanceof SyntaxError || e instanceof NotAState) {
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
      const lock = await this.acquireLock();
      try {
        const state = await this.load();
        const result = await fn(state);
        // A holder that stalled past the stale limit (a suspended process, a laptop lid) may have
        // had its lock taken and the file written since; writing its older copy now would undo that.
        if (!(await lock.held())) throw new HttpError(409, 'the state lock was taken over while this change was prepared; try again', 'state_lock_lost');
        await this.writeAtomic(state);
        return result;
      } finally {
        await lock.release();
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async writeAtomic(state: ReviewState): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(state, null, 2) + '\n', 'utf8');
      // Without it a power cut can leave the renamed file empty, which load() then sets aside as
      // corrupt: every comment gone, with nothing in the copy either.
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.file);
  }

  /**
   * An exclusive lock file beside the state file, shared by every warden process and the agent
   * CLI. It carries a token of its own, so a holder releases only the lock it took, and its mtime
   * is refreshed while held: a lock left by a process that died goes stale and is taken over, one
   * whose holder is merely slow does not.
   */
  private async acquireLock(): Promise<{ held(): Promise<boolean>; release(): Promise<void> }> {
    const lock = `${this.file}.lock`;
    const token = `${process.pid}:${randomUUID()}`;
    const started = Date.now();
    for (;;) {
      try {
        const fh = await open(lock, 'wx');
        await fh.writeFile(token);
        await fh.close();
        break;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') throw e;
        try {
          const st = await stat(lock);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // Taken over by renaming it aside, which only one waiter can do to a given file; a
            // plain unlink could remove a fresh lock another waiter created in between.
            const aside = `${lock}.stale-${token.replace(':', '-')}`;
            await rename(lock, aside).then(
              () => unlink(aside).catch(() => undefined),
              () => undefined,
            );
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
    const ours = async () => (await readFile(lock, 'utf8').catch(() => '')) === token;
    const beat = setInterval(() => {
      void ours().then((mine) => (mine ? utimes(lock, new Date(), new Date()).catch(() => undefined) : undefined));
    }, LOCK_STALE_MS / 4);
    beat.unref();
    return {
      held: ours,
      release: async () => {
        clearInterval(beat);
        if (await ours()) await unlink(lock).catch(() => undefined);
      },
    };
  }
}

/**
 * Drops everything kept under one worktree path: the scope its local views share, the viewed
 * flags and comment pools of its commit, range, `base` and checkpoint targets, and its checkpoints.
 * A slot is checked out again for the next branch, and what was said about the previous one —
 * `base` comments above all, which no commit ever deletes — would otherwise come back orphaned
 * over code they were never about; a checkpoint of the old branch is no baseline for the new one.
 * Todos let go of the comments that went with it.
 */
export function forgetWorktreeTargets(state: ReviewState, worktreePath: string): void {
  const prefix = `worktree:${worktreePath}:`;
  const gone = new Set<string>();
  for (const key of Object.keys(state.targets)) {
    if (!key.startsWith(prefix)) continue;
    for (const c of state.targets[key]!.comments) gone.add(c.id);
    delete state.targets[key];
  }
  unlinkComments(state, gone);
  state.checkpoints = state.checkpoints.filter((c) => c.worktree !== worktreePath);
}

/** Takes deleted comments off the todos that linked them; a todo left with none loses the field. */
export function unlinkComments(state: ReviewState, ids: Iterable<string>): void {
  const gone = new Set(ids);
  if (gone.size === 0) return;
  for (const todo of state.todos) {
    if (!todo.commentIds?.some((id) => gone.has(id))) continue;
    const kept = todo.commentIds.filter((id) => !gone.has(id));
    if (kept.length) todo.commentIds = kept;
    else delete todo.commentIds;
  }
}
