import type { RepoInfo } from './types.js';
import { currentBranch, detectDefaultBase, listWorktrees, type RepoContext } from '../../packages/engine/src/repo.js';
import { runGit } from '../../packages/engine/src/git.js';

export async function getRepoInfo(ctx: RepoContext, defaultTarget: string): Promise<RepoInfo> {
  const [branch, headRes, worktrees, defaultBase] = await Promise.all([
    currentBranch(ctx.root),
    runGit(['rev-parse', 'HEAD'], { cwd: ctx.root }).catch(() => ({ stdout: '' })),
    listWorktrees(ctx),
    detectDefaultBase(ctx.root),
  ]);
  return {
    root: ctx.root,
    commonRoot: ctx.commonRoot,
    branch,
    head: headRes.stdout.trim(),
    worktrees,
    defaultTarget,
    ...(defaultBase ? { defaultBase } : {}),
  };
}
