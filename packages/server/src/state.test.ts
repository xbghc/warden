import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Comment } from '@warden/shared';
import { StateStore, defaultState, ensureTarget, forgetWorktreeTargets, repoHash, stateFilePath } from './state.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'warden-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
      prefs: { viewMode: 'unified', nvimSocketByRoot: {}, autoRefresh: true, railOpen: false, ignoreDebug: true },
    });
  });

  it('drops rows that are missing the fields the server dereferences', async () => {
    const file = path.join(dir, 'state.json');
    const ok = {
      id: 'ok',
      targetKey: 'local',
      filePath: 'a.ts',
      side: 'new',
      startLine: 1,
      endLine: 1,
      codeSnippet: [],
      body: '',
      status: 'active',
      anchor: { hunkHash: 'h' },
    };
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        repoRoot: '/repo',
        targets: { local: { viewed: {}, comments: [null, 'junk', { id: 'no-anchor' }, ok] } },
        // Issues were folded into todos; what an older file kept of them is let go.
        issues: [{ id: 'i1', title: 't', body: '', status: 'open', commentIds: [] }],
        todos: [{ title: 'no id' }, { id: 't1', branch: 'main', title: 'x', body: '', status: 'open', createdAt: '', updatedAt: '' }],
        prefs: {},
      }),
    );
    const s = await new StateStore(file, '/repo').load();
    expect(s.targets.local!.comments.map((c) => c.id)).toEqual(['ok']);
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
        s.todos.push({ id: 't1', branch: 'main', title: 't', body: '', status: 'open', commentIds: [], createdAt: '', updatedAt: '' });
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

  it('moves comments from the local views into the shared scope and drops what is left of those views', async () => {
    const file = path.join(dir, 'state.json');
    const comment = (id: string, targetKey: string) => ({
      id,
      targetKey,
      filePath: 'a.ts',
      side: 'new',
      startLine: 1,
      endLine: 1,
      codeSnippet: [],
      body: id,
      status: 'active',
      anchor: { hunkHash: '', lineHashes: [], contextBefore: [], contextAfter: [], hunkLineOffset: 0 },
      createdAt: '',
      updatedAt: '',
    });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        targets: {
          working: { viewed: { 'a.ts': 'h' }, comments: [comment('c1', 'working')] },
          staged: { viewed: {}, comments: [comment('c2', 'staged')] },
          'commit:abc': { viewed: { 'a.ts': 'h' }, comments: [comment('c3', 'commit:abc')] },
        },
        issues: [],
      }),
    );
    const s = await new StateStore(file, '/repo').load();
    // Sorted key order: staged before working.
    expect(s.targets.local!.comments.map((c) => c.id)).toEqual(['c2', 'c1']);
    // The local views keep no viewed mark, so nothing is left to hold under their keys.
    expect(Object.keys(s.targets).sort()).toEqual(['commit:abc', 'local']);
    // A commit target keeps its own comments and its marks.
    expect(s.targets['commit:abc']!.comments.map((c) => c.id)).toEqual(['c3']);
    expect(s.targets['commit:abc']!.viewed).toEqual({ 'a.ts': 'h' });
    expect(s.todos).toEqual([]);
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

  it('does not write when its lock was taken over meanwhile, and leaves the new holder’s lock alone', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update((s) => s.todos.push(todo('first')));
    await expect(
      store.update(async (s) => {
        s.todos.push(todo('stale'));
        // Another process decided this one had stalled, took the lock and wrote.
        await writeFile(`${file}.lock`, 'other:holder');
      }),
    ).rejects.toMatchObject({ code: 'state_lock_lost' });
    expect(JSON.parse(await readFile(file, 'utf8')).todos.map((t: { id: string }) => t.id)).toEqual(['first']);
    expect(await readFile(`${file}.lock`, 'utf8')).toBe('other:holder');
  });
});

describe('forgetWorktreeTargets', () => {
  const comment = (id: string, targetKey: string): Comment => ({
    id,
    targetKey,
    filePath: 'a.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    codeSnippet: ['x'],
    body: 'b',
    status: 'active',
    anchor: { hunkHash: 'h', lineHashes: [], contextBefore: [], contextAfter: [], hunkLineOffset: 0 },
    createdAt: '',
    updatedAt: '',
  });

  it('drops every target under the worktree path, and no other, and unlinks their comments from issues', () => {
    const slot = '/x/repo-1';
    const s = defaultState('/x/repo');
    s.targets = {
      [`worktree:${slot}:local`]: { viewed: {}, comments: [comment('c1', `worktree:${slot}:working`)], head: 'abc' },
      [`worktree:${slot}:working`]: { viewed: { 'a.ts': 'h1' }, comments: [] },
      [`worktree:${slot}:base:main`]: { viewed: {}, comments: [comment('c2', `worktree:${slot}:base:main`)] },
      // `/x/repo-1` is a prefix of `/x/repo-10`; the colon after the path keeps them apart.
      'worktree:/x/repo-10:local': { viewed: {}, comments: [comment('c3', 'worktree:/x/repo-10:working')] },
      local: { viewed: {}, comments: [comment('c4', 'working')] },
      'base:main': { viewed: { 'a.ts': 'h2' }, comments: [] },
    };
    s.todos = [{ id: 't1', branch: 'main', title: 't', body: '', status: 'open', commentIds: ['c1', 'c2', 'c3', 'c4'], createdAt: '', updatedAt: '' }];
    forgetWorktreeTargets(s, slot);
    expect(Object.keys(s.targets).sort()).toEqual(['base:main', 'local', 'worktree:/x/repo-10:local']);
    expect(s.todos[0]!.commentIds).toEqual(['c3', 'c4']);
  });
});
