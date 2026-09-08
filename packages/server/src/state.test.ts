import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore, ensureTarget, repoHash, stateFilePath } from './state.js';

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
      issues: [],
      todos: [],
      prefs: { viewMode: 'unified', nvimSocketByRoot: {}, autoRefresh: true },
    });
  });

  it('drops rows that are missing the fields the server dereferences', async () => {
    const file = path.join(dir, 'state.json');
    const ok = { id: 'ok', targetKey: 'local', filePath: 'a.ts', side: 'new', startLine: 1, endLine: 1, codeSnippet: [], body: '', status: 'active', anchor: { hunkHash: 'h' } };
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        repoRoot: '/repo',
        targets: { local: { viewed: {}, comments: [null, 'junk', { id: 'no-anchor' }, ok] } },
        issues: [null, { title: 'no id' }, { id: 'i1', title: 't', body: '', status: 'open', commentIds: [] }],
        todos: [{ title: 'no id' }, { id: 't1', branch: 'main', title: 'x', body: '', status: 'open', createdAt: '', updatedAt: '' }],
        prefs: {},
      }),
    );
    const s = await new StateStore(file, '/repo').load();
    expect(s.targets.local!.comments.map((c) => c.id)).toEqual(['ok']);
    expect(s.issues.map((i) => i.id)).toEqual(['i1']);
    expect(s.todos.map((t) => t.id)).toEqual(['t1']);
  });

  it('persists mutations atomically and reloads them', async () => {
    const file = path.join(dir, 'nested', 'state.json');
    const store = new StateStore(file, '/repo');
    await store.update((s) => {
      ensureTarget(s, 'working').viewed['a.ts'] = 'hash1';
      s.prefs.viewMode = 'split';
    });
    const again = new StateStore(file, '/repo');
    const s = await again.load();
    expect(s.targets.working?.viewed).toEqual({ 'a.ts': 'hash1' });
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
        ensureTarget(s, 'working').viewed['a.ts'] = '1';
      }),
      b.update((s) => {
        ensureTarget(s, 'working').viewed['b.ts'] = '2';
      }),
      a.update((s) => {
        s.issues.push({ id: 'i1', title: 't', body: '', status: 'open', commentIds: [], createdAt: '', updatedAt: '' });
      }),
    ]);
    const s = await a.load();
    expect(s.targets.working?.viewed).toEqual({ 'a.ts': '1', 'b.ts': '2' });
    expect(s.issues).toHaveLength(1);
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

  it('migrates comments from the local views into the shared scope', async () => {
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
          'commit:abc': { viewed: {}, comments: [comment('c3', 'commit:abc')] },
        },
        issues: [],
      }),
    );
    const s = await new StateStore(file, '/repo').load();
    // Sorted key order: staged before working.
    expect(s.targets.local!.comments.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(s.targets.working!.comments).toEqual([]);
    expect(s.targets.staged!.comments).toEqual([]);
    // `viewed` is per view and stays where it was; commit targets keep their own comments.
    expect(s.targets.working!.viewed).toEqual({ 'a.ts': 'h' });
    expect(s.targets['commit:abc']!.comments.map((c) => c.id)).toEqual(['c3']);
    expect(s.todos).toEqual([]);
  });

  it('ignores unknown schema versions', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 99, targets: { x: {} } }));
    const s = await new StateStore(file, '/repo').load();
    expect(s.schemaVersion).toBe(1);
    expect(s.targets).toEqual({});
  });
});
