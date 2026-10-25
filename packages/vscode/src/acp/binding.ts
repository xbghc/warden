import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '@warden/engine';
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
  const [workflow, workspaces] = await Promise.all([engine.execute('workflow.get', undefined), engine.execute('workspaces.list', undefined)]);
  const task = workflow.workflow?.changes.find((row) => row.id === taskId);
  if (!task?.worktree || !task.branch) throw new Error('请先为此任务创建工作区');
  const checkout = workspaces.worktrees.find((row) => row.path === task.worktree);
  if (!checkout || checkout.foreign || checkout.prunable) throw new Error('任务工作区已变化，请确认任务归属后重新连接');
  const workspace = await realpath(task.worktree);
  const repository = await realpath(engine.root);
  if (workspace === repository) throw new Error('Agent 会话必须使用任务工作区');
  const gitPath = async (flag: string) => {
    const result = await runGit(['rev-parse', flag], { cwd: workspace });
    return realpath(path.resolve(workspace, result.stdout.trim()));
  };
  const [gitDir, commonDir] = await Promise.all([gitPath('--absolute-git-dir'), gitPath('--git-common-dir')]);
  // A conversation may be needed to resolve the operation itself. Keep allocation checks,
  // but do not turn Git's in-progress state into an agent execution gate.
  if (checkout.branch !== task.branch && !(checkout.detached && checkout.busy === 'rebase' && (await rebaseBelongsToTask(gitDir, task.branch))))
    throw new Error('任务工作区已变化，请确认任务分支后重新连接');
  const paths = [repository, workspace, path.join(workspace, '.git'), gitDir, commonDir];
  const identities = await Promise.all(
    paths.map(async (file) => {
      const [canonical, info] = await Promise.all([realpath(file), stat(file)]);
      return [canonical, info.dev, info.ino, info.birthtimeMs, info.isFile() ? await readFile(file, 'utf8') : null];
    }),
  );
  const identity = createHash('sha256')
    .update(JSON.stringify([repository, task.id, task.createdAt, task.branch, task.developmentBranch, identities]))
    .digest('hex');
  return { repository, taskId, title: task.title, workspace, branch: task.branch, identity };
}

export async function validateAcpBinding(engine: Engine, binding: AcpBinding) {
  const current = await resolveAcpBinding(engine, binding.taskId);
  if (current.identity !== binding.identity || current.workspace !== binding.workspace || current.branch !== binding.branch)
    throw new Error('此会话对应的任务工作区已被替换，请重新打开任务对话');
}
