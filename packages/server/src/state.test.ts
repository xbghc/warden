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
    expect(s).toEqual({ schemaVersion: 1, repoRoot: '/repo', targets: {}, issues: [], prefs: { viewMode: 'unified', nvimSocketByRoot: {} } });
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

  it('ignores unknown schema versions', async () => {
    const file = path.join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 99, targets: { x: {} } }));
    const s = await new StateStore(file, '/repo').load();
    expect(s.schemaVersion).toBe(1);
    expect(s.targets).toEqual({});
  });
});
