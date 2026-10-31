import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { makeFixtureRepo } from '../../../test/fixtures/make-repo.js';
import { resolveRepo } from './repo.js';
import { listWorktreesDetailed, nextSlot, slotPath } from './worktrees.js';

describe('worktree inventory', () => {
  it('reports unfinished operations in primary and non-slot development checkouts', async () => {
    const fx = await makeFixtureRepo();
    const linked = `${fx.root}-development`;
    try {
      fx.git('switch', '-qc', 'conflicting');
      await fx.write('src/b.ts', 'Conflicting change\n');
      fx.git('commit', '-qam', 'Conflicting change');
      fx.git('switch', 'main');
      await fx.write('src/b.ts', 'Primary change\n');
      fx.git('commit', '-qam', 'Primary change');
      fx.git('worktree', 'add', '-b', 'development', linked, 'main');
      expect(() => fx.git('merge', 'conflicting')).toThrow();
      expect(() => fx.git('-C', linked, 'cherry-pick', 'conflicting')).toThrow();
      const rows = await listWorktreesDetailed(await resolveRepo(fx.root));
      expect(rows.find((row) => row.isMain)).toMatchObject({ busy: 'merge', free: false });
      expect(rows.find((row) => row.path === linked)).toMatchObject({ busy: 'cherry-pick', free: false });
      fx.git('merge', '--abort');
      fx.git('-C', linked, 'cherry-pick', '--abort');
      expect((await listWorktreesDetailed(await resolveRepo(fx.root))).every((row) => !row.busy)).toBe(true);
    } finally {
      await rm(linked, { recursive: true, force: true });
      await fx.cleanup();
    }
  });
});

describe('slots', () => {
  it('numbers the slots beside the main worktree, tells a free one from a taken one, and finds the next number', async () => {
    const fx = await makeFixtureRepo();
    const beside = (name: string) => path.join(path.dirname(fx.root), `${path.basename(fx.root)}-${name}`);
    try {
      fx.git('worktree', 'add', '-q', '--detach', beside('1'));
      fx.git('worktree', 'add', '-q', '-b', 'topic', beside('2'));
      // Detached and clean, but not named as a slot: never reused, never in the way of a number.
      fx.git('worktree', 'add', '-q', '--detach', beside('feature'));
      // A directory that is not a worktree takes its number when it has anything in it.
      await mkdir(beside('3'));
      await writeFile(path.join(beside('3'), 'leftover'), '');
      await mkdir(beside('4'));
      const ctx = await resolveRepo(fx.root);
      const details = async () => new Map((await listWorktreesDetailed(ctx)).map((w) => [path.basename(w.path), w]));
      let byName = await details();
      expect(byName.get(path.basename(fx.root))).toMatchObject({ isMain: true, free: false });
      expect(byName.get(path.basename(fx.root))?.slot).toBeUndefined();
      expect(byName.get(path.basename(beside('1')))).toMatchObject({ slot: 1, free: true, detached: true, dirty: 0 });
      expect(byName.get(path.basename(beside('2')))).toMatchObject({ slot: 2, free: false, branch: 'topic' });
      expect(byName.get(path.basename(beside('feature')))).toMatchObject({ free: false, detached: true });
      expect(byName.get(path.basename(beside('feature')))?.slot).toBeUndefined();
      expect(await nextSlot(ctx, [...byName.values()])).toEqual({ slot: 4, path: slotPath(ctx, 4) });
      // Anything to lose takes the slot out of the free ones.
      await writeFile(path.join(beside('1'), 'wip.txt'), 'x');
      byName = await details();
      expect(byName.get(path.basename(beside('1')))).toMatchObject({ slot: 1, free: false, dirty: 1 });
    } finally {
      for (const name of ['1', '2', 'feature']) {
        try {
          fx.git('worktree', 'remove', '--force', beside(name));
        } catch {
          /* not made */
        }
      }
      for (const name of ['1', '2', '3', '4', 'feature']) await rm(beside(name), { recursive: true, force: true });
      await fx.cleanup();
    }
  });
});
