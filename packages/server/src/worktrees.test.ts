import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFixtureRepo } from '../../../test/fixtures/make-repo.js';
import { resolveRepo } from './repo.js';
import { listWorktreesDetailed } from './worktrees.js';

describe('worktree comparison', () => {
  it('compares against the main checkout branch, including after a merge and branch switch', async () => {
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
      expect(await comparison()).toEqual({ base: 'main', ahead: 1, behind: 1, merged: false });
      fx.git('merge', '--no-ff', 'topic', '-m', 'merge topic');
      expect(await comparison()).toEqual({ base: 'main', ahead: 0, behind: 2, merged: true });
      fx.git('switch', '-c', 'release');
      expect((await comparison())?.base).toBe('release');
    } finally {
      await fx.cleanup();
    }
  });
});
