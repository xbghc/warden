import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, resolveRepo, RepoWatcher, statusPaths, StateStore } from './compat/index.js';
import * as worktreeState from '../packages/engine/src/worktree-state.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let app: ReturnType<typeof createApp>;
let dataDir: string;
const watching = new Set<RepoWatcher>();

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-watch-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-watch-data-'));
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  app = createApp({ repo, store, watchIntervalMs: 60_000 });
});

afterAll(async () => {
  await app.close();
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all([...watching].map((watcher) => watcher.close()));
  watching.clear();
  vi.restoreAllMocks();
});

describe('statusPaths', () => {
  it('reads porcelain -z entries and consumes the origin path of renames', () => {
    expect(statusPaths(' M src/a.ts\0?? new.ts\0')).toEqual(['src/a.ts', 'new.ts']);
    expect(statusPaths('R  dst.ts\0src.ts\0 M other.ts\0')).toEqual(['dst.ts', 'src.ts', 'other.ts']);
    expect(statusPaths('')).toEqual([]);
  });
});

describe('RepoWatcher', () => {
  // A long interval keeps the timer out of the way; poll() is stepped by hand instead.
  const watcher = () => {
    const instance = new RepoWatcher(fx.root, 60_000);
    watching.add(instance);
    return instance;
  };

  it('sees edits inside an untracked directory, not only its creation', async () => {
    const w = watcher();
    await w.poll();
    await fx.write('newdir/sub/a.ts', 'a\n');
    expect(await w.poll()).toBeDefined();
    expect(await w.poll()).toBeUndefined();
    await fx.write('newdir/sub/a.ts', 'aa\n');
    expect(await w.poll()).toBeDefined();
    await fx.write('newdir/sub/b.ts', 'b\n');
    expect(await w.poll()).toBeDefined();
    expect(await w.poll()).toBeUndefined();
    await rm(path.join(fx.root, 'newdir'), { recursive: true, force: true });
    expect(await w.poll()).toBeDefined();
  });

  it('reports each edit, stage, commit and branch switch exactly once', async () => {
    const w = watcher();
    expect(await w.poll()).toBeUndefined(); // first poll only records the baseline

    await fx.write('src/a.ts', 'export function a() {\n  return 7;\n}\n');
    expect(await w.poll()).toBeDefined();
    expect(await w.poll()).toBeUndefined(); // nothing happened in between

    fx.git('add', 'src/a.ts');
    expect(await w.poll()).toBeDefined();
    expect(await w.poll()).toBeUndefined();

    fx.git('commit', '-q', '-m', 'watched commit');
    const committed = await w.poll();
    expect(committed).toBeDefined();
    expect(committed!.branch).toBe('main');

    fx.git('checkout', '-q', '-b', 'watched-branch');
    const switched = await w.poll();
    expect(switched).toBeDefined();
    expect(switched!.branch).toBe('watched-branch');
    // Same commit, different branch: the sha alone would not have caught this.
    expect(switched!.head).toBe(committed!.head);
  });

  it('notices a second edit to a file that was already modified', async () => {
    const w = watcher();
    await w.poll();
    // Both edits leave `git status` byte-identical; only mtime and size tell them apart.
    await fx.write('src/b.ts', 'export const b = 1;\n');
    expect(await w.poll()).toBeDefined();
    await fx.write('src/b.ts', 'export const b = 1; // second edit, different length\n');
    expect(await w.poll()).toBeDefined();
    expect(await w.poll()).toBeUndefined();
  });

  it('delivers to subscribers and stops polling once the last one leaves', async () => {
    const w = watcher();
    const seen: string[] = [];
    const release = w.subscribe((e) => seen.push(e.head));
    try {
      // poll joins the baseline already started by subscribe, regardless of Git latency.
      await w.poll();
      expect(w.subscriberCount).toBe(1);
      await fx.write('src/b.ts', 'export const b = 2;\n');
      await w.poll();
      expect(seen).toHaveLength(1);
      release();
      expect(w.subscriberCount).toBe(0);
      release(); // releasing twice must not throw or double-remove
      expect(w.subscriberCount).toBe(0);
    } finally {
      release();
      await w.close();
    }
  });

  it('waits for a slow subscription baseline instead of dropping a concurrent poll', async () => {
    const w = watcher();
    const started = signal();
    const proceed = signal();
    const read = worktreeState.readWorktreeState;
    let hold = true;
    vi.spyOn(worktreeState, 'readWorktreeState').mockImplementation(async (cwd) => {
      const result = await read(cwd);
      if (hold) {
        hold = false;
        started.resolve();
        await proceed.promise;
      }
      return result;
    });
    const seen: string[] = [];
    const release = w.subscribe((event) => seen.push(event.head));
    try {
      await started.promise;
      let finished = false;
      const baseline = w.poll().then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      proceed.resolve();
      await baseline;
      await fx.write('slow-baseline.txt', 'observable after the baseline\n');
      await w.poll();
      expect(seen).toHaveLength(1);
    } finally {
      proceed.resolve();
      release();
      await w.close();
    }
  });

  it('does not reuse a departed subscriber snapshot as the next subscriber baseline', async () => {
    const w = watcher();
    const started = signal();
    const proceed = signal();
    const read = worktreeState.readWorktreeState;
    let hold = true;
    vi.spyOn(worktreeState, 'readWorktreeState').mockImplementation(async (cwd) => {
      const result = await read(cwd);
      if (hold) {
        hold = false;
        started.resolve();
        await proceed.promise;
      }
      return result;
    });
    const first = w.subscribe(() => {});
    let second = () => {};
    const seen: string[] = [];
    try {
      await started.promise;
      first();
      await fx.write('subscription-boundary.txt', 'before the second subscription\n');
      second = w.subscribe((event) => seen.push(event.head));
      const baseline = w.poll();
      proceed.resolve();
      await baseline;
      expect(seen).toEqual([]);
      await fx.write('subscription-boundary.txt', 'a later and longer observable edit\n');
      await w.poll();
      expect(seen).toHaveLength(1);
    } finally {
      proceed.resolve();
      first();
      second();
      await w.close();
    }
  });

  it('drains an active status read on close even when the read fails', async () => {
    const w = watcher();
    const started = signal();
    const proceed = signal();
    vi.spyOn(worktreeState, 'readWorktreeState').mockImplementation(async () => {
      started.resolve();
      await proceed.promise;
      throw new Error('Simulated status failure');
    });
    const pending = w.poll();
    try {
      await started.promise;
      let closed = false;
      const closing = w.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      proceed.resolve();
      await closing;
      await expect(pending).resolves.toBeUndefined();
      expect(w.subscriberCount).toBe(0);
      expect(() => w.subscribe(() => {})).toThrow('closed');
    } finally {
      proceed.resolve();
      await w.close();
    }
  });
});

describe('GET /api/events', () => {
  it('rejects a root that is not this repository or one of its worktrees', async () => {
    const res = await app.request(`/api/events?root=${encodeURIComponent('/definitely/not/a/worktree')}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('unknown_worktree');
  });
});
