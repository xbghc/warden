import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { RepoInfo, WorktreeInfo } from '@warden/shared';
import { refExists, runGit } from './git.js';
import { HttpError } from './errors.js';

export interface RepoContext {
  /** Root of the worktree the server was started in. */
  root: string;
  /** Root of the main worktree (where .git lives). */
  commonRoot: string;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function resolveRepo(dir: string): Promise<RepoContext> {
  let top: string;
  try {
    const r = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    top = r.stdout.trim();
  } catch (e) {
    throw new HttpError(400, `${dir} is not inside a git repository`, 'not_a_repo');
  }
  if (!top) throw new HttpError(400, `${dir} is not inside a git worktree (bare repository?)`, 'not_a_repo');
  const root = await safeRealpath(top);
  const common = await runGit(['rev-parse', '--git-common-dir'], { cwd: root });
  const commonDir = await safeRealpath(path.resolve(root, common.stdout.trim()));
  const commonRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : root;
  return { root, commonRoot };
}

export async function listWorktrees(ctx: RepoContext): Promise<WorktreeInfo[]> {
  const r = await runGit(['worktree', 'list', '--porcelain'], { cwd: ctx.root });
  const out: WorktreeInfo[] = [];
  let cur: (Partial<WorktreeInfo> & { prunable?: boolean }) | null = null;
  const flush = () => {
    // A worktree whose directory was deleted behind git's back is still listed, marked prunable.
    // Nothing can be reviewed there, so it is not offered — the same as after `git worktree remove`.
    if (cur && cur.path && !cur.prunable) {
      out.push({
        path: cur.path,
        head: cur.head ?? '',
        branch: cur.branch,
        isMain: false,
        detached: cur.detached ?? false,
        bare: cur.bare ?? false,
      });
    }
    cur = null;
  };
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length) };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  flush();
  // Normalise paths through realpath so they match ctx.root/commonRoot comparisons.
  for (const wt of out) {
    wt.path = await safeRealpath(wt.path);
    wt.isMain = wt.path === ctx.commonRoot;
  }
  return out;
}

/** Branch checked out at `cwd`. A detached HEAD is identified by its short sha instead. */
export async function currentBranch(cwd: string): Promise<string> {
  const res = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).catch(() => ({ stdout: '' }));
  const name = res.stdout.trim();
  if (name && name !== 'HEAD') return name;
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd }).catch(() => ({ stdout: '' }));
  const sha = head.stdout.trim();
  return sha ? sha.slice(0, 7) : 'HEAD';
}

/** The trunk a feature branch is most likely reviewed against: `main`, else `master`. */
async function detectDefaultBase(cwd: string): Promise<string | undefined> {
  for (const ref of ['main', 'master']) if (await refExists(cwd, ref)) return ref;
  return undefined;
}

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
