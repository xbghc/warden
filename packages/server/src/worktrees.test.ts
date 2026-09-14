import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFixtureRepo } from '../../../test/fixtures/make-repo.js';
import { resolveRepo } from './repo.js';
import { listWorktreesDetailed } from './worktrees.js';

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
