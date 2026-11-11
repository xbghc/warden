import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectTaskWorktree, runGit } from '@warden/engine';
import type { Engine } from '@warden/engine';
import type { AcpBinding } from '@warden/shared';

/** Rebase temporarily detaches HEAD; its private metadata retains the task branch being replayed. */
async function rebaseBelongsToTask(gitDir: string, branch: string): Promise<boolean> {
  let found = 0;
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const directory = path.join(gitDir, name);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const head = path.join(directory, 'head-name');
    const file = await lstat(head).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!file?.isFile() || file.isSymbolicLink() || file.size > 4_096 || (await readFile(head, 'utf8')).trim() !== `refs/heads/${branch}`) return false;
    ++found;
  }
  return found === 1;
}

/** Task allocation and Git registration identify a conversation; commits do not. */
export async function resolveAcpBinding(engine: Engine, taskId: string): Promise<AcpBinding> {
  const state = await engine.store.load();
  const task = state.workflow?.changes.find((row) => row.id === taskId);
  if (task?.deletion) throw new Error('Task deletion is pending. Retry deletion before using this workspace.');
  if (!task?.worktree || !task.branch) throw new Error('The task workspace is not ready. Reopen the task.');
  const checkout = await inspectTaskWorktree(engine.repo, task.worktree);
  if (!checkout || checkout.foreign || checkout.prunable) throw new Error('The task workspace changed. Confirm its task association and reconnect.');
  const [workspace, repository] = await Promise.all([realpath(task.worktree), realpath(engine.root)]);
  if (workspace === repository) throw new Error('Agent sessions must use the task workspace.');
  const dotGit = path.join(workspace, '.git');
  let gitDir: string;
  let commonDir: string;
  let canonicalDotGit: string;
  if (checkout.clone) {
    canonicalDotGit = await realpath(dotGit);
    gitDir = canonicalDotGit;
    commonDir = canonicalDotGit;
  } else {
    const revParse = await runGit(['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd: workspace });
    const [rawGitDir, rawCommonDir] = revParse.stdout.trim().split('\n');
    if (!rawGitDir || !rawCommonDir) throw new Error('The task workspace changed. Confirm its task association and reconnect.');
    [gitDir, commonDir, canonicalDotGit] = await Promise.all([
      realpath(path.resolve(workspace, rawGitDir)),
      realpath(path.resolve(workspace, rawCommonDir)),
      realpath(dotGit),
    ]);
  }
  // A conversation may be needed to resolve the operation itself. Keep allocation checks,
  // but do not turn Git's in-progress state into an agent execution gate.
  if (checkout.branch !== task.branch && !(checkout.detached && checkout.busy === 'rebase' && (await rebaseBelongsToTask(gitDir, task.branch))))
    throw new Error('The task workspace changed. Confirm its branch and reconnect.');
  const paths: [string, string][] = [
    [repository, repository],
    [workspace, workspace],
    [dotGit, canonicalDotGit],
    [gitDir, gitDir],
    [commonDir, commonDir],
  ];
  const identities = await Promise.all(
    paths.map(async ([file, canonical]) => {
      const info = await stat(file);
      return [canonical, info.dev, info.ino, info.birthtimeMs, info.isFile() ? await readFile(file, 'utf8') : null];
    }),
  );
  const identity = createHash('sha256')
    .update(JSON.stringify([repository, task.id, task.createdAt, task.branch, task.developmentBranch, identities]))
    .digest('hex');
  return { repository, taskId, title: task.title, workspace, branch: task.branch, baseBranch: task.developmentBranch, identity };
}

/** The identity hashes the base branch, so saved bindings need not store it. */
export function sameAcpBinding(a: AcpBinding, b: AcpBinding): boolean {
  return a.repository === b.repository && a.taskId === b.taskId && a.workspace === b.workspace && a.branch === b.branch && a.identity === b.identity;
}

export async function validateAcpBinding(engine: Engine, binding: AcpBinding) {
  const current = await resolveAcpBinding(engine, binding.taskId);
  if (!sameAcpBinding(current, binding)) throw new Error('The workspace for this session was replaced. Reopen the task conversation.');
}
