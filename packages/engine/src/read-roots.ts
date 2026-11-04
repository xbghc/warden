import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git.js';
import { GitSandbox } from './git-sandbox.js';
import type { RepoContext } from './repo.js';
import { listWorktreesAll } from './repo.js';
import type { StateStore } from './state.js';
import { checkoutState } from './worktrees.js';

export interface RepositoryReadRoot {
  path: string;
  identity: string;
}

/** Observe registered source directories without granting access to their parent or Git stores. */
export async function repositoryReadRoots(repo: RepoContext, store: StateStore): Promise<RepositoryReadRoot[]> {
  // Read scope needs ownership, not a scan of every checkout's dirty files.
  const [state, worktrees] = await Promise.all([store.load(), listWorktreesAll(repo)]);
  const candidates = [{ path: repo.commonRoot, allocation: 'primary' }];
  for (const task of state.workflow?.changes ?? []) {
    if (!task.worktree || task.deletion) continue;
    const checkout = worktrees.find((row) => row.path === task.worktree);
    if (!checkout || checkout.prunable || checkout.bare || checkout.branch !== task.branch) continue;
    if ((await checkoutState(repo, checkout)).foreign) continue;
    candidates.push({ path: task.worktree, allocation: JSON.stringify([task.id, task.createdAt, task.branch]) });
  }
  const preview = state.connectionPreview;
  if (preview?.directory && preview.worktree === preview.directory && !preview.migrating) {
    try {
      await GitSandbox.open(store, preview.directory).validate();
      candidates.push({ path: preview.directory, allocation: JSON.stringify(['preview', preview.developmentBranch]) });
    } catch {
      // Invalid or replaced previews remain available for manual inspection only.
    }
  }
  const roots: RepositoryReadRoot[] = [];
  for (const candidate of candidates) {
    try {
      const root = await realpath(candidate.path);
      // macOS /var and configured storage parents can be aliases. Reject a redirected
      // checkout itself, while retaining its registered spelling and canonical identity.
      const directory = await lstat(candidate.path);
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], { cwd: root })).stdout.trim();
      const identities = [];
      for (const file of [root, path.join(root, '.git'), gitDir]) {
        const info = await lstat(file);
        if (info.isSymbolicLink()) throw new Error('Redirected read root.');
        identities.push([await realpath(file), info.dev, info.ino, info.birthtimeMs, info.isFile() ? await readFile(file, 'utf8') : null]);
      }
      roots.push({
        path: path.resolve(candidate.path),
        identity: createHash('sha256')
          .update(JSON.stringify([candidate.allocation, identities]))
          .digest('hex'),
      });
    } catch {
      // Missing directories and uncertain Git identities never enlarge automatic approval.
    }
  }
  return roots;
}
