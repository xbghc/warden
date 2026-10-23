import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { snapshotObjects, snapshotStore, snapshotWorktree } from '../packages/server/src/snapshots.js';
import { runGit } from '../packages/server/src/git.js';
import { makeFixtureRepo } from './fixtures/make-repo.js';

it('captures saved tracked and untracked content externally without changing the real index or refs', async () => {
  const fx = await makeFixtureRepo('warden-snapshot-');
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-data-'));
  try {
    await fx.write('src/a.ts', 'first\n');
    fx.git('add', 'src/a.ts');
    await fx.write('src/a.ts', 'other\n');
    await fx.write('new.txt', 'untracked\n');
    const index = await readFile(path.join(fx.root, '.git/index'));
    const refs = fx.git('show-ref');
    const store = snapshotStore(path.join(data, 'state.json'));
    const tree = await snapshotWorktree(fx.root, store);
    const snapshot = await snapshotObjects(fx.root, store);
    const read = (file: string) => runGit(['show', `${tree}:${file}`], { cwd: fx.root, snapshot });
    expect((await read('src/a.ts')).stdout).toBe('other\n');
    expect((await read('new.txt')).stdout).toBe('untracked\n');
    expect(await snapshotWorktree(fx.root, store)).toBe(tree);
    expect(await readFile(path.join(fx.root, '.git/index'))).toEqual(index);
    expect(fx.git('show-ref')).toBe(refs);
    expect(() => fx.git('cat-file', '-e', tree)).toThrow();
  } finally {
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});
