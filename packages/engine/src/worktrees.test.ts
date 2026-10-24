import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { makeFixtureRepo } from '../../../test/fixtures/make-repo.js';
import { resolveRepo } from './repo.js';
import { listWorktreesDetailed, nextSlot, slotPath } from './worktrees.js';

describe('worktree comparison', () => {
  it('compares a branch without an upstream against the main checkout branch, including after a merge and branch switch', async () => {
    const fx = await makeFixtureRepo();
    try {
      const wt = path.join(fx.root, 'topic-wt');
      fx.git('worktree', 'add', '-b', 'topic', wt);
      await fx.write('topic-wt/topic.txt', 'topic');
      fx.git('-C', wt, 'add', 'topic.txt');
      fx.git('-C', wt, 'commit', '-qm', 'topic change');
      await fx.write('main.txt', 'main');
      fx.git('add', 'main.txt');
      fx.git('commit', '-qm', 'main change');
      const ctx = await resolveRepo(fx.root);
      const comparison = async () => (await listWorktreesDetailed(ctx)).find((w) => w.branch === 'topic')?.comparison;
      expect(await comparison()).toEqual({ kind: 'base', base: 'main', ahead: 1, behind: 1 });
      fx.git('merge', '--no-ff', 'topic', '-m', 'merge topic');
      expect(await comparison()).toEqual({ kind: 'base', base: 'main', ahead: 0, behind: 2 });
      fx.git('switch', '-c', 'release');
      expect((await comparison())?.base).toBe('release');
    } finally {
      await fx.cleanup();
    }
  });

  it('counts a branch with an upstream against the upstream, and against the main checkout once it is gone', async () => {
    const fx = await makeFixtureRepo();
    try {
      const wt = path.join(fx.root, 'topic-wt');
      fx.git('worktree', 'add', '-b', 'topic', wt);
      // What pushing and fetching would leave, with no remote to reach: main level with origin/main,
      // and origin/topic carrying a commit pushed from somewhere else.
      fx.git('remote', 'add', 'origin', 'https://example.invalid/fixture.git');
      fx.git('update-ref', 'refs/remotes/origin/main', 'main');
      fx.git('update-ref', 'refs/remotes/origin/topic', fx.git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'pushed elsewhere').trim());
      fx.git('branch', '--set-upstream-to=origin/main', 'main');
      fx.git('branch', '--set-upstream-to=origin/topic', 'topic');
      await fx.write('topic-wt/topic.txt', 'topic');
      fx.git('-C', wt, 'add', 'topic.txt');
      fx.git('-C', wt, 'commit', '-qm', 'topic change');
      const ctx = await resolveRepo(fx.root);
      const detail = async (branch: string) => (await listWorktreesDetailed(ctx)).find((w) => w.branch === branch);
      expect((await detail('topic'))?.comparison).toEqual({ kind: 'upstream', base: 'origin/topic', ahead: 1, behind: 1 });
      expect((await detail('main'))?.comparison).toEqual({ kind: 'upstream', base: 'origin/main', ahead: 0, behind: 0 });
      // Deleted on the remote and pruned: `[origin/topic: gone]`.
      fx.git('update-ref', '-d', 'refs/remotes/origin/topic');
      expect(await detail('topic')).toMatchObject({ upstreamGone: 'origin/topic', comparison: { kind: 'base', base: 'main', ahead: 1, behind: 0 } });
    } finally {
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
      // A free slot has no branch to compare; the others are counted as before.
      expect(byName.get(path.basename(beside('1')))?.comparison).toBeUndefined();
      expect(byName.get(path.basename(beside('2')))?.comparison).toMatchObject({ kind: 'base', base: 'main' });
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
