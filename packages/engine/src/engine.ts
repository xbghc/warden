import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  AcceptChangeRequest,
  CreateChangeRequest,
  DeliverChangeRequest,
  FilesResponse,
  FullFileResponse,
  HistoryPreviewRequest,
  PrepareChangeRequest,
  RebaseBatchRequest,
  StartChangeRequest,
  UpdateChangeRequest,
  WorkspaceConfig,
  WorktreesResponse,
} from '@warden/shared';
import { WardenError, badRequest } from './errors.js';
import { resolveRepo, listWorktreesAll, remoteDefault, type RepoContext } from './repo.js';
import { StateStore, stateFilePath } from './state.js';
import { listBranches, listWorktreesDetailed, nextSlot } from './worktrees.js';
import { getFullFile, listTargetDiffs, resolveTargetContext, toSummary } from './targets.js';
import { WorkflowService } from './workflow.js';
import { PreviewService } from './preview.js';
import { HistoryService } from './history.js';
import { workspaceConfig } from './workspace.js';
import { RepoWatcher } from './watcher.js';

/** The desktop product has no adoption operation: allocation always creates a new logical workspace. */
type NewWorkspace = Pick<StartChangeRequest, 'agent'> & { kind?: 'shared' | 'clone' };
type NewTask = Pick<CreateChangeRequest, 'title' | 'body'>;

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('操作参数格式错误', 'invalid_request');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 300) throw badRequest('任务标识无效', 'invalid_request');
}

function commands(repo: RepoContext, store: StateStore) {
  const workflow = new WorkflowService(repo, store);
  const preview = new PreviewService(repo, store);
  const history = new HistoryService(repo, store);
  const target = async (key: string) => {
    if (typeof key !== 'string' || !key || key.length > 16000) throw badRequest('审阅目标无效', 'invalid_request');
    return resolveTargetContext(repo, await listWorktreesAll(repo), key);
  };
  return {
    previewService: preview,
    handlers: {
      'workflow.get': () => workflow.get(),
      'workflow.context': async () => ({ developmentBranch: (await store.load()).workflow?.developmentBranch }),
      'workflow.configure': ({ branch }: { branch: string }) => workflow.configure(branch),
      'task.create': (request: NewTask) => {
        record(request);
        if ('worktree' in request) throw badRequest('创建任务不能接管旧工作区', 'invalid_request');
        return workflow.create({ title: request.title, body: request.body });
      },
      'task.update': ({ taskId, ...request }: UpdateChangeRequest & { taskId: string }) => {
        id(taskId);
        return workflow.update(taskId, request);
      },
      'task.start': ({ taskId, ...request }: NewWorkspace & { taskId: string }) => {
        id(taskId);
        if ('worktree' in request || (request.kind !== undefined && request.kind !== 'shared' && request.kind !== 'clone'))
          throw badRequest('请创建新工作区，目录分配由 Warden 管理', 'invalid_request');
        return workflow.start(taskId, { kind: request.kind, agent: request.agent });
      },
      'task.move': ({ taskId, before }: { taskId: string; before: string | null }) => {
        id(taskId);
        return workflow.move(taskId, before);
      },
      'task.import': ({ taskId }: { taskId: string }) => {
        id(taskId);
        return workflow.importTodo(taskId);
      },
      'task.hook': ({ taskId }: { taskId: string }) => {
        id(taskId);
        return workflow.retryHook(taskId);
      },
      'task.resume': ({ taskId }: { taskId: string }) => {
        id(taskId);
        return workflow.resume(taskId);
      },
      'task.prepare': ({ taskId, ...request }: PrepareChangeRequest & { taskId: string }) => {
        id(taskId);
        return workflow.prepare(taskId, request);
      },
      'task.deliver': ({ taskId, ...request }: DeliverChangeRequest & { taskId: string }) => {
        id(taskId);
        return workflow.deliver(taskId, request);
      },
      'task.accept': ({ taskId, ...request }: AcceptChangeRequest & { taskId: string }) => {
        id(taskId);
        return workflow.accept(taskId, request);
      },
      'preview.get': () => preview.get(),
      'preview.connect': ({ connectedIds }: { connectedIds: string[] }) => preview.set(connectedIds),
      'preview.refresh': () => preview.refresh(),
      'preview.setup': () => preview.setup(),
      'rebase.check': () => workflow.rebaseChecks(),
      'rebase.run': (request: RebaseBatchRequest) => workflow.rebaseBatch(request),
      'history.get': () => history.get(),
      'history.preview': (request: HistoryPreviewRequest) => history.preview(request),
      'history.apply': (request: { id: string; head: string }) => history.apply(request),
      'config.save': async (request: WorkspaceConfig) => {
        const config = workspaceConfig(request);
        await store.withRepositoryLock(() =>
          store.update((state) => {
            state.workspaceConfig = config;
          }),
        );
        return config;
      },
      'workspaces.list': async (): Promise<WorktreesResponse> => {
        const [list, state] = await Promise.all([listWorktreesDetailed(repo), store.load()]);
        const [branches, newSlot, trunk] = await Promise.all([
          listBranches(repo, list),
          nextSlot(repo, list),
          remoteDefault(repo.commonRoot).catch(() => undefined),
        ]);
        return { worktrees: list, branches, newSlot, slotKind: state.prefs.slotKind ?? 'shared', trunk };
      },
      'review.files': async ({ key }: { key: string }): Promise<FilesResponse> => {
        const context = await target(key);
        return { targetKey: key, root: context.cwd, files: (await listTargetDiffs(context)).map(toSummary) };
      },
      'review.file': async ({ key, file, side }: { key: string; file: string; side: 'old' | 'new' }): Promise<FullFileResponse> => {
        if (typeof file !== 'string' || (side !== 'old' && side !== 'new')) throw badRequest('文件参数无效', 'invalid_request');
        return { path: file, side, content: await getFullFile(await target(key), file, side) };
      },
    },
  };
}

export type EngineCommands = ReturnType<typeof commands>['handlers'];
export type EngineCommand = keyof EngineCommands;
export type EngineInput<K extends EngineCommand> = Parameters<EngineCommands[K]> extends [] ? undefined : Parameters<EngineCommands[K]>[0];
export type EngineOutput<K extends EngineCommand> = Awaited<ReturnType<EngineCommands[K]>>;
const reads = new Set<EngineCommand>([
  'workflow.get',
  'workflow.context',
  'preview.get',
  'history.get',
  'workspaces.list',
  'review.files',
  'review.file',
  'rebase.check',
]);

/** Owns repository activity independently of the editor, webviews, and transport adapters. */
export class Engine {
  readonly root: string;
  private readonly handlers: EngineCommands;
  private readonly preview: PreviewService;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly watchers = new Map<string, RepoWatcher>();
  private stateWatcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private notification?: ReturnType<typeof setTimeout>;
  private lease?: { release(): Promise<void> };
  private ticking?: Promise<void>;
  private notifying?: Promise<void>;
  private notifyAgain = false;
  private stopped = false;
  private closing?: Promise<void>;
  private onUpdate?: () => Promise<void>;
  private onError: (error: unknown) => void = () => {};
  private lastFallback = 0;

  private constructor(
    readonly repo: RepoContext,
    readonly store: StateStore,
  ) {
    this.root = repo.commonRoot;
    const service = commands(repo, store);
    this.handlers = service.handlers;
    this.preview = service.previewService;
  }
  static async open(directory: string, file?: string) {
    const repo = await resolveRepo(directory);
    return new Engine(repo, new StateStore(file ?? stateFilePath(repo.commonRoot), repo.commonRoot));
  }
  execute<K extends EngineCommand>(command: K, request: EngineInput<K>, context?: { developmentBranch: string | null }): Promise<EngineOutput<K>> {
    if (this.stopped) return Promise.reject(new WardenError(409, '仓库会话已关闭', 'session_closed'));
    const operation = Promise.resolve().then(async () => {
      const handler = this.handlers[command];
      if (!Object.hasOwn(this.handlers, command)) throw badRequest('未知操作', 'unknown_command');
      if (!reads.has(command) && command !== 'preview.refresh' && command !== 'preview.setup') record(request);
      const invoke = () => (handler as (input: never) => Promise<unknown>)(request as never);
      const result = context && !reads.has(command) ? await this.store.withDevelopmentBranch(context.developmentBranch, invoke) : await invoke();
      if (command === 'workspaces.list') this.observe((result as WorktreesResponse).worktrees.map((row) => row.path));
      if (!reads.has(command)) this.changed();
      return result;
    });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation as Promise<EngineOutput<K>>;
  }
  private observe(roots: string[]) {
    if (!this.onUpdate || this.stopped) return;
    const desired = new Set([this.root, ...roots]);
    for (const [root, watcher] of this.watchers) {
      if (!desired.has(root)) {
        this.watchers.delete(root);
        void watcher.close().catch(this.onError);
      }
    }
    for (const root of desired) {
      if (this.watchers.has(root)) continue;
      const watcher = new RepoWatcher(root);
      watcher.subscribe(() => this.changed());
      this.watchers.set(root, watcher);
    }
  }
  private changed() {
    if (this.stopped || !this.onUpdate) return;
    if (this.notifying) {
      this.notifyAgain = true;
      return;
    }
    if (this.notification) return;
    this.notification = setTimeout(() => {
      this.notification = undefined;
      this.notifying = this.onUpdate!()
        .catch(this.onError)
        .finally(() => {
          this.notifying = undefined;
          if (this.notifyAgain) {
            this.notifyAgain = false;
            this.changed();
          }
        });
    }, 100);
  }
  async start(onUpdate: () => Promise<void>, onError: (error: unknown) => void) {
    if (this.timer || this.stopped) return;
    this.onUpdate = onUpdate;
    this.onError = onError;
    await mkdir(path.dirname(this.store.file), { recursive: true });
    if (this.stopped) return;
    this.stateWatcher = watch(path.dirname(this.store.file), (_event, filename) => {
      if (filename?.toString() === path.basename(this.store.file)) this.changed();
    });
    this.stateWatcher.on('error', onError);
    this.observe([this.root]);
    this.timer = setInterval(() => {
      if (!this.ticking)
        this.ticking = (async () => {
          this.lease ??= (await this.store.acquirePreviewLease()) ?? undefined;
          if (this.lease && !this.stopped) await this.preview.tick();
        })()
          .catch(onError)
          .finally(() => {
            this.ticking = undefined;
          });
      // Events are hints. Content-based preview checks and periodic reads cover missed events.
      if (Date.now() - this.lastFallback >= 5000) {
        this.lastFallback = Date.now();
        this.changed();
      }
    }, 1000);
    this.timer.unref();
    this.changed();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.notification);
    this.stateWatcher?.close();
    this.closing = (async () => {
      await Promise.allSettled([this.ticking, this.notifying, ...this.pending, ...[...this.watchers.values()].map((w) => w.close())]);
      await this.lease?.release();
    })();
    return this.closing;
  }
}
