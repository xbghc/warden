import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs, { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewState } from '@warden/shared';
import { StateStore, defaultState, forgetWorktreeTargets, repoHash, stateFilePath } from './state.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'warden-state-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function directoryOwner(lock: string, pid = 2_147_483_647) {
  lock = path.join(lock, 'v2', 'active');
  const id = randomUUID();
  const owner = path.join(lock, `owner-${pid}-${id}`);
  await mkdir(lock, { recursive: true });
  await writeFile(owner, `${pid}:${id}`);
  await utimes(owner, new Date(0), new Date(0));
  return owner;
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
      prefs: { viewMode: 'unified', autoRefresh: true },
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
    expect(s.targets).toEqual({});
    expect(s).not.toHaveProperty('issues');
    expect(s.todos.map((t) => t.id)).toEqual(['t1']);
  });

  it('persists mutations atomically and reloads them', async () => {
    const file = path.join(dir, 'nested', 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update((s) => {
      s.prefs.viewMode = 'split';
    });
    const again = new StateStore(file, '/repo');
    const s = await again.load();
    expect(s.prefs.viewMode).toBe('split');
    // Only the state and permanent protocol container remain after releasing ownership.
    const files = await readdir(path.dirname(file));
    expect(files).toEqual(['state.json', 'state.json.lock']);
    expect(await readdir(path.join(`${file}.lock`, 'v2'))).toEqual([]);
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

  it.each(['checkpoint:1', 'worktree:/repo-1:checkpoint:2'])(
    'retires checkpoint and debug preferences from %s without losing other data',
    async (lastTarget) => {
      const file = path.join(dir, 'state.json');
      await writeFile(
        file,
        JSON.stringify({
          ...defaultState('/repo'),
          checkpoints: [{ id: 1, tree: 'old-tree' }],
          prefs: { viewMode: 'split', ignoreDebug: true, lastTarget },
          connectionPreview: { tree: 'retained-tree', directory: 'runtime' },
          futureField: { keep: true },
          targets: { [lastTarget]: { comments: ['historical'] } },
        }),
      );
      const store = new StateStore(file, '/repo');
      await store.update(() => {});
      const saved = JSON.parse(await readFile(file, 'utf8'));
      expect(saved).not.toHaveProperty('checkpoints');
      expect(saved.prefs).not.toHaveProperty('ignoreDebug');
      expect(saved.prefs.lastTarget).toBe(lastTarget.replace(/checkpoint:\d+$/, 'all'));
      expect(saved.prefs.viewMode).toBe('split');
      expect(saved.connectionPreview.tree).toBe('retained-tree');
      expect(saved.futureField).toEqual({ keep: true });
      expect(saved.targets[lastTarget]).toEqual({ comments: ['historical'] });
    },
  );

  it('merges concurrent updates from two instances (read-before-write)', async () => {
    const file = path.join(dir, 'state.json');
    const a = new StateStore(file, '/repo');
    const b = new StateStore(file, '/repo');
    await Promise.all([
      a.update((s) => {
        s.prefs.viewMode = 'split';
      }),
      b.update((s) => {
        s.prefs.autoRefresh = false;
      }),
      a.update((s) => {
        s.todos.push({ id: 't1', branch: 'main', title: 't', body: '', status: 'open', createdAt: '', updatedAt: '' });
      }),
    ]);
    const s = await a.load();
    expect(s.prefs).toMatchObject({ viewMode: 'split', autoRefresh: false });
    expect(s.todos).toHaveLength(1);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s replacement contention while preserving the previous state', async (code) => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update(() => {});
    const previous = await readFile(file, 'utf8');
    const originalRename = fs.rename;
    let failures = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file && failures++ < 2) {
        expect(await readFile(file, 'utf8')).toBe(previous);
        expect(JSON.parse(await readFile(from, 'utf8')).prefs.viewMode).toBe('split');
        throw Object.assign(new Error('File temporarily in use'), { code });
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    const mutate = vi.fn((state: ReviewState) => {
      state.prefs.viewMode = 'split';
    });
    await store.update(mutate);
    expect(mutate).toHaveBeenCalledOnce();
    expect((await store.load()).prefs.viewMode).toBe('split');
    expect((await readdir(dir)).sort()).toEqual(['state.json', 'state.json.lock']);
  });

  it('bounds persistent replacement failures, keeps the old state and allows a later write', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update(() => {});
    const previous = await readFile(file, 'utf8');
    const originalRename = fs.rename;
    const replace = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file) throw Object.assign(new Error('File remains in use'), { code: 'EPERM' });
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    await expect(
      store.update((state) => {
        state.prefs.viewMode = 'split';
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(await readFile(file, 'utf8')).toBe(previous);
    expect((await readdir(dir)).sort()).toEqual(['state.json', 'state.json.lock']);
    replace.mockRestore();
    syncBuiltinESMExports();
    await store.update((state) => {
      state.prefs.viewMode = 'split';
    });
    expect((await store.load()).prefs.viewMode).toBe('split');
  });

  it('does not retry a nontransient state replacement failure', async () => {
    const file = path.join(dir, 'state.json');
    const originalRename = fs.rename;
    let attempts = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file) {
        ++attempts;
        throw Object.assign(new Error('Storage failure'), { code: 'EIO' });
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    await expect(new StateStore(file, '/repo').update(() => {})).rejects.toMatchObject({ code: 'EIO' });
    expect(attempts).toBe(1);
    expect(await readdir(dir)).toEqual(['state.json.lock']);
  });

  it('rechecks ownership before retrying a state replacement', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update(() => {});
    const replacement = JSON.stringify({ ...defaultState('/repo'), future: 'other writer' });
    const originalRename = fs.rename;
    let attempts = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file && attempts++ === 0) {
        await rm(`${file}.lock`, { recursive: true });
        await writeFile(`${file}.lock`, 'other:holder');
        await writeFile(file, replacement);
        throw Object.assign(new Error('File temporarily in use'), { code: 'EPERM' });
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    await expect(
      store.update((state) => {
        state.prefs.viewMode = 'split';
      }),
    ).rejects.toMatchObject({ code: 'state_lock_lost' });
    expect(attempts).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(replacement);
    expect(await readFile(`${file}.lock`, 'utf8')).toBe('other:holder');
    expect((await readdir(dir)).sort()).toEqual(['state.json', 'state.json.lock']);
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

  it('retires legacy viewed marks while preserving unrelated historical review data', async () => {
    const file = path.join(dir, 'state.json');
    const historical = { id: 'old', body: 'Keep this review', targetKey: 'working', anchor: { hunkHash: 'h' } };
    const targets = {
      all: { viewed: { 'b.ts': 'hash' } },
      working: { viewed: { 'a.ts': 'h' }, comments: [historical] },
      local: { viewed: {}, comments: [{ ...historical, id: 'local' }], head: 'abc' },
      'commit:abc': { viewed: {}, comments: [{ ...historical, id: 'delivered' }] },
    };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, targets }));
    const store = new StateStore(file, '/repo');
    const retained = {
      working: { comments: [historical] },
      local: { comments: [{ ...historical, id: 'local' }], head: 'abc' },
      'commit:abc': { comments: [{ ...historical, id: 'delivered' }] },
    };
    expect((await store.load()).targets).toEqual(retained);
    await store.update((state) => {
      state.prefs.viewMode = 'split';
    });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.targets).toEqual(retained);
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

  it('preserves a dead legacy flat lock and explains how to recover without racing older writers', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(`${file}.lock`, '999999:gone');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    await expect(new StateStore(file, '/repo').update((s) => s.todos.push(todo('t')))).rejects.toMatchObject({
      code: 'legacy_lock_requires_cleanup',
      message: expect.stringContaining(`${file}.lock`),
    });
    expect(await readFile(`${file}.lock`, 'utf8')).toBe('999999:gone');
    expect(await readdir(dir)).toEqual(['state.json.lock']);
  });

  it.each(['live', 'dead'] as const)('does not publish over a %s legacy file when Windows rename would replace it', async (kind) => {
    const file = path.join(dir, 'state.json');
    const lock = `${file}.lock`;
    const token = `${kind === 'live' ? process.pid : 2_147_483_647}:legacy-owner`;
    await writeFile(lock, token);
    await utimes(lock, new Date(0), new Date(0));
    const originalRename = fs.rename;
    const publish = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      // Windows permits replacing a file with a directory. Emulate that dangerous
      // behavior on every host instead of relying on POSIX rejecting the rename.
      if (to === lock && (await fs.lstat(from)).isDirectory()) await fs.unlink(lock);
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    expireLockWait();
    const mutate = vi.fn(() => undefined);
    await expect(new StateStore(file, '/repo').update(mutate)).rejects.toMatchObject({
      code: kind === 'live' ? 'operation_locked' : 'legacy_lock_requires_cleanup',
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await readFile(lock, 'utf8')).toBe(token);
    expect(await readdir(dir)).toEqual(['state.json.lock']);
  });

  it('refuses an unreleased direct-owner lock format without changing its owner', async () => {
    const file = path.join(dir, 'state.json');
    const lock = `${file}.repository.lock`;
    const name = `owner-${process.pid}-${randomUUID()}`;
    await mkdir(lock);
    await writeFile(path.join(lock, name), 'old directory owner');
    const mutate = vi.fn(async () => undefined);
    await expect(new StateStore(file, '/repo').withRepositoryLock(mutate)).rejects.toMatchObject({ code: 'legacy_lock_requires_cleanup' });
    expect(mutate).not.toHaveBeenCalled();
    expect(await readdir(lock)).toEqual([name]);
    expect(await readFile(path.join(lock, name), 'utf8')).toBe('old directory owner');
  });

  it('refuses an old directory owner that publishes during protocol-container initialization', async () => {
    const file = path.join(dir, 'state.json');
    const lock = `${file}.repository.lock`;
    const protocol = path.join(lock, 'v2');
    const competing = path.join(dir, 'old-candidate');
    const name = `owner-${process.pid}-${randomUUID()}`;
    await mkdir(competing);
    await writeFile(path.join(competing, name), 'concurrent old owner');
    const originalMkdir = fs.mkdir;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (file, options) => {
      if (file === protocol) {
        await fs.rmdir(lock);
        await fs.rename(competing, lock);
      }
      return originalMkdir(file, options);
    });
    syncBuiltinESMExports();
    const mutate = vi.fn(async () => undefined);
    await expect(new StateStore(file, '/repo').withRepositoryLock(mutate)).rejects.toMatchObject({ code: 'legacy_lock_requires_cleanup' });
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(path.join(lock, name), 'utf8')).toBe('concurrent old owner');
    expect(await readdir(protocol)).toEqual([]);
  });

  it('refuses an unexpected file in the internal publication namespace', async () => {
    const file = path.join(dir, 'state.json');
    const protocol = path.join(`${file}.repository.lock`, 'v2');
    const active = path.join(protocol, 'active');
    await mkdir(protocol, { recursive: true });
    await writeFile(active, 'unknown owner');
    const mutate = vi.fn(async () => undefined);
    await expect(new StateStore(file, '/repo').withRepositoryLock(mutate)).rejects.toMatchObject({ code: 'legacy_lock_requires_cleanup' });
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(active, 'utf8')).toBe('unknown owner');
  });

  it('reclaims a dead directory owner and retains only the permanent protocol container', async () => {
    const file = path.join(dir, 'state.json');
    await directoryOwner(`${file}.lock`);
    await new StateStore(file, '/repo').update((s) => s.todos.push(todo('t')));
    expect(JSON.parse(await readFile(file, 'utf8')).todos).toHaveLength(1);
    expect(await readdir(`${file}.lock`)).toEqual(['v2']);
    expect(await readdir(path.join(`${file}.lock`, 'v2'))).toEqual([]);
    await expect(fs.open(`${file}.lock`, 'wx')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('recovers an empty directory left by a reclaimer that exited after deleting the dead owner', async () => {
    const file = path.join(dir, 'state.json');
    const protocol = path.join(`${file}.repository.lock`, 'v2');
    await mkdir(path.join(protocol, 'active'), { recursive: true });
    await expect(new StateStore(file, '/repo').withRepositoryLock(async () => 'recovered')).resolves.toBe('recovered');
    expect(await readdir(protocol)).toEqual([]);
  });

  it.each(['EPERM', 'EACCES'])('recovers an empty preview lease after a Windows-style %s directory rename failure', async (code) => {
    const file = path.join(dir, 'state.json');
    const protocol = path.join(`${file}.preview-owner.lock`, 'v2');
    const lock = path.join(protocol, 'active');
    await mkdir(lock, { recursive: true });
    const originalRename = fs.rename;
    let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === lock && !failed) {
        failed = true;
        throw Object.assign(new Error('Destination directory exists'), { code });
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    const lease = await new StateStore(file, '/repo').acquirePreviewLease();
    expect(lease).not.toBeNull();
    await lease!.release();
    expect(await readdir(protocol)).toEqual([]);
  });

  it.each(['EPERM', 'EACCES'])('retries a Windows-style %s publication race after the previous owner disappears', async (code) => {
    const file = path.join(dir, 'state.json');
    const locks = new Set([`${file}.lock`, `${file}.preview-owner.lock`].map((container) => path.join(container, 'v2', 'active')));
    const originalRename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      // The owner can release its directory before the contender handles the rename failure.
      if (locks.delete(String(to))) throw Object.assign(new Error('Destination was occupied'), { code });
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    const store = new StateStore(file, '/repo');
    await store.update((state) => {
      state.prefs.viewMode = 'split';
    });
    expect((await store.load()).prefs.viewMode).toBe('split');
    const lease = await store.acquirePreviewLease();
    expect(lease).not.toBeNull();
    await lease!.release();
    expect(locks.size).toBe(0);
    for (const container of [`${file}.lock`, `${file}.preview-owner.lock`]) expect(await readdir(path.join(container, 'v2'))).toEqual([]);
  });

  it.each(['EPERM', 'EACCES'])('preserves persistent %s failures after exhausting publication retries without an owner', async (code) => {
    const file = path.join(dir, 'state.json');
    const lock = path.join(`${file}.repository.lock`, 'v2', 'active');
    const originalRename = fs.rename;
    const failure = Object.assign(new Error('Publication is not permitted'), { code });
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === lock) throw failure;
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    expireLockWait();
    const mutate = vi.fn();
    await expect(new StateStore(file, '/repo').withRepositoryLock(mutate)).rejects.toBe(failure);
    expect(mutate).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(lock))).toEqual([]);
  });

  it('bounds repeated publication races even when the competing lock always vanishes before inspection', async () => {
    const file = path.join(dir, 'state.json');
    const protocol = path.join(`${file}.repository.lock`, 'v2');
    const lock = path.join(protocol, 'active');
    const originalRename = fs.rename;
    const publish = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === lock) throw Object.assign(new Error('Competing directory appeared'), { code: 'ENOTEMPTY' });
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    expireLockWait();
    await expect(new StateStore(file, '/repo').withRepositoryLock(async () => undefined)).rejects.toMatchObject({ code: 'operation_locked' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await readdir(protocol)).toEqual([]);
  });

  it('keeps a new repository owner while a second dead-owner reclaimer finishes late', async () => {
    const file = path.join(dir, 'state.json');
    const protocol = path.join(`${file}.repository.lock`, 'v2');
    const lock = path.join(protocol, 'active');
    const deadOwner = await directoryOwner(`${file}.repository.lock`);
    const bothReclaiming = signal();
    const firstEntered = signal();
    const lateCleanup = signal();
    const originalUnlink = fs.unlink;
    const originalRmdir = fs.rmdir;
    let reclaimers = 0;
    let firstInside = false;
    let active = 0;
    let entered = 0;
    vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (file === deadOwner) {
        if (++reclaimers === 1) await bothReclaiming.promise;
        else {
          bothReclaiming.resolve();
          await firstEntered.promise;
        }
      }
      return originalUnlink(file);
    });
    vi.spyOn(fs, 'rmdir').mockImplementation(async (file, options) => {
      try {
        return await originalRmdir(file, options);
      } finally {
        if (file === lock && firstInside) lateCleanup.resolve();
      }
    });
    syncBuiltinESMExports();
    const critical = async () => {
      expect(active++).toBe(0);
      if (++entered === 1) {
        firstInside = true;
        firstEntered.resolve();
        await lateCleanup.promise;
        expect(await readdir(lock)).toHaveLength(1);
        firstInside = false;
      }
      --active;
    };
    try {
      await Promise.all([new StateStore(file, '/repo').withRepositoryLock(critical), new StateStore(file, '/repo').withRepositoryLock(critical)]);
      expect(reclaimers).toBe(2);
      expect(entered).toBe(2);
      expect(await readdir(protocol)).toEqual([]);
    } finally {
      bothReclaiming.resolve();
      firstEntered.resolve();
      lateCleanup.resolve();
    }
  });

  it('keeps a live directory owner even when its heartbeat is stale', async () => {
    const file = path.join(dir, 'state.json');
    const owner = await directoryOwner(`${file}.repository.lock`, process.pid);
    const token = await readFile(owner, 'utf8');
    expireLockWait();
    await expect(new StateStore(file, '/repo').withRepositoryLock(async () => undefined)).rejects.toMatchObject({ code: 'operation_locked' });
    expect(await readFile(owner, 'utf8')).toBe(token);
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
        await rm(`${file}.lock`, { recursive: true });
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
      [`worktree:${slot}:local`]: { comments: [] },
      [`worktree:${slot}:working`]: { comments: [] },
      [`worktree:${slot}:base:main`]: { comments: [] },
      // `/x/repo-1` is a prefix of `/x/repo-10`; the colon after the path keeps them apart.
      'worktree:/x/repo-10:local': { comments: [] },
      local: { comments: [] },
      'base:main': { comments: [] },
    };
    forgetWorktreeTargets(s, slot);
    expect(Object.keys(s.targets).sort()).toEqual(['base:main', 'local', 'worktree:/x/repo-10:local']);
  });
});
