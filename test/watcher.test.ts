import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp, resolveRepo, RepoWatcher, statusPaths, StateStore, NvimService } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-watch-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-watch-data-'));
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  app = createApp({ repo, store, nvim: new NvimService([path.join(dataDir, 'no-sockets')]), watchIntervalMs: 60_000 });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
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
  const watcher = () => new RepoWatcher(fx.root, 60_000);

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
    // subscribe() kicks off a baseline poll of its own; let it land before making a change.
    await new Promise((r) => setTimeout(r, 50));
    expect(w.subscriberCount).toBe(1);

    await fx.write('src/b.ts', 'export const b = 2;\n');
    await w.poll();
    expect(seen).toHaveLength(1);

    release();
    expect(w.subscriberCount).toBe(0);
    release(); // releasing twice must not throw or double-remove
    expect(w.subscriberCount).toBe(0);
  });
});

describe('GET /api/events', () => {
  it('rejects a root that is not this repository or one of its worktrees', async () => {
    const res = await app.request(`/api/events?root=${encodeURIComponent('/definitely/not/a/worktree')}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('unknown_worktree');
  });
});
