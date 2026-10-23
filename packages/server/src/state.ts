import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises';
import type { Checkpoint, Prefs, ReviewState } from '@warden/shared';
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
  return { viewMode: 'unified', autoRefresh: true, ignoreDebug: true };
}

export function defaultState(repoRoot: string): ReviewState {
  return { schemaVersion: 1, repoRoot, targets: {}, todos: [], checkpoints: [], prefs: defaultPrefs() };
}

/** The fields the rest of the server dereferences without checking; anything else is a corrupt row. */
const usable = (v: unknown): boolean => !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';
const usableCheckpoint = (v: unknown): boolean => {
  const c = v as Partial<Checkpoint> | null;
  return !!c && typeof c === 'object' && Number.isInteger(c.id) && typeof c.tree === 'string' && (c.worktree === undefined || typeof c.worktree === 'string');
};

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
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    // Retire read markers while preserving unrelated historical metadata.
    const metadata = Object.fromEntries(Object.entries(v).filter(([field]) => field !== 'viewed'));
    if (Object.keys(metadata).length) targets[k] = metadata;
  }
  // Older builds remembered a separate review area. Fold it into the content destination and
  // leave the selected target intact; there is no longer an extra mode to enter before reading.
  const { lastArea, ...prefs } = (r.prefs ?? {}) as Partial<Prefs> & { lastArea?: unknown };
  const state: ReviewState = {
    ...extra,
    schemaVersion: SCHEMA_VERSION,
    repoRoot: r.repoRoot ?? repoRoot,
    targets,
    todos: Array.isArray(r.todos) ? r.todos.filter(usable) : [],
    checkpoints: Array.isArray(r.checkpoints) ? r.checkpoints.filter(usableCheckpoint) : [],
    prefs: {
      ...defaultPrefs(),
      ...prefs,
      lastPanel:
        prefs.lastPanel === 'orchestration' || prefs.lastPanel === 'diff' || prefs.lastPanel === 'commits'
          ? prefs.lastPanel
          : lastArea === 'review'
            ? 'diff'
            : 'orchestration',
      slotKind: undefined,
      ...(r.prefs?.slotKind === 'clone' || r.prefs?.slotKind === 'worktree' ? { slotKind: r.prefs.slotKind } : {}),
      autoRefresh: typeof r.prefs?.autoRefresh === 'boolean' ? r.prefs.autoRefresh : true,
      ignoreDebug: typeof r.prefs?.ignoreDebug === 'boolean' ? r.prefs.ignoreDebug : true,
    },
  };
  migrateTodoPlans(state);
  return state;
}

/** Stable IDs make migration repeatable across readers and preserve note order. */
function migrateTodoPlans(state: ReviewState): void {
  const workflow = state.workflow;
  if (!workflow) return;
  state.todos = state.todos.filter((todo) => {
    const owner = workflow.changes.find((change) => change.branch === todo.branch);
    const branch = owner?.developmentBranch ?? todo.branch;
    if (branch !== workflow.developmentBranch) return true;
    const id = `todo-${todo.id}`;
    if (!workflow.changes.some((change) => change.id === id)) {
      workflow.changes.push({
        id,
        title: todo.title,
        body: todo.body,
        ...('commentIds' in todo ? { commentIds: todo.commentIds } : {}),
        developmentBranch: branch,
        status: todo.status === 'done' ? 'archived' : 'planned',
        createdAt: todo.createdAt,
        legacyTodo: { branch: todo.branch, status: todo.status },
      });
    }
    return false;
  });
}

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 5_000;

function lockOwnerHasExited(owner: string | undefined): boolean {
  const match = /^([1-9]\d*):[^:\r\n]+$/.exec(owner ?? '');
  const pid = match ? Number(match[1]) : undefined;
  // Incomplete owner records or uncertain process status stay occupied. An interrupted
  // owner-record write may need manual inspection; age alone cannot permit concurrent writes.
  if (pid === undefined || !Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

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

  /** Shared by repository operations; independent of the short state-file lock. */
  async withRepositoryLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const lock = await this.acquireLock(`${this.file}.repository`);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

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
        // An older writer or an external lock replacement may have taken this token and
        // changed the file meanwhile; writing our earlier copy would undo that change.
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
      // corrupt: saved state gone, with nothing in the copy either.
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.file);
  }

  /**
   * An exclusive lock file beside the state file, shared by every warden process.
   * It carries a token of its own, so a holder releases only the lock it took, and its mtime
   * is refreshed while held. Reclamation requires both an old heartbeat and a confirmed dead
   * owner: a suspended process or delayed timer must not permit concurrent repository mutations.
   */
  private async acquireLock(file = this.file): Promise<{ held(): Promise<boolean>; release(): Promise<void> }> {
    const lock = `${file}.lock`;
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
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS && lockOwnerHasExited(await readFile(lock, 'utf8').catch(() => undefined))) {
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
          throw new HttpError(409, '另一个 Warden 操作正在进行，请稍后重试', 'operation_locked');
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

/** A reused slot drops historical target metadata and checkpoint baselines. */
export function forgetWorktreeTargets(state: ReviewState, worktreePath: string): void {
  const prefix = `worktree:${worktreePath}:`;
  for (const key of Object.keys(state.targets)) {
    if (!key.startsWith(prefix)) continue;
    delete state.targets[key];
  }
  state.checkpoints = state.checkpoints.filter((c) => c.worktree !== worktreePath);
}
