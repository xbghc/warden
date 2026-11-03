import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskDeleteCheck, TaskDeleteResult, TaskDeletion, WorktreeDetail } from '@warden/shared';
import { isValidRef } from '@warden/shared';
import { WardenError, badRequest, notFound } from './errors.js';
import { refExists, runGit, runGitWrite } from './git.js';
import type { RepoContext } from './repo.js';
import { listWorktreesDetailed } from './worktrees.js';
import { forgetWorktreeTargets, type StateStore } from './state.js';
import { readWorktreeState } from './worktree-state.js';
import { PreviewService } from './preview.js';
import { ensureSharedRepository } from './shared-repository.js';
import { deleteTaskConversations, taskHasConnection, withoutTaskConnection } from './task-access.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message: string, code = 'task_delete_changed'): never {
  throw new WardenError(409, message, code);
}
const absent = (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
};

/** Fingerprint bytes without creating a snapshot or recovery copy. Symlinks are never followed. */
async function fileVersion(root: string, file: string) {
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(`${root}${path.sep}`)) fail('A workspace path is outside its assigned folder.', 'invalid_change_checkout');
  const parts = path.relative(root, resolved).split(path.sep);
  for (let i = 1; i < parts.length; i++) {
    const parent = await lstat(path.join(root, ...parts.slice(0, i))).catch(absent);
    if (!parent) return [file, 'missing'];
    if (!parent.isDirectory() || parent.isSymbolicLink()) return [file, 'redirected'];
  }
  const info = await lstat(resolved).catch(absent);
  if (!info) return [file, 'missing'];
  if (info.isSymbolicLink()) return [file, 'link', await readlink(resolved)];
  if (info.isDirectory()) {
    if (await lstat(path.join(resolved, '.git')).catch(absent))
      fail('The workspace contains a nested Git repository. Move it out of the task workspace before deleting the task.', 'task_delete_unsupported');
    return [file, 'directory', info.dev, info.ino, info.mtimeMs];
  }
  if (!info.isFile()) fail('The workspace contains a special file. Handle it before deleting the task.', 'task_delete_unsupported');
  const hash = createHash('sha256');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
  } finally {
    await handle.close();
  }
  return [file, info.mode, hash.digest('hex')];
}

async function checkoutIdentity(cwd: string) {
  const result = await runGit(['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], { cwd });
  const [privatePath, commonPath, top] = result.stdout.trim().split('\n');
  if (!privatePath || !commonPath || !top || (await realpath(top)) !== cwd || (await lstat(cwd)).isSymbolicLink())
    fail('The workspace folder was replaced.', 'invalid_change_checkout');
  const gitDir = await realpath(path.resolve(cwd, privatePath));
  const common = await realpath(path.resolve(cwd, commonPath));
  const entries = await Promise.all(
    [cwd, path.join(cwd, '.git'), gitDir, common].map(async (file) => {
      const info = await stat(file);
      return [await realpath(file), info.dev, info.ino, info.birthtimeMs, info.isFile() ? await readFile(file, 'utf8') : null];
    }),
  );
  if ((await lstat(path.join(cwd, '.git'))).isSymbolicLink()) fail('The workspace Git metadata was redirected.', 'invalid_change_checkout');
  return { gitDir, common, identity: digest(entries) };
}

export class TaskDeletionService {
  constructor(
    private readonly repo: RepoContext,
    private readonly store: StateStore,
  ) {}

  async check(taskId: string): Promise<TaskDeleteCheck> {
    const details = await this.inspect(taskId);
    return details.check;
  }

  private async inspect(taskId: string) {
    const state = await this.store.load();
    const task = state.workflow?.changes.find((row) => row.id === taskId);
    if (!task) throw notFound('Task not found.', 'unknown_change');
    if (task.developmentBranch !== state.workflow?.developmentBranch) fail('Switch to this task’s base branch before deleting it.', 'requirement_changed');
    if (task.integration)
      fail('This task has a pending commit in the primary folder. Finish or cancel that commit before deleting the task.', 'task_commit_pending');
    if (state.historyDraft?.applying && task.worktree && task.deliveries?.length)
      fail('Finish recording the current history operation before deleting this task.', 'task_commit_pending');
    let checkout: WorktreeDetail | undefined;
    let identity: string | undefined;
    let head: string | undefined;
    let branchTip: string | undefined;
    let gitDir: string | undefined;
    let version: unknown;
    let dirty = 0;
    if (task.worktree) {
      if (!isValidRef(task.branch) || task.worktree === this.repo.commonRoot) fail('The task workspace cannot be released.', 'invalid_change_checkout');
      const workspaces = await listWorktreesDetailed(this.repo);
      checkout = workspaces.find((row) => row.path === task.worktree);
      if (state.workflow!.changes.some((row) => row.id !== task.id && row.worktree === task.worktree))
        fail('Another task uses this workspace.', 'checkout_in_use');
      if (!checkout || checkout.prunable) {
        if (await lstat(task.worktree).catch(absent)) fail('The workspace folder was replaced. It has been preserved.', 'invalid_change_checkout');
        identity = 'missing';
      } else {
        if (checkout.isMain || checkout.bare || checkout.slot === undefined || checkout.foreign)
          fail('The workspace no longer belongs to this task repository.', 'invalid_change_checkout');
        const physical = await checkoutIdentity(task.worktree);
        ({ identity, gitDir } = physical);
        if (!checkout.clone && physical.gitDir === physical.common) fail('The workspace no longer has its own Git metadata.', 'invalid_change_checkout');
        if (!checkout.clone) {
          const registered = (await readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim();
          if ((await realpath(path.resolve(gitDir, registered))) !== (await realpath(path.join(task.worktree, '.git'))))
            fail('The workspace Git metadata belongs to another checkout.', 'invalid_change_checkout');
        }
        const locks = [
          path.join(gitDir, 'index.lock'),
          path.join(gitDir, 'HEAD.lock'),
          path.join(physical.common, 'packed-refs.lock'),
          path.join(physical.common, 'refs', 'heads', `${task.branch}.lock`),
        ];
        for (const file of locks)
          if (await lstat(file).catch(absent))
            fail('A Git operation is still writing this workspace. Wait for it to finish before deleting the task.', 'task_workspace_busy');
        if (task.deletion?.identity && task.deletion.identity !== identity)
          fail('The workspace was replaced after deletion started. The replacement has been preserved.', 'invalid_change_checkout');
        const current = await readWorktreeState(task.worktree);
        head = current.head;
        dirty = current.dirtyCount;
        if (!head) fail('The workspace has no identifiable HEAD.', 'invalid_change_checkout');
        let taskRebase = false;
        if (checkout.busy === 'rebase' && !current.branch) {
          const names = await Promise.all(['rebase-merge', 'rebase-apply'].map((dir) => readFile(path.join(gitDir!, dir, 'head-name'), 'utf8').catch(absent)));
          taskRebase = names.filter(Boolean).length === 1 && names.some((name) => name?.trim() === `refs/heads/${task.branch}`);
        }
        const released = task.deletion?.phase !== 'disconnecting' && !!task.deletion && !current.branch && head === task.deletion.head;
        if (current.branch !== task.branch && !taskRebase && !released)
          fail('The workspace switched branches. Restore the task branch before deleting it.', 'change_branch_moved');
        if (task.deletion?.head && task.deletion.phase !== 'disconnecting' && head !== task.deletion.head)
          fail('The workspace HEAD changed after workspace release started. It has been preserved.');
        const ref = `refs/heads/${task.branch}`;
        if (await refExists(task.worktree, ref)) branchTip = (await runGit(['rev-parse', '--verify', ref], { cwd: task.worktree })).stdout.trim();
        const index = await runGit(['ls-files', '--stage', '-z'], { cwd: task.worktree });
        if (index.stdout.split('\0').some((entry) => entry.startsWith('160000 ')))
          fail('This workspace contains submodules. Handle them before deleting the task.', 'task_delete_unsupported');
        const ignored = (await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: task.worktree })).stdout
          .split('\0')
          .filter(Boolean);
        // Reset must not replace ignored environment files, including directory/file collisions.
        const tree = (await runGit(['ls-tree', '-r', '-z', head], { cwd: task.worktree })).stdout.split('\0').filter(Boolean);
        if (tree.some((entry) => entry.startsWith('160000 ')))
          fail('This workspace contains submodules. Handle them before deleting the task.', 'task_delete_unsupported');
        const tracked = tree.map((entry) => entry.slice(entry.indexOf('\t') + 1));
        const casing = await runGit(['config', '--get', 'core.ignorecase'], { cwd: task.worktree, okCodes: [0, 1] });
        const value = casing.stdout.trim().toLowerCase();
        const ignoreCase = (casing.code === 0 && value === '') || ['true', 'yes', 'on'].includes(value) || (/^-?\d+$/.test(value) && Number(value) !== 0);
        const normalize = (file: string) => (ignoreCase ? file.toLowerCase() : file);
        const paths = new Set(tracked.map(normalize));
        const parents = new Set<string>();
        for (const file of paths) {
          const parts = file.split('/');
          for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join('/'));
        }
        if (
          ignored.some((file) => {
            const normalized = normalize(file);
            if (paths.has(normalized) || parents.has(normalized)) return true;
            const parts = normalized.split('/');
            return parts.some((_, i) => i > 0 && paths.has(parts.slice(0, i).join('/')));
          })
        )
          fail('Releasing this workspace would overwrite ignored local files. Handle those files before deleting the task.', 'task_delete_ignored');
        const files = [];
        // Bound open files and memory even when deleting a task in a large repository.
        for (const file of [...new Set(current.paths)].sort()) files.push(await fileVersion(task.worktree!, file));
        version = [current.statusFingerprint, index.stdout, files, ignored, checkout.busy];
      }
    }
    const deleteBranch =
      !!task.worktree &&
      !!task.ownsBranch &&
      !!branchTip &&
      (!task.deletion || task.deletion.phase === 'disconnecting' || task.deletion.branchTip === branchTip);
    const sourceVersion = digest([
      task.id,
      task.title,
      task.body,
      task.createdAt,
      task.developmentBranch,
      task.worktree,
      task.branch,
      task.worktree ? [task.sourceBase, task.sourceTree, task.deliveries] : null,
      identity,
      head,
      branchTip,
      version,
      deleteBranch,
    ]);
    const confirmation = digest([sourceVersion, task.deletion?.phase]);
    const check: TaskDeleteCheck = {
      taskId,
      title: task.title,
      developmentBranch: task.developmentBranch,
      worktree: task.worktree,
      branch: task.branch,
      dirty,
      operation: checkout?.busy,
      deleteBranch,
      confirmation,
      agentConnected: await taskHasConnection(this.store, taskId),
      retry: !!task.deletion,
    };
    return { task, checkout, identity, head, branchTip, gitDir, check, sourceVersion };
  }

  delete(taskId: string, confirmation: string): Promise<TaskDeleteResult> {
    if (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation)) throw badRequest('Confirm task deletion first.', 'invalid_request');
    return this.store.withRepositoryLock(async () => {
      const state = await this.store.load();
      if (state.workflow?.deletedTasks?.some((row) => row.id === taskId)) return { taskId };
      let details = await this.inspect(taskId);
      if (details.check.confirmation !== confirmation) fail('The task changed since the deletion confirmation. Review its current contents and confirm again.');
      await withoutTaskConnection(this.store, taskId, async () => {
        await this.store.update((state) => {
          const task = state.workflow!.changes.find((row) => row.id === taskId)!;
          task.deletion ??= { identity: details.identity, head: details.head, branchTip: details.branchTip, phase: 'disconnecting' };
          if (task.deletion.phase === 'disconnecting') {
            task.deletion.head = details.head;
            task.deletion.branchTip = details.branchTip;
          }
          delete task.deletion.error;
        });
      });
      try {
        // Preview publication already has its own recovery journal. Never free a source
        // while a failed disconnection still presents that source as connected.
        const preview = (await this.store.load()).connectionPreview;
        if (preview?.connectedIds.includes(taskId) || preview?.pending?.response.connectedIds.includes(taskId)) {
          await new PreviewService(this.repo, this.store).disconnectTaskLocked(taskId);
        }
        const latest = await this.inspect(taskId);
        // The journal is the only expected change while preview was being recomposed.
        // Recheck source bytes immediately before the first destructive operation.
        if (latest.sourceVersion !== details.sourceVersion) fail('The workspace changed while disconnecting preview. Confirm deletion again.');
        details = latest;
        await this.phase(taskId, 'releasing');
        const retainedBranch = await this.release(details);
        await this.phase(taskId, 'released');
        await deleteTaskConversations(this.store, taskId);
        await this.store.update((state) => {
          const task = state.workflow!.changes.find((row) => row.id === taskId)!;
          state.workflow!.deletedTasks ??= [];
          state.workflow!.deletedTasks.push({
            id: task.id,
            title: task.title,
            developmentBranch: task.developmentBranch,
            deletedAt: new Date().toISOString(),
            ...(task.worktree && task.deliveries?.length ? { deliveries: task.deliveries } : {}),
          });
          state.workflow!.changes = state.workflow!.changes.filter((row) => row.id !== taskId);
          for (const other of state.workflow!.changes) if (other.dependsOn) other.dependsOn = other.dependsOn.filter((id) => id !== taskId);
          if (task.worktree) forgetWorktreeTargets(state, task.worktree);
        });
        return { taskId, worktree: details.task.worktree, retainedBranch };
      } catch (error) {
        await this.store.update((state) => {
          const deletion = state.workflow?.changes.find((row) => row.id === taskId)?.deletion;
          if (deletion) deletion.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    });
  }

  private phase(taskId: string, phase: TaskDeletion['phase']) {
    return this.store.update((state) => {
      state.workflow!.changes.find((row) => row.id === taskId)!.deletion!.phase = phase;
    });
  }

  private async release(details: Awaited<ReturnType<TaskDeletionService['inspect']>>) {
    const { task, checkout, head } = details;
    if (!task.worktree) return undefined;
    if (details.identity === 'missing') {
      if (await lstat(task.worktree).catch(absent)) fail('The workspace path was replaced. It has been preserved.', 'invalid_change_checkout');
      if (checkout?.prunable) {
        const cwd = checkout.shared ? await ensureSharedRepository(this.repo.commonRoot) : this.repo.commonRoot;
        await runGitWrite(['worktree', 'remove', '--force', task.worktree], { cwd });
      }
      return task.branch;
    }
    if ((await checkoutIdentity(task.worktree)).identity !== details.identity) fail('The workspace identity changed.', 'invalid_change_checkout');
    const cwd = task.worktree;
    if (checkout?.busy) {
      if (checkout.busy === 'bisect') await runGitWrite(['bisect', 'reset', head!], { cwd });
      else await runGitWrite([checkout.busy, '--quit'], { cwd });
    }
    // Clean with the original ignore rules before resetting a task-edited .gitignore.
    // One -f preserves nested repositories. Never use -x or remove the slot directory.
    await runGitWrite(['clean', '-fd'], { cwd });
    // Detach without running checkout hooks or changing the task branch's tip.
    await runGitWrite(['update-ref', '--no-deref', 'HEAD', head!, head!], { cwd });
    await runGitWrite(['reset', '--hard', '--no-recurse-submodules', head!], { cwd });
    const final = await readWorktreeState(cwd);
    if (final.branch || final.head !== head) fail('The workspace changed during release. Retry after inspecting it.');
    const ref = `refs/heads/${task.branch}`;
    if (!(await refExists(cwd, ref))) return undefined;
    if (!details.check.deleteBranch) return task.branch;
    const current = (await runGit(['rev-parse', '--verify', ref], { cwd })).stdout.trim();
    const worktrees = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd });
    if (current !== details.branchTip || worktrees.stdout.split('\0').includes(`branch ${ref}`)) return task.branch;
    await runGitWrite(['update-ref', '-d', ref, current], { cwd });
    return undefined;
  }
}
