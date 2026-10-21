import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateStore, defaultState, ensureTarget, forgetWorktreeTargets, repoHash, stateFilePath } from './state.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'warden-state-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function expireLockWait() {
  let now = Date.now();
  // Exercise an expired wait without a real five-second delay or depending on heartbeat
  // scheduling. Each clock observation advances; unrelated observations cannot stall it.
  vi.spyOn(Date, 'now').mockImplementation(() => {
    now += 6_000;
    return now;
  });
}

describe('StateStore', () => {
  it('computes the state file path from the repo root hash', () => {
    const p = stateFilePath('/home/user/project', '/data');
    expect(p).toBe(path.join('/data', repoHash('/home/user/project'), 'state.json'));
    expect(repoHash('/home/user/project')).toHaveLength(12);
  });

  it('returns default state when nothing is stored', async () => {
    const store = new StateStore(path.join(dir, 'state.json'), '/repo');
    const s = await store.load();
    expect(s).toEqual({
      schemaVersion: 1,
      repoRoot: '/repo',
      targets: {},
      todos: [],
      checkpoints: [],
      prefs: { viewMode: 'unified', autoRefresh: true, ignoreDebug: true },
    });
  });

  it('drops rows that are missing the fields the server dereferences', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        repoRoot: '/repo',
        targets: { all: { viewed: null }, invalid: null },
        // Issues were folded into todos; what an older file kept of them is let go.
        issues: [{ id: 'i1', title: 't', body: '', status: 'open' }],
        todos: [{ title: 'no id' }, { id: 't1', branch: 'main', title: 'x', body: '', status: 'open', createdAt: '', updatedAt: '' }],
        prefs: {},
      }),
    );
    const s = await new StateStore(file, '/repo').load();
    expect(s.targets).toEqual({ all: { viewed: {} } });
    expect(s).not.toHaveProperty('issues');
    expect(s.todos.map((t) => t.id)).toEqual(['t1']);
  });

  it('persists mutations atomically and reloads them', async () => {
    const file = path.join(dir, 'nested', 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update((s) => {
      ensureTarget(s, 'base:main').viewed['a.ts'] = 'hash1';
      s.prefs.viewMode = 'split';
    });
    const again = new StateStore(file, '/repo');
    const s = await again.load();
    expect(s.targets['base:main']?.viewed).toEqual({ 'a.ts': 'hash1' });
    expect(s.prefs.viewMode).toBe('split');
    // no temp files or lock files left behind
    const files = await readdir(path.dirname(file));
    expect(files).toEqual(['state.json']);
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(1);
  });

  it.each([
    [{ lastArea: 'review' }, 'diff'],
    [{ lastArea: 'orchestration' }, 'orchestration'],
    [{ lastArea: 'review', lastPanel: 'commits' }, 'commits'],
  ])('migrates area preferences %j into the content destination', async (prefs, panel) => {
    const file = path.join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ ...defaultState('/repo'), prefs: { ...prefs, lastTarget: 'commit:abc1234' } }));
    const store = new StateStore(file, '/repo');
    await store.update((state) => {
      expect(state.prefs.lastPanel).toBe(panel);
      expect(state.prefs.lastTarget).toBe('commit:abc1234');
      expect(state.prefs).not.toHaveProperty('lastArea');
    });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.prefs.lastPanel).toBe(panel);
    expect(saved.prefs).not.toHaveProperty('lastArea');
  });

  it('merges concurrent updates from two instances (read-before-write)', async () => {
    const file = path.join(dir, 'state.json');
    const a = new StateStore(file, '/repo');
    const b = new StateStore(file, '/repo');
    await Promise.all([
      a.update((s) => {
        ensureTarget(s, 'base:main').viewed['a.ts'] = '1';
      }),
      b.update((s) => {
        ensureTarget(s, 'base:main').viewed['b.ts'] = '2';
      }),
      a.update((s) => {
        s.todos.push({ id: 't1', branch: 'main', title: 't', body: '', status: 'open', createdAt: '', updatedAt: '' });
      }),
    ]);
    const s = await a.load();
    expect(s.targets['base:main']?.viewed).toEqual({ 'a.ts': '1', 'b.ts': '2' });
    expect(s.todos).toHaveLength(1);
  });

  it('recovers from a corrupt file', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(file, '{not json');
    const store = new StateStore(file, '/repo');
    const s = await store.load();
    expect(s.targets).toEqual({});
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('preserves historical review data without reanchoring or pooling it on unrelated writes', async () => {
    const file = path.join(dir, 'state.json');
    const historical = { id: 'old', body: 'Keep this review', targetKey: 'working', anchor: { hunkHash: 'h' } };
    const targets = {
      working: { viewed: { 'a.ts': 'h' }, comments: [historical] },
      local: { viewed: {}, comments: [{ ...historical, id: 'local' }], head: 'abc' },
      'commit:abc': { viewed: {}, comments: [{ ...historical, id: 'delivered' }] },
    };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, targets }));
    const store = new StateStore(file, '/repo');
    expect((await store.load()).targets).toEqual(targets);
    await store.update((state) => {
      state.prefs.viewMode = 'split';
      ensureTarget(state, 'all').viewed['b.ts'] = 'new-hash';
    });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.targets).toEqual({ ...targets, all: { viewed: { 'b.ts': 'new-hash' } } });
    expect((await store.load()).targets).toEqual(saved.targets);
  });
});

describe('what the state file will not lose', () => {
  const todo = (id: string) => ({ id, branch: 'main', title: id, body: '', status: 'open' as const, createdAt: '', updatedAt: '' });

  it('refuses a file a newer warden wrote, and leaves it as it is', async () => {
    const file = path.join(dir, 'state.json');
    const text = JSON.stringify({ schemaVersion: 2, repoRoot: '/repo', targets: {}, todos: [todo('t')] });
    await writeFile(file, text);
    const store = new StateStore(file, '/repo');
    await expect(store.load()).rejects.toMatchObject({ code: 'state_too_new' });
    await expect(store.update((s) => s.todos.push(todo('u')))).rejects.toMatchObject({ code: 'state_too_new' });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('sets aside a file that parses but is no state file, rather than writing over it', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(file, '[1, 2, 3]');
    expect((await new StateStore(file, '/repo').load()).todos).toEqual([]);
    expect((await readdir(dir)).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('keeps top-level fields it does not know, so a newer field survives this build writing', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, repoRoot: '/repo', targets: {}, todos: [], futureThing: { keep: true } }));
    await new StateStore(file, '/repo').update((s) => s.todos.push(todo('t')));
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written.futureThing).toEqual({ keep: true });
    expect(written.todos.map((t: { id: string }) => t.id)).toEqual(['t']);
  });

  it('takes over the lock of a process that died holding it', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(`${file}.lock`, '999999:gone');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    await new StateStore(file, '/repo').update((s) => s.todos.push(todo('t')));
    expect(JSON.parse(await readFile(file, 'utf8')).todos).toHaveLength(1);
    expect((await readdir(dir)).filter((f) => f.includes('.lock'))).toEqual([]);
  });

  it.each(['state', 'repository'] as const)("does not steal a live owner's %s lock when its heartbeat is stale", async (kind) => {
    const file = path.join(dir, 'state.json');
    const lock = `${file}${kind === 'repository' ? '.repository' : ''}.lock`;
    const owner = `${process.pid}:paused-owner`;
    await writeFile(lock, owner);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const store = new StateStore(file, '/repo');
    const mutate = vi.fn(async () => undefined);
    expireLockWait();
    await expect(kind === 'repository' ? store.withRepositoryLock(mutate) : store.update(mutate)).rejects.toMatchObject({
      code: 'operation_locked',
      status: 409,
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(lock, 'utf8')).toBe(owner);
  });

  it.each(['EPERM', 'EIO'])('keeps a stale lock occupied when its owner probe fails with %s', async (code) => {
    const file = path.join(dir, 'state.json');
    const lock = `${file}.repository.lock`;
    const owner = `${process.pid}:unconfirmed-owner`;
    await writeFile(lock, owner);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Owner status unavailable'), { code });
    });
    const mutate = vi.fn(async () => undefined);
    expireLockWait();
    await expect(new StateStore(file, '/repo').withRepositoryLock(mutate)).rejects.toMatchObject({ code: 'operation_locked' });
    expect(probe).toHaveBeenCalledWith(process.pid, 0);
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(lock, 'utf8')).toBe(owner);
  });

  it.each(['', 'unknown:owner'])('keeps a stale lock with an incomplete or malformed owner record %j occupied', async (owner) => {
    const file = path.join(dir, 'state.json');
    const lock = `${file}.repository.lock`;
    await writeFile(lock, owner);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const mutate = vi.fn(async () => undefined);
    expireLockWait();
    await expect(new StateStore(file, '/repo').withRepositoryLock(mutate)).rejects.toMatchObject({ code: 'operation_locked' });
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(lock, 'utf8')).toBe(owner);
  });

  it('does not write when its lock was taken over meanwhile, and leaves the new holder’s lock alone', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update((s) => s.todos.push(todo('first')));
    await expect(
      store.update(async (s) => {
        s.todos.push(todo('stale'));
        // An older writer or an external replacement can still take over the token.
        await writeFile(`${file}.lock`, 'other:holder');
      }),
    ).rejects.toMatchObject({ code: 'state_lock_lost' });
    expect(JSON.parse(await readFile(file, 'utf8')).todos.map((t: { id: string }) => t.id)).toEqual(['first']);
    expect(await readFile(`${file}.lock`, 'utf8')).toBe('other:holder');
  });
});

describe('forgetWorktreeTargets', () => {
  it('drops only the reused worktree’s targets', () => {
    const slot = '/x/repo-1';
    const s = defaultState('/x/repo');
    s.targets = {
      [`worktree:${slot}:local`]: { viewed: {} },
      [`worktree:${slot}:working`]: { viewed: { 'a.ts': 'h1' } },
      [`worktree:${slot}:base:main`]: { viewed: {} },
      // `/x/repo-1` is a prefix of `/x/repo-10`; the colon after the path keeps them apart.
      'worktree:/x/repo-10:local': { viewed: {} },
      local: { viewed: {} },
      'base:main': { viewed: { 'a.ts': 'h2' } },
    };
    forgetWorktreeTargets(s, slot);
    expect(Object.keys(s.targets).sort()).toEqual(['base:main', 'local', 'worktree:/x/repo-10:local']);
  });
});
