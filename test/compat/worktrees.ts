import type { WorktreeDetail } from './types.js';
import type { RepoContext } from '../../packages/engine/src/repo.js';
import { runGit } from '../../packages/engine/src/git.js';
import { listUpstreams, listWorktreesDetailed as readWorktrees } from '../../packages/engine/src/worktrees.js';

/** Keep retired management-page comparisons out of product workspace observations. */
export async function listWorktreesDetailed(ctx: RepoContext): Promise<WorktreeDetail[]> {
  const [all, upstreams] = await Promise.all([readWorktrees(ctx), listUpstreams(ctx.commonRoot)]);
  const shared = all.find((w) => w.shared && !w.prunable);
  const sharedUpstreams = shared ? await listUpstreams(shared.path) : undefined;
  const main = all.find((w) => w.isMain);
  const held = new Map<string, string>();
  for (const w of all) if (w.branch) held.set(w.branch, w.path);
  const details = await Promise.all(
    all.map(async (w) => {
      const detail: WorktreeDetail = { ...w };
      if (w.clone) return describeClone(detail, held);
      // A free slot holds no branch: there is nothing to compare.
      if (detail.free)
        return w.shared ? describeFreeBranches(detail, new Map(all.filter((row) => row.shared && row.branch).map((row) => [row.branch!, row.path]))) : detail;
      // A branch that has an upstream is counted against it, the main worktree's included: what is
      // not pushed or not pulled yet says more about it than its distance from whatever the main
      // worktree has checked out. The upstream is also the ref `git branch -d` checks before deleting.
      const upstream = w.branch ? (w.shared ? sharedUpstreams : upstreams)?.get(w.branch) : undefined;
      if (upstream && !upstream.gone) {
        detail.comparison = { kind: 'upstream', base: upstream.name, ahead: upstream.ahead, behind: upstream.behind };
        return detail;
      }
      // Once the upstream is gone `git branch -d` checks HEAD instead, and the count follows it there.
      if (upstream) detail.upstreamGone = upstream.name;
      if (w.isMain) return detail;
      if (!main?.head || !w.head || /^0+$/.test(main.head) || /^0+$/.test(w.head)) return { ...detail, comparisonError: 'The branch has no commits.' };
      try {
        const result = await runGit(['rev-list', '--left-right', '--count', `${main.head}...${w.head}`, '--'], {
          cwd: w.shared ? w.path : ctx.commonRoot,
        });
        const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
        detail.comparison = { kind: 'base', base: main.branch ?? `HEAD ${main.head.slice(0, 7)}`, ahead: ahead!, behind: behind! };
      } catch {
        detail.comparisonError = 'Unable to compare commit history.';
      }
      return detail;
    }),
  );
  return details;
}

/**
 * What the panel shows of a clone, read in the clone: its branches are its own. A branch with an
 * upstream is counted against it; any other, or one whose upstream is gone, against the clone's remote
 * default branch — the main worktree's HEAD is in another repository, one this clone shares nothing
 * with. A free clone lists its local branches, which the checkout form offers for it, each marked
 * with the checkout that has a branch of that name: two checkouts on one name would push to one
 * branch on the server.
 */
async function describeClone(detail: WorktreeDetail, held: Map<string, string>): Promise<WorktreeDetail> {
  if (detail.foreign) return detail;
  const cwd = detail.path;
  const trunk = detail.trunk;
  if (detail.free) return describeFreeBranches(detail, held);
  const upstream = detail.branch ? (await listUpstreams(cwd)).get(detail.branch) : undefined;
  if (upstream && !upstream.gone) {
    detail.comparison = { kind: 'upstream', base: upstream.name, ahead: upstream.ahead, behind: upstream.behind };
    return detail;
  }
  if (upstream) detail.upstreamGone = upstream.name;
  if (!trunk) return detail;
  try {
    const result = await runGit(['rev-list', '--left-right', '--count', `${trunk}...HEAD`, '--'], { cwd });
    const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
    detail.comparison = { kind: 'trunk', base: trunk, ahead: ahead!, behind: behind! };
  } catch {
    detail.comparisonError = 'Unable to compare commit history.';
  }
  return detail;
}

async function describeFreeBranches(detail: WorktreeDetail, held: Map<string, string>): Promise<WorktreeDetail> {
  const r = await runGit(['for-each-ref', '--format=%(refname:lstrip=2)%09%(objectname:short)', 'refs/heads'], { cwd: detail.path });
  detail.branches = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = ''] = line.split('\t');
      const worktree = held.get(name);
      return { name, sha, ...(worktree ? { worktree } : {}) };
    });
  return detail;
}
