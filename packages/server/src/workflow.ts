import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import type {
  AcceptChangeRequest,
  CreateChangeRequest,
  PlannedChange,
  StartChangeRequest,
  UpdateChangeRequest,
  WorkflowTask,
  DevelopmentChange,
  DevelopmentPreparation,
  DevelopmentWorkflow,
  PrepareChangeRequest,
  ReviewState,
  WorkflowResponse,
  WorktreeDetail,
  RebaseCheck,
  RebaseBatchRequest,
  RebaseBatchResponse,
} from '@warden/shared';
import { moveBefore, commentScopeKey, commentWorktree, formatTargetKey, isValidRef, tryParseTargetKey } from '@warden/shared';
import { runWorkspaceHook } from './workspace.js';
import { badRequest, HttpError, notFound } from './errors.js';
import { GitError, LONG_GIT_TIMEOUT_MS, gitEnvironment, refExists, runGit, runGitWrite } from './git.js';
import { listWorktreesAll, type RepoContext } from './repo.js';
import { ensureTarget, forgetWorktreeTargets, type StateStore } from './state.js';
import { checkoutState, checkoutWorktree, dirtyCount, listWorktreesDetailed, nextSlot } from './worktrees.js';
import { applyPatch, GitSandbox, oid, patchBetween, gitOid, deliveryBase } from './git-sandbox.js';
import { PreviewService } from './preview.js';
import { assertSafetyBackupCurrent, createSafetyBackup, discardOperationBackup } from './backups.js';
import { retireWorkflowRefs } from './retention.js';
import { readWorktreeState } from './worktree-state.js';

function fail(message: string, code: string): never {
  throw new HttpError(409, message, code);
}
async function revParse(cwd: string, ref: string): Promise<string> {
  return (await runGit(['rev-parse', '--verify', ref], { cwd })).stdout.trim();
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const active = (change: WorkflowTask): change is DevelopmentChange =>
  change.status === 'working' || change.status === 'ready' || change.status === 'integrating';
const workflowOf = (state: ReviewState): DevelopmentWorkflow => state.workflow ?? fail('请先选择需求主开发分支', 'workflow_not_configured');
const changeOf = (state: ReviewState, id: string): DevelopmentChange => {
  const change = workflowOf(state).changes.find((row) => row.id === id);
  if (!change) throw notFound('任务不存在', 'unknown_change');
  if (!change.worktree) fail('请先开始任务并分配工位', 'change_not_started');
  return change;
};

type RebaseVerdict = Pick<RebaseCheck, 'status' | 'files' | 'message'>;
type RebaseInputs = { fingerprint: string; paths: string[]; commonDirectory: string };
const REBASE_CACHE_LIMIT = 64;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// These settings can read mutable files or run programs whose output is not determined by
// the pinned commits. Conditional includes can also differ at a generated sandbox path.
const opaqueRebaseConfig = /^(?:include(?:if)?\.|filter\.|merge\.[\s\S]*?\.driver(?:\s|$)|core\.(?:attributesfile|fsmonitor|worktree)(?:\s|$))/im;
const configLocationVariables = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'HOME', 'XDG_CONFIG_HOME', 'GIT_EXEC_PATH']);

async function finishReads<T extends readonly unknown[]>(reads: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(reads);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

async function fileExists(file: string) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function repositoryIdentity(paths: string[]) {
  return finishReads(
    paths.map(async (file) => {
      const [resolved, info] = await finishReads([realpath(file), stat(file)]);
      // A worktree's .git file can be repointed without replacing its directory. Directory
      // mtimes, in contrast, change during ordinary editing and do not identify a checkout.
      return [resolved, info.dev, info.ino, info.birthtimeMs, info.isFile() ? await readFile(file, 'utf8') : null];
    }),
  );
}

/** User-reviewed deliveries in persistent workspaces. No automatic rebase or remote pushes. */
export class WorkflowService {
  private rebaseTrials = new Map<string, Promise<RebaseVerdict>>();
  private attributePaths?: { environment: string; paths: Promise<string[] | undefined> };

  constructor(
    private repo: RepoContext,
    private store: StateStore,
  ) {}

  async get(): Promise<WorkflowResponse> {
    const state = await this.store.load();
    const workflow = state.workflow ?? null;
    const legacyTodos = state.todos;
    const workspaceConfig = { hooks: state.workspaceConfig?.hooks ?? {} };
    if (!workflow) return { workflow, workspaceConfig, legacyTodos };
    try {
      const developmentHead = await this.developmentHead(workflow.developmentBranch);
      const working = workflow.changes.filter(
        (row): row is DevelopmentChange => !!row.worktree && row.status === 'working' && row.developmentBranch === workflow.developmentBranch,
      );
      const checkouts = working.length ? this.listCheckouts() : undefined;
      for (const row of working) {
        try {
          const checkout = await this.checkout(row, checkouts);
          if ((await deliveryBase(row, await revParse(checkout.path, 'HEAD'), developmentHead)) === developmentHead) {
            row.base = developmentHead;
            delete row.sourceBase;
            delete row.sync;
          }
        } catch {
          /* Unavailable workspaces are reported by the synchronization checks. */
        }
      }
      const pending = workflow.changes.find((change): change is DevelopmentChange => change.status === 'integrating');
      return { workflow, workspaceConfig, legacyTodos, developmentHead, preparation: pending ? await this.inspect(pending) : undefined };
    } catch (error) {
      return { workflow, workspaceConfig, legacyTodos, error: errorMessage(error) };
    }
  }

  private developmentHead(branch: string) {
    return revParse(this.repo.commonRoot, `refs/heads/${branch}`);
  }

  private taskBaseline(workflow: DevelopmentWorkflow, branch = workflow.developmentBranch) {
    // A manual commit may exist before the reviewer has confirmed it. Sibling agents continue
    // from the last accepted baseline until this integration finishes.
    return (
      workflow.changes.find((change) => change.status === 'integrating' && change.developmentBranch === branch)?.integration?.parent ??
      this.developmentHead(branch)
    );
  }

  private async save(change: WorkflowTask) {
    await this.store.update((state) => {
      const changes = workflowOf(state).changes;
      const index = changes.findIndex((row) => row.id === change.id);
      if (index < 0) changes.push(change);
      else changes[index] = change;
    });
  }

  configure(branch: string) {
    return this.store.withRepositoryLock(async () => {
      if (!branch || !isValidRef(branch) || !(await refExists(this.repo.commonRoot, `refs/heads/${branch}`)))
        throw badRequest('请选择一个已有的本地主开发分支', 'invalid_development_branch');
      await this.store.update((state) => {
        if (state.workflow?.developmentBranch === branch) return;
        if (state.workflow?.changes.some((c) => c.status === 'integrating') || state.connectionPreview?.connectedIds.length)
          fail('请先完成主目录提交并断开预览连接，再切换主开发分支', 'development_in_use');
        state.workflow = { developmentBranch: branch, changes: state.workflow?.changes ?? [] };
        delete state.connectionPreview;
      });
      return this.get();
    });
  }

  private planFields(request: CreateChangeRequest | UpdateChangeRequest) {
    const patch: UpdateChangeRequest = {};
    if (request.title !== undefined) {
      if (typeof request.title !== 'string' || !request.title.trim() || request.title.trim().length > 200)
        throw badRequest('请填写 1–200 字的任务标题', 'invalid_title');
      patch.title = request.title.trim();
    }
    for (const field of ['body', 'acceptance'] as const) {
      if (request[field] === undefined) continue;
      if (typeof request[field] !== 'string' || request[field].length > 10000) throw badRequest('任务说明不能超过 10000 字', 'invalid_plan');
      patch[field] = request[field].trim();
    }
    if (request.dependsOn !== undefined) {
      if (!Array.isArray(request.dependsOn) || request.dependsOn.some((key) => typeof key !== 'string'))
        throw badRequest('任务依赖格式错误', 'invalid_dependencies');
      // Preserve old clients' notes without turning them into scheduling constraints.
      patch.dependsOn = [...new Set(request.dependsOn)];
    }
    return patch;
  }

  create(request: CreateChangeRequest) {
    return this.store.withRepositoryLock(async () => {
      const state = await this.store.load();
      const workflow = workflowOf(state);
      const id = randomUUID();
      const fields = this.planFields(request);
      if (!fields.title) throw badRequest('请填写任务标题', 'invalid_title');
      const comments = Object.values(state.targets).flatMap((row) => row.comments);
      if (request.commentIds !== undefined && (!Array.isArray(request.commentIds) || request.commentIds.some((key) => !comments.some((c) => c.id === key))))
        throw badRequest('关联的评论不存在', 'invalid_comments');
      const change: PlannedChange = {
        ...fields,
        id,
        title: fields.title,
        developmentBranch: workflow.developmentBranch,
        status: 'planned',
        createdAt: new Date().toISOString(),
        ...(request.commentIds?.length ? { commentIds: [...new Set(request.commentIds)] } : {}),
      };
      // Adopting an existing checkout is an explicit execution request. Ordinary planning does
      // not inspect or create worktrees and does not pin a development baseline prematurely.
      if (request.worktree) return this.startTask(change, { worktree: request.worktree }, workflow);
      await this.save(change);
      return change;
    });
  }

  update(id: string, request: UpdateChangeRequest) {
    return this.store.withRepositoryLock(async () => {
      const workflow = workflowOf(await this.store.load());
      const change = workflow.changes.find((row) => row.id === id);
      if (!change) throw notFound('任务不存在', 'unknown_change');
      if (request.status && change.worktree) throw badRequest('工作区不需要申报任务状态', 'change_started');
      if (request.status !== undefined && request.status !== 'planned' && request.status !== 'archived') throw badRequest('无效的计划状态', 'invalid_plan');
      Object.assign(change, this.planFields(request));
      if (request.status) change.status = request.status;
      await this.save(change);
      return change;
    });
  }

  move(id: string, before: string | null) {
    return this.store.withRepositoryLock(async () => {
      if (before !== null && typeof before !== 'string') throw badRequest('before must be an id or null');
      await this.store.update((state) => {
        const workflow = workflowOf(state);
        const change = workflow.changes.find((row) => row.id === id);
        if (!change) throw notFound('任务不存在', 'unknown_change');
        if (before !== null && !workflow.changes.some((row) => row.id === before && row.developmentBranch === change.developmentBranch))
          throw badRequest('排序目标必须属于同一主开发分支', 'invalid_order');
        workflow.changes = moveBefore(workflow.changes, id, before)!;
      });
      return this.get();
    });
  }

  importTodo(id: string) {
    return this.store.withRepositoryLock(async () => {
      await this.store.update((state) => {
        const workflow = workflowOf(state);
        const todo = state.todos.find((row) => row.id === id);
        if (!todo) throw notFound('待办已导入或不存在', 'unknown_todo');
        workflow.changes.push({
          id: `todo-${todo.id}`,
          title: todo.title,
          body: todo.body,
          commentIds: todo.commentIds,
          developmentBranch: workflow.developmentBranch,
          status: todo.status === 'done' ? 'archived' : 'planned',
          createdAt: todo.createdAt,
          legacyTodo: { branch: todo.branch, status: todo.status },
        });
        state.todos = state.todos.filter((row) => row.id !== id);
      });
      return this.get();
    });
  }

  start(id: string, request: StartChangeRequest = {}): Promise<DevelopmentChange> {
    return this.store.withRepositoryLock(async () => {
      const workflow = workflowOf(await this.store.load());
      const change = workflow.changes.find((row) => row.id === id);
      if (!change) throw notFound('任务不存在', 'unknown_change');
      // Duplicate clicks and retries share the original allocation.
      if (change.status === 'working') return change;
      if (change.status !== 'planned') fail('只能开始计划中的任务，请先恢复已归档的计划', 'change_not_planned');
      if (change.developmentBranch !== workflow.developmentBranch) fail('请先切换到任务所属的需求', 'requirement_changed');
      return this.startTask(change, request, workflow);
    });
  }

  private async startTask(plan: PlannedChange, request: StartChangeRequest, workflow: DevelopmentWorkflow): Promise<DevelopmentChange> {
    if (request.kind !== undefined && request.kind !== 'clone' && request.kind !== 'worktree') throw badRequest('invalid checkout kind');
    if (request.agent !== undefined && (typeof request.agent !== 'string' || request.agent.trim().length > 100))
      throw badRequest('执行者名称不能超过 100 字', 'invalid_agent');
    const base = await this.taskBaseline(workflow);
    const list = await listWorktreesDetailed(this.repo);
    let worktree: string;
    let branch: string;
    let fork = base;
    let hookEvent: 'create' | 'reuse' | undefined;
    if (request.worktree) {
      const checkout = list.find((row) => row.path === request.worktree);
      if (!checkout || checkout.slot === undefined || checkout.prunable || checkout.foreign || !checkout.branch)
        throw badRequest('只能接管本仓库中已有分支的编号工位', 'invalid_change_checkout');
      if (checkout.branch === workflow.developmentBranch || workflow.changes.some((row) => active(row) && row.worktree === checkout.path))
        fail('这个工位已属于主开发分支或另一项任务', 'checkout_in_use');
      worktree = checkout.path;
      branch = checkout.branch;
      await this.importCommit(this.repo.commonRoot, worktree, base);
      fork = (await runGit(['merge-base', base, 'HEAD'], { cwd: worktree })).stdout.trim();
    } else {
      branch = `warden/change-${plan.id.replace(/^todo-/, '').slice(0, 8)}`;
      const kind = request.kind ?? 'clone';
      const free = list.find(
        (row) => row.free && !!row.clone === (kind === 'clone') && !workflow.changes.some((change) => active(change) && change.worktree === row.path),
      );
      const slot = free?.slot ?? (await nextSlot(this.repo, list)).slot;
      if (free?.clone) await this.importCommit(this.repo.commonRoot, free.path, base);
      const created = await checkoutWorktree(this.repo, { branch, base, slot, kind });
      worktree = created.worktree.path;
      hookEvent = created.reused ? 'reuse' : 'create';
      await this.store.update((state) => forgetWorktreeTargets(state, worktree));
    }
    const change: DevelopmentChange = { ...plan, branch, worktree, base: fork, status: 'working', agent: request.agent?.trim() || undefined };
    if (fork !== base) change.sync = { status: 'pending', target: base, message: '主开发分支已更新，可主动同步工作区' };
    await this.save(change);
    if (hookEvent) await this.runHook(change, hookEvent);
    return change;
  }

  private async runHook(change: DevelopmentChange, event: 'create' | 'reuse') {
    const command = (await this.store.load()).workspaceConfig?.hooks[event];
    if (!command) return;
    change.workspaceHook = { event, command, status: 'running' };
    await this.save(change);
    change.workspaceHook = await runWorkspaceHook(this.repo.commonRoot, change, event, command);
    await this.save(change);
  }

  retryHook(id: string) {
    return this.store.withRepositoryLock(async () => {
      const change = changeOf(await this.store.load(), id);
      if (change.status === 'integrating' || change.status === 'accepted') fail('此任务不能运行工作区 hook', 'change_closed');
      await this.checkout(change);
      await this.runHook(change, change.workspaceHook?.event ?? 'create');
      return change;
    });
  }

  /** Explicit operation, pinned to both heads. No lifecycle declaration is involved. */
  sync(id: string, sourceHead: string, developmentHead?: string) {
    return this.store.withRepositoryLock(() => this.syncLocked(id, sourceHead, developmentHead));
  }

  private async syncLocked(id: string, sourceHead: string, developmentHead?: string) {
    const state = await this.store.load();
    const change = changeOf(state, id);
    if (change.developmentBranch !== state.workflow!.developmentBranch) fail('请先切换到工作区所属的主开发分支', 'requirement_changed');
    const target = await this.developmentHead(change.developmentBranch);
    if (developmentHead && developmentHead !== target) fail('主开发分支已变化，请重新检查', 'review_changed');
    if (change.status === 'integrating' || change.status === 'accepted') fail('此工作区现在不能同步', 'change_closed');
    const checkout = await this.checkout(change);
    await this.assertClean(checkout.path);
    const before = await revParse(checkout.path, 'HEAD');
    if (before !== sourceHead) fail('工作区已有新提交，请重新检查', 'review_changed');
    const boundary = await deliveryBase(change, before, target);
    if (!(await this.ancestor(checkout.path, boundary, before))) fail('工作区历史已改变，请手动确认同步基点', 'base_changed');
    await this.importCommit(this.repo.commonRoot, checkout.path, target);
    // A completed rebase can outlive its state write. An explicit retry only repairs the
    // bookkeeping when the target is already an ancestor; it must not run hooks again.
    if (boundary !== target) {
      await this.assertRebaseIgnoredFiles(checkout.path, boundary, before, target);
      const backup = await createSafetyBackup(this.store, checkout.path, 'rebase');
      await this.checkout(change);
      await this.assertClean(checkout.path);
      if ((await revParse(checkout.path, 'HEAD')) !== before || (await this.developmentHead(change.developmentBranch)) !== target)
        fail('备份期间代码或主开发分支已变化，请重新检查', 'review_changed');
      await this.assertRebaseIgnoredFiles(checkout.path, boundary, before, target);
      await assertSafetyBackupCurrent(backup);
      change.rebaseBackups = [...(change.rebaseBackups ?? []), backup];
      await this.save(change);
      try {
        await runGitWrite(['-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', '--onto', target, boundary], {
          cwd: checkout.path,
          timeoutMs: LONG_GIT_TIMEOUT_MS,
        });
      } catch (error) {
        change.sync = { status: 'conflict', target, message: 'rebase 未完成，请在此工作区手动处理；已保留现场和操作前备份。' };
        await this.save(change);
        throw error;
      }
    }
    change.base = target;
    delete change.sourceBase;
    delete change.sync;
    change.status = 'working';
    change.submittedHead = await revParse(checkout.path, 'HEAD');
    await this.moveReview(change);
    delete change.submittedHead;
    await this.save(change);
    await retireWorkflowRefs(this.repo.commonRoot);
    if (change.rebaseBackups?.length) {
      for (const backup of change.rebaseBackups) await discardOperationBackup(this.store, backup);
      delete change.rebaseBackups;
      await this.save(change);
    }
    return change;
  }

  private async assertRebaseIgnoredFiles(cwd: string, boundary: string, source: string, target: string) {
    const ignored = (await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd })).stdout.split('\0').filter(Boolean);
    if (!ignored.length) return;
    const [tracked, replayed, casing] = await Promise.all([
      runGit(['ls-files', '--cached', `--with-tree=${target}`, '-z'], { cwd }),
      runGit(['log', '--format=', '--name-only', '--no-renames', '-z', `${boundary}..${source}`, '--'], { cwd }),
      runGit(['config', '--get', 'core.ignorecase'], { cwd, okCodes: [0, 1] }),
    ]);
    // Git detects the checkout filesystem, which can ignore case on macOS or mounted
    // volumes as well as Windows. Match its setting rather than guessing from the OS.
    const value = casing.stdout.trim().toLowerCase();
    const ignoreCase = (casing.code === 0 && value === '') || ['true', 'yes', 'on'].includes(value) || (/^-?\d+$/.test(value) && Number(value) !== 0);
    const normalized = (file: string) => (ignoreCase ? file.toLowerCase() : file);
    const paths = new Set((tracked.stdout + replayed.stdout).split('\0').filter(Boolean).map(normalized));
    const parents = new Set<string>();
    for (const file of paths) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join('/'));
    }
    const collisions = ignored.filter((file) => {
      const name = normalized(file);
      if (paths.has(name) || parents.has(name)) return true;
      const parts = name.split('/');
      return parts.some((_part, i) => i > 0 && paths.has(parts.slice(0, i).join('/')));
    });
    // Git considers ignored files disposable during rebase's checkout, even with a clean
    // status. Include intermediate replay paths and file/directory collisions as well.
    if (collisions.length) fail(`同步可能覆盖被 Git 忽略的本地文件，请先移走或保存：${collisions.slice(0, 10).join('、')}`, 'rebase_ignored_collision');
  }

  async rebaseChecks() {
    const state = await this.store.load();
    const workflow = workflowOf(state);
    const target = await this.developmentHead(workflow.developmentBranch);
    const checks: RebaseCheck[] = [];
    const workspaces = workflow.changes.filter(
      (row): row is DevelopmentChange => !!row.worktree && row.status !== 'accepted' && row.developmentBranch === workflow.developmentBranch,
    );
    const checkouts = workspaces.length ? this.listCheckouts() : undefined;
    let context: Promise<string | undefined> | undefined;
    const cachedChecks: { key: string; check: RebaseCheck }[] = [];
    for (const row of workspaces) {
      const check: RebaseCheck = { changeId: row.id, sourceHead: '', developmentHead: target, status: 'unknown', checkedAt: new Date().toISOString() };
      checks.push(check);
      try {
        const checkout = await this.checkout(row, checkouts);
        const source = await readWorktreeState(checkout.path);
        if (source.branch !== row.branch) fail('工位已切换分支，请恢复任务分支后重试', 'change_branch_moved');
        if (!source.head) fail('工作区分支尚无提交', 'invalid_change_checkout');
        check.sourceHead = source.head;
        if (row.status === 'integrating' || source.dirtyCount) {
          check.status = 'blocked';
          check.message = '工作区有未提交改动或正在准备交付';
          continue;
        }
        const boundary = await deliveryBase(row, check.sourceHead, target);
        if (boundary === target) {
          // This ancestry result is computed from this request's fresh source read. It does
          // not reuse an isolated verdict; actual synchronization has its own mutation guards.
          check.status = 'current';
          continue;
        }
        if (!(await this.ancestor(checkout.path, boundary, check.sourceHead))) {
          check.status = 'blocked';
          check.message = '工作区历史已改变，请手动确认同步基点';
          continue;
        }
        context ??= this.rebaseContext();
        const sandboxContext = await context;
        const inputs = sandboxContext ? await this.rebaseInputs(checkout.path) : undefined;
        const key = inputs
          ? digest([
              sandboxContext,
              row.id,
              row.worktree,
              row.branch,
              row.developmentBranch,
              row.base,
              row.sourceBase,
              checkout.clone,
              check.sourceHead,
              target,
              boundary,
              inputs.fingerprint,
            ])
          : undefined;
        if (key) cachedChecks.push({ key, check });
        Object.assign(check, structuredClone(await this.rebaseTrial(key, checkout.path, check.sourceHead, target, boundary)));
        await this.validateRebaseCheck(row, checkout, check);
        if (inputs && (await this.rebaseInputs(checkout.path, inputs))?.fingerprint !== inputs.fingerprint) this.changedRebaseCheck(check);
      } catch (error) {
        check.status = 'blocked';
        check.message = errorMessage(error);
        delete check.files;
      }
    }
    for (const { key, check } of cachedChecks) if (check.status !== 'ready' && check.status !== 'conflict') this.rebaseTrials.delete(key);
    // All trials in this request inherit the same global/system configuration. Recheck it
    // once after replay, including cache hits, rather than probing it for every workspace.
    if (cachedChecks.length && (await context) !== (await this.rebaseContext())) {
      for (const { key, check } of cachedChecks) {
        this.rebaseTrials.delete(key);
        if (check.status === 'ready' || check.status === 'conflict') this.changedRebaseCheck(check);
      }
    }
    return { checks };
  }

  private changedRebaseCheck(check: RebaseCheck) {
    check.status = 'unknown';
    check.message = '检查期间代码已变化，请刷新';
    delete check.files;
  }

  private async validateRebaseCheck(change: DevelopmentChange, checkout: WorktreeDetail, check: RebaseCheck) {
    const [source, state, target] = await finishReads([
      readWorktreeState(checkout.path),
      checkoutState(this.repo, checkout),
      this.developmentHead(change.developmentBranch),
    ]);
    if (state.foreign) fail('任务工位已不存在或不再属于本仓库', 'invalid_change_checkout');
    if (source.branch !== change.branch) fail('工位已切换分支，请恢复任务分支后重试', 'change_branch_moved');
    if (state.busy) fail(`工位中有未完成的 ${state.busy}，请先处理`, 'operation_in_progress');
    if (source.head !== check.sourceHead || source.dirtyCount || target !== check.developmentHead) this.changedRebaseCheck(check);
  }

  private async rebaseContext(): Promise<string | undefined> {
    try {
      const cwd = path.dirname(this.store.file);
      const variables = Object.entries(gitEnvironment());
      // These paths would resolve differently in the parent directory and a generated
      // sandbox. Their effective config cannot be inferred safely from the parent probe.
      if (variables.some(([name, value]) => configLocationVariables.has(name.toUpperCase()) && value !== undefined && !path.isAbsolute(value)))
        return undefined;
      const environment = digest(variables.sort(([a], [b]) => a.localeCompare(b)));
      const [repository, config] = await finishReads([
        runGit(['rev-parse', '--absolute-git-dir'], { cwd, okCodes: [0, 128] }),
        runGit(['config', '--get-regexp', '.'], { cwd, okCodes: [0, 1] }),
      ]);
      // Generated sandboxes have their own local config. Outside a repository, their parent
      // sees exactly the global/system config they inherit, unless conditional includes apply.
      if (repository.code === 0 || !repository.stderr.includes('not a git repository') || opaqueRebaseConfig.test(config.stdout)) return undefined;
      if (this.attributePaths?.environment !== environment) {
        const paths = finishReads([runGit(['var', 'GIT_ATTR_GLOBAL'], { cwd }), runGit(['var', 'GIT_ATTR_SYSTEM'], { cwd, okCodes: [0, 1] })])
          .then(([global, system]) => {
            // Git reports no system path with exit 1 when GIT_ATTR_NOSYSTEM disables it.
            // Require a successful global lookup so older Git without these variables still
            // declines reuse; Git itself interprets the environment's boolean semantics.
            if (system.code === 1 && (system.stdout.trim() || system.stderr.trim())) return undefined;
            return [global.stdout.trim(), ...(system.code === 0 ? [system.stdout.trim()] : [])];
          })
          .catch(() => undefined);
        this.attributePaths = { environment, paths };
      }
      const attributes = await this.attributePaths.paths;
      if (!attributes) {
        if (this.attributePaths?.environment === environment) this.attributePaths = undefined;
        return undefined;
      }
      if (attributes.some((file) => !path.isAbsolute(file)) || (await finishReads(attributes.map(fileExists))).some(Boolean)) return undefined;
      if (environment !== digest(Object.entries(gitEnvironment()).sort(([a], [b]) => a.localeCompare(b)))) return undefined;
      return digest([environment, config.stdout, attributes]);
    } catch {
      // Older Git versions may not expose attribute paths. Unsupported or unreadable inputs
      // only disable reuse; the normal isolated check must still remain available.
      return undefined;
    }
  }

  private async rebaseInputs(cwd: string, previous?: RebaseInputs): Promise<RebaseInputs | undefined> {
    try {
      const locations = previous ? undefined : (await runGit(['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd })).stdout.trim().split('\n');
      const commonDirectory = previous?.commonDirectory ?? path.resolve(cwd, locations![1]!);
      const paths = previous?.paths ?? [
        this.repo.commonRoot,
        path.join(this.repo.commonRoot, '.git'),
        cwd,
        path.join(cwd, '.git'),
        locations![0]!,
        commonDirectory,
      ];
      const [config, identity, unusualGraph, packed] = await finishReads([
        runGit(['config', '--get-regexp', '.'], { cwd, okCodes: [0, 1] }),
        repositoryIdentity(paths),
        finishReads(['shallow', 'info/grafts', 'refs/replace', 'objects/info/alternates'].map((file) => fileExists(path.join(commonDirectory, file)))),
        readFile(path.join(commonDirectory, 'packed-refs'), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        }),
      ]);
      if (
        opaqueRebaseConfig.test(config.stdout) ||
        /^extensions\.refstorage reftable$/im.test(config.stdout) ||
        unusualGraph.some(Boolean) ||
        / refs\/replace\//.test(packed)
      )
        return undefined;
      return { paths, commonDirectory, fingerprint: digest([config.stdout, identity]) };
    } catch {
      return undefined;
    }
  }

  private async rebaseTrial(key: string | undefined, source: string, head: string, target: string, boundary: string): Promise<RebaseVerdict> {
    const cached = key ? this.rebaseTrials.get(key) : undefined;
    if (cached) {
      this.rebaseTrials.delete(key!);
      this.rebaseTrials.set(key!, cached);
      return cached;
    }
    const trial = (async (): Promise<RebaseVerdict> => {
      const sandbox = await GitSandbox.create(this.store, source, head);
      try {
        await sandbox.fetch(this.repo.commonRoot, target);
        try {
          await sandbox.write(['rebase', '--no-autostash', '--onto', target, boundary]);
          return { status: 'ready' };
        } catch (error) {
          const files = await sandbox.conflicts();
          return { status: files.length ? 'conflict' : 'unknown', files, message: errorMessage(error) };
        }
      } finally {
        await sandbox.dispose();
      }
    })();
    if (key) {
      this.rebaseTrials.set(key, trial);
      // Eviction bounds retained entries, not active HTTP requests. An evicted trial still
      // runs to completion for its callers; sharing is best-effort within this capacity.
      while (this.rebaseTrials.size > REBASE_CACHE_LIMIT) this.rebaseTrials.delete(this.rebaseTrials.keys().next().value!);
    }
    try {
      const result = await trial;
      if (key && this.rebaseTrials.get(key) === trial && result.status !== 'ready' && result.status !== 'conflict') this.rebaseTrials.delete(key);
      return result;
    } catch (error) {
      if (key && this.rebaseTrials.get(key) === trial) this.rebaseTrials.delete(key);
      throw error;
    }
  }

  rebaseBatch(request: RebaseBatchRequest): Promise<RebaseBatchResponse> {
    if (
      !Array.isArray(request?.items) ||
      request.items.length > 100 ||
      request.items.some((i) => !i || typeof i.changeId !== 'string' || !gitOid(i.sourceHead) || !gitOid(i.developmentHead))
    )
      throw badRequest('同步请求格式错误');
    return this.store.withRepositoryLock(async () => {
      const results: RebaseBatchResponse['results'] = [];
      for (const item of request.items) {
        try {
          await this.syncLocked(item.changeId, item.sourceHead, item.developmentHead);
          results.push({ changeId: item.changeId, status: 'updated' });
        } catch (error) {
          results.push({ changeId: item.changeId, status: 'failed', message: errorMessage(error) });
        }
      }
      return { results };
    });
  }

  /** Compatibility for old CLI clients: capture a revision, never rebase or require readiness. */
  ready(id: string) {
    return this.store.withRepositoryLock(async () => {
      const change = changeOf(await this.store.load(), id);
      if (change.status === 'integrating' || change.status === 'accepted') fail('此工作区不能重复准备', 'change_closed');
      const checkout = await this.checkout(change);
      await this.assertClean(checkout.path);
      change.submittedHead = await revParse(checkout.path, 'HEAD');
      change.status = 'working';
      await this.save(change);
      return change;
    });
  }

  resume(id: string) {
    return this.store.withRepositoryLock(async () => {
      const change = changeOf(await this.store.load(), id);
      if (change.status === 'accepted') fail('任务已合入', 'change_closed');
      if (change.integration) {
        const target = await this.developmentHead(change.developmentBranch);
        if (target !== change.integration.parent) fail('主开发分支已有新提交，请先确认最终提交', 'change_closed');
        // Never discard test fixes or hook edits. The reviewer explicitly restores the development
        // checkout before returning the task to its agent.
        await this.destination(change.developmentBranch, true, change.integration.worktree);
        delete change.integration;
      }
      change.status = 'working';
      delete change.submittedHead;
      await this.save(change);
      await new PreviewService(this.repo, this.store).resume();
      return change;
    });
  }

  private async listCheckouts() {
    return new Map((await listWorktreesDetailed(this.repo)).map((row) => [row.path, row]));
  }

  private async checkout(change: DevelopmentChange, checkouts = this.listCheckouts()): Promise<WorktreeDetail> {
    const checkout = (await checkouts).get(change.worktree);
    if (!checkout || checkout.slot === undefined || checkout.prunable || checkout.foreign) fail('任务工位已不存在或不再属于本仓库', 'invalid_change_checkout');
    if (checkout.branch !== change.branch) fail('工位已切换分支，请恢复任务分支后重试', 'change_branch_moved');
    if (checkout.busy) fail(`工位中有未完成的 ${checkout.busy}，请先处理`, 'operation_in_progress');
    return checkout;
  }

  private async assertClean(cwd: string) {
    if (await dirtyCount(cwd)) fail('请先提交工作区改动，再刷新审查后合入', 'worktree_dirty');
  }

  private async importCommit(from: string, into: string, sha: string) {
    if (await refExists(into, sha)) return;
    // Only local repositories validated from the checkout listing; no remote ref is updated.
    await runGitWrite(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', from, sha], { cwd: into });
  }

  private async ancestor(cwd: string, base: string, head: string) {
    return (await runGit(['merge-base', '--is-ancestor', base, head], { cwd, okCodes: [0, 1] })).code === 0;
  }

  private async moveReview(change: DevelopmentChange) {
    const next = formatTargetKey({ kind: 'range', base: change.base, head: change.submittedHead!, worktree: change.worktree });
    const local = commentScopeKey(formatTargetKey({ kind: 'working', worktree: change.worktree }));
    await this.store.update((state) => {
      const target = ensureTarget(state, next);
      const ids = new Set(target.comments.map((comment) => comment.id));
      for (const [key, value] of Object.entries(state.targets)) {
        if (key === next || (key !== local && tryParseTargetKey(key)?.worktree !== change.worktree)) continue;
        // A new handoff changes the review revision, but not the conversation. The normal
        // reanchoring endpoint relocates these comments against the newly selected diff.
        for (const comment of value.comments) {
          if (!ids.has(comment.id)) {
            target.comments.push({ ...comment, targetKey: next });
            ids.add(comment.id);
          }
        }
        value.comments = [];
        value.viewed = {};
      }
    });
  }

  /** Never switch the user's checkout or silently publish a branch that cannot be tested there. */
  private async destination(branch: string, clean = false, expectedPath?: string) {
    const checkout = (await listWorktreesAll(this.repo)).find((row) => !row.clone && row.branch === branch);
    if (!checkout || checkout.prunable) fail('请先在本仓库的工作区检出主开发分支，再准备验证', 'development_checkout_missing');
    if (expectedPath && checkout.path !== expectedPath) fail('主开发分支的工作目录已改变，请恢复原工作目录', 'development_checkout_moved');
    const state = await checkoutState(this.repo, checkout);
    if (state.foreign || state.busy) fail('主开发分支的工作区不可写或有未完成的 Git 操作', 'development_busy');
    if (clean && (await dirtyCount(checkout.path))) fail('主开发分支有未提交改动，请先保存或处理后再继续', 'development_dirty');
    return checkout;
  }

  private async indexState(cwd: string) {
    const [diff, unstaged, untracked] = await Promise.all([
      runGit(['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { cwd }),
      runGit(['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--'], { cwd, okCodes: [0, 1] }),
      runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }),
    ]);
    return {
      fingerprint: createHash('sha256').update(diff.stdout).digest('hex'),
      staged: !!diff.stdout,
      unstaged: unstaged.code !== 0 || !!untracked.stdout,
    };
  }

  private async singleCommit(change: DevelopmentChange, head: string) {
    const parents = (await runGit(['rev-list', '--parents', '-n', '1', head], { cwd: this.repo.commonRoot })).stdout.trim().split(/\s+/);
    return parents.length === 2 && parents[1] === change.integration!.parent;
  }

  private async inspect(change: DevelopmentChange): Promise<DevelopmentPreparation> {
    const result: DevelopmentPreparation = { changeId: change.id, worktree: change.integration?.worktree, state: 'blocked' };
    try {
      const integration = change.integration;
      if (!integration) fail('准备记录缺失，请检查任务状态', 'integration_missing');
      const destination = await this.destination(change.developmentBranch, false, integration.worktree);
      result.worktree = destination.path;
      result.head = await this.developmentHead(change.developmentBranch);
      if (result.head !== integration.parent) {
        if (!(await this.singleCommit(change, result.head)))
          fail('主开发分支历史已变化；请将本次改动整理为基于原主开发分支的单个提交后确认', 'development_history_changed');
        result.state = 'committed';
        result.canRecord = (await dirtyCount(destination.path)) === 0;
        result.changed =
          (await revParse(destination.path, 'HEAD^{tree}')) !== (integration.tree ?? (await revParse(change.worktree, `${integration.source}^{tree}`)));
        if (!result.canRecord) result.message = '提交已创建，但主开发分支还有未提交改动；请处理后再确认。';
      } else if (!integration.prepared) {
        result.message = '准备过程尚未完成，请重试准备；已有文件会保留。';
      } else {
        const index = await this.indexState(destination.path);
        result.state = 'testing';
        result.indexFingerprint = index.fingerprint;
        result.canCommit = index.staged && !index.unstaged;
        if (index.unstaged) result.message = '主开发分支有未暂存或未跟踪文件，请检查并暂存验证时的修改。';
        else if (!index.staged) result.message = '暂存区为空，请恢复待提交的改动，或撤回任务继续开发。';
      }
    } catch (error) {
      result.state = 'blocked';
      result.message = errorMessage(error);
    }
    return result;
  }

  prepare(id: string, request: PrepareChangeRequest) {
    return this.store.withRepositoryLock(async () => {
      const state = await this.store.load();
      const workflow = workflowOf(state);
      const change = changeOf(state, id);
      if (change.developmentBranch !== workflow.developmentBranch) fail('请先切换到工作区所属的主开发分支', 'requirement_changed');
      if (workflow.changes.some((row) => row.id !== id && row.status === 'integrating')) fail('请先完成主目录上正在准备的提交', 'development_in_use');
      if (change.integration?.prepared) return change;
      if (change.status === 'accepted') fail('旧版本交付记录不可再次提交', 'change_closed');
      const target = await this.developmentHead(change.developmentBranch);
      const checkout = await this.checkout(change);
      await this.assertClean(checkout.path);
      const source = await revParse(checkout.path, 'HEAD');
      if (source !== request?.sourceHead || target !== request?.developmentHead) fail('代码或主开发分支已变化，请刷新后重新审查', 'review_changed');
      const boundary = await deliveryBase(change, source, target);
      if (!(await this.ancestor(checkout.path, boundary, source))) fail('工作区历史已变化，请先手动处理同步基点', 'base_changed');
      const preview = new PreviewService(this.repo, this.store);
      const sandbox = await GitSandbox.create(this.store, this.repo.commonRoot, target);
      try {
        await sandbox.fetch(checkout.path, source);
        try {
          await applyPatch(sandbox.path, await patchBetween(checkout.path, boundary, source), true, true);
        } catch (error) {
          fail(`合入存在冲突，请先在工作区处理：${(await sandbox.conflicts()).join('、') || errorMessage(error)}`, 'delivery_conflict');
        }
        const composed = await sandbox.commit();
        const tree = await oid(sandbox.path, 'HEAD^{tree}');
        const patch = await patchBetween(sandbox.path, target, composed);
        if (!patch) fail('工作区没有尚未交付的改动', 'empty_change');
        await preview.suspend();
        const destination = await this.destination(change.developmentBranch, !change.integration, change.integration?.worktree);
        if (change.integration && (await dirtyCount(destination.path))) {
          const index = await this.indexState(destination.path);
          // Compare index entries without importing the trial commit or its history into the
          // primary repository. NUL-delimited raw diffs also ignore display-only diff settings.
          const flags = ['--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '-z'];
          const [staged, expected] = await finishReads([
            runGit(['diff', '--cached', ...flags, target, '--'], { cwd: destination.path }),
            runGit(['diff', ...flags, target, composed, '--'], { cwd: sandbox.path }),
          ]);
          if (index.unstaged || staged.stdout !== expected.stdout) fail('准备被中断，主目录有其他改动，请手动处理后重试', 'development_dirty');
        } else {
          change.integration = { id: randomUUID(), source, sourceBase: boundary, tree, parent: target, worktree: destination.path, message: change.title };
          change.status = 'integrating';
          await this.save(change);
          await this.destination(change.developmentBranch, true, destination.path);
          if ((await this.developmentHead(change.developmentBranch)) !== target) fail('主开发分支已变化，请刷新后重试', 'review_changed');
          await applyPatch(destination.path, patch, true);
        }
        change.integration!.prepared = true;
        delete change.integration!.error;
        await this.save(change);
        return change;
      } catch (error) {
        if (change.integration) {
          change.integration.error = errorMessage(error);
          await this.save(change);
        } else await preview.resume();
        throw error;
      } finally {
        await sandbox.dispose();
      }
    });
  }

  /** The reviewer validates the development checkout before either committing or recording a manual commit. */
  accept(id: string, request: AcceptChangeRequest) {
    return this.store.withRepositoryLock(async () => {
      const change = changeOf(await this.store.load(), id);
      if (!change.integration && change.deliveries?.length) {
        const last = change.deliveries.at(-1)!;
        if ((request?.mode === 'record' && request.commit === last.commit) || (request?.mode === 'commit' && request.developmentHead === last.parent)) {
          await retireWorkflowRefs(this.repo.commonRoot);
          await new PreviewService(this.repo, this.store).resume().catch(() => {});
          return change;
        }
      }
      const integration = change.integration;
      if (change.status !== 'integrating' || !integration) fail('请先将改动准备到主开发分支并验证', 'change_not_prepared');
      const destination = await this.destination(change.developmentBranch, false, integration.worktree);
      let head = await this.developmentHead(change.developmentBranch);
      if (request?.mode === 'commit') {
        if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 10000)
          throw badRequest('请填写提交信息', 'invalid_commit_message');
        // A retry after publication must never run commit a second time. The recorded SHA is
        // evidence of our successful command; unrecorded manual commits need explicit review.
        if (head !== integration.commit) {
          if (!integration.prepared || head !== integration.parent || head !== request.developmentHead)
            fail('主开发分支已有变化，请查看最新状态；已有提交需审查后确认', 'review_changed');
          const index = await this.indexState(destination.path);
          if (index.unstaged) fail('请先检查并暂存主开发分支上的所有修改，再验证和提交', 'development_unstaged');
          if (!index.staged) fail('主开发分支暂存区为空', 'empty_change');
          if (index.fingerprint !== request.indexFingerprint) fail('暂存内容已变化，请刷新并重新验证', 'review_changed');
          integration.message = request.message.trim();
          delete integration.error;
          await this.save(change);
          try {
            // Ordinary commit, in the actual development checkout: local hooks, identity,
            // signing and hook edits all follow Git's normal behavior. Never --no-verify.
            await runGitWrite(['commit', '-m', integration.message], { cwd: destination.path, timeoutMs: LONG_GIT_TIMEOUT_MS });
          } catch (error) {
            integration.error = (error instanceof GitError ? error.stderr.trim() || error.message : errorMessage(error)).slice(0, 8000);
            await this.save(change);
            fail(`提交未完成，已保留改动，请处理后重新验证。${integration.error}`, 'commit_failed');
          }
          head = await this.developmentHead(change.developmentBranch);
          integration.commit = head;
          await this.save(change);
        }
      } else if (request?.mode === 'record') {
        if (request.commit !== head) fail('提交已变化，请打开最新提交重新确认', 'review_changed');
      } else throw badRequest('请选择验证后提交或确认已有提交', 'invalid_accept_mode');
      if (!(await this.singleCommit(change, head))) fail('请将本次改动整理为基于原主开发分支的单个提交后确认', 'development_history_changed');
      await this.destination(change.developmentBranch, true, destination.path);
      integration.commit = head;
      integration.message = (await runGit(['log', '-1', '--format=%B', head], { cwd: destination.path })).stdout.trim();
      delete integration.error;
      integration.id ??= randomUUID();
      await this.save(change);
      await this.recordAccepted(change);
      await retireWorkflowRefs(this.repo.commonRoot);
      await new PreviewService(this.repo, this.store).resume().catch(() => {});
      return change;
    });
  }

  private async recordAccepted(change: DevelopmentChange) {
    const integration = change.integration!;
    await this.store.update((state) => {
      const comments = Object.values(state.targets)
        .flatMap((target) => target.comments)
        .filter((comment) => commentWorktree(comment) === change.worktree);
      const key = formatTargetKey({ kind: 'commit', sha: integration.commit! });
      const target = ensureTarget(state, key);
      const ids = new Set(target.comments.map((comment) => comment.id));
      for (const comment of comments) if (!ids.has(comment.id)) target.comments.push({ ...structuredClone(comment), targetKey: key });
      const local = commentScopeKey(formatTargetKey({ kind: 'working', worktree: change.worktree }));
      for (const [oldKey, previous] of Object.entries(state.targets)) {
        if (oldKey === local || tryParseTargetKey(oldKey)?.worktree === change.worktree) {
          previous.comments = [];
          previous.viewed = {};
        }
      }
      change.deliveries ??= [];
      if (!change.deliveries.some((d) => d.commit === integration.commit))
        change.deliveries.push({
          id: integration.id ?? randomUUID(),
          source: integration.source,
          sourceBase: integration.sourceBase ?? change.base,
          parent: integration.parent,
          commit: integration.commit!,
          message: integration.message,
          createdAt: new Date().toISOString(),
          review: structuredClone(comments),
        });
      change.sourceBase = integration.source;
      change.status = 'working';
      delete change.submittedHead;
      delete change.integration;
      delete change.cleanupError;
      const index = workflowOf(state).changes.findIndex((row) => row.id === change.id);
      state.workflow!.changes[index] = change;
      for (const row of state.workflow!.changes) {
        if (row.worktree && row.status !== 'accepted' && row.developmentBranch === change.developmentBranch)
          row.sync = { status: 'pending', target: integration.commit!, message: '主开发分支已更新，可主动检查并同步工作区' };
      }
    });
  }
}
