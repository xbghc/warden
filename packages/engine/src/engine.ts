import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DiagnosticLog } from '@warden/shared';
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
  WorktreeDetail,
  WorkspaceConfig,
  WorktreesResponse,
} from '@warden/shared';
import { WardenError, badRequest } from './errors.js';
import { resolveRepo, listWorktreesAll, type RepoContext } from './repo.js';
import { StateStore, stateFilePath } from './state.js';
import { listBranches, listWorktreesDetailed } from './worktrees.js';
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Invalid operation parameters.', 'invalid_request');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 300) throw badRequest('Invalid task ID.', 'invalid_request');
}

function commands(repo: RepoContext, store: StateStore) {
  const workflow = new WorkflowService(repo, store);
  const preview = new PreviewService(repo, store);
  const history = new HistoryService(repo, store);
  const workspaces = async (inventory = listWorktreesDetailed(repo)): Promise<WorktreesResponse> => {
    const list = await inventory;
    return { worktrees: list, branches: await listBranches(repo, list) };
  };
  const target = async (key: string) => {
    if (typeof key !== 'string' || !key || key.length > 16000) throw badRequest('Invalid review target.', 'invalid_request');
    return resolveTargetContext(repo, await listWorktreesAll(repo), key);
  };
  return {
    previewService: preview,
    handlers: {
      'repository.get': async () => {
        // Share only this observation's inventory. Later reads and every mutation obtain
        // fresh checkout state, including changes made by tools outside Warden.
        const inventory: Promise<WorktreeDetail[]> = listWorktreesDetailed(repo);
        const results = await Promise.allSettled([workflow.get(inventory), preview.get(), workspaces(inventory)]);
        const [data, previewState, checkouts] = results;
        if (data.status === 'rejected') throw data.reason;
        if (previewState.status === 'rejected') throw previewState.reason;
        if (checkouts.status === 'rejected') throw checkouts.reason;
        return { workflow: data.value, preview: previewState.value, workspaces: checkouts.value };
      },
      'workflow.get': () => workflow.get(),
      'workflow.context': async () => ({ developmentBranch: (await store.load()).workflow?.developmentBranch }),
      'workflow.configure': ({ branch }: { branch: string }) => workflow.configure(branch),
      'task.create': (request: NewTask) => {
        record(request);
        if ('worktree' in request) throw badRequest('A new task cannot adopt an existing workspace.', 'invalid_request');
        return workflow.createTask({ title: request.title, body: request.body });
      },
      'task.update': ({ taskId, ...request }: UpdateChangeRequest & { taskId: string }) => {
        id(taskId);
        return workflow.update(taskId, request);
      },
      'task.start': ({ taskId, ...request }: NewWorkspace & { taskId: string }) => {
        id(taskId);
        if ('worktree' in request || (request.kind !== undefined && request.kind !== 'shared' && request.kind !== 'clone'))
          throw badRequest('Warden allocates workspaces automatically.', 'invalid_request');
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
      'config.save': async (request: WorkspaceConfig & { expected?: WorkspaceConfig }) => {
        const config = workspaceConfig(request);
        const expected = request.expected === undefined ? undefined : workspaceConfig(request.expected);
        await store.withRepositoryLock(() =>
          store.update((state) => {
            // Native script editors must not overwrite a configuration saved by another window.
            if (expected && JSON.stringify(workspaceConfig(state.workspaceConfig ?? { hooks: {} })) !== JSON.stringify(expected))
              throw new WardenError(
                409,
                'Script configuration changed in another window. Copy your draft, revert the editor, then reopen it from Settings.',
                'config_changed',
              );
            state.workspaceConfig = config;
          }),
        );
        return config;
      },
      'workspaces.list': () => workspaces(),
      'review.files': async ({ key }: { key: string }): Promise<FilesResponse> => {
        const context = await target(key);
        return { targetKey: key, root: context.cwd, files: (await listTargetDiffs(context)).map(toSummary) };
      },
      'review.file': async ({ key, file, side }: { key: string; file: string; side: 'old' | 'new' }): Promise<FullFileResponse> => {
        if (typeof file !== 'string' || (side !== 'old' && side !== 'new')) throw badRequest('Invalid file parameters.', 'invalid_request');
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
  'repository.get',
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
  private writers = 0;
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
    private readonly log: DiagnosticLog,
  ) {
    this.root = repo.commonRoot;
    const service = commands(repo, store);
    this.handlers = service.handlers;
    this.preview = service.previewService;
  }
  static async open(directory: string, file?: string, diagnostics = new DiagnosticLog()) {
    const log = diagnostics.child({ component: 'engine', engine: randomUUID() });
    return log.measure(
      'engine.open',
      async () => {
        const repo = await resolveRepo(directory);
        return new Engine(repo, new StateStore(file ?? stateFilePath(repo.commonRoot), repo.commonRoot), log);
      },
      {},
      'info',
    );
  }
  execute<K extends EngineCommand>(command: K, request: EngineInput<K>, context?: { developmentBranch: string | null }): Promise<EngineOutput<K>> {
    if (this.stopped) return Promise.reject(new WardenError(409, 'The repository session is closed.', 'session_closed'));
    const write = !reads.has(command);
    if (write) ++this.writers;
    const operation = this.log.measure(
      'engine.execute',
      async () => {
        // Keep execution deferred so callers can observe the same pending-operation barrier.
        await Promise.resolve();
        const handler = this.handlers[command];
        if (!Object.hasOwn(this.handlers, command)) throw badRequest('Unknown operation.', 'unknown_command');
        // Our own preview can legitimately outlast the cross-window lock timeout.
        // Finish it before a requested write starts competing for repository ownership.
        if (write) await this.ticking;
        if (!reads.has(command) && command !== 'preview.refresh' && command !== 'preview.setup') record(request);
        const invoke = () => (handler as (input: never) => Promise<unknown>)(request as never);
        const result = context && !reads.has(command) ? await this.store.withDevelopmentBranch(context.developmentBranch, invoke) : await invoke();
        if (command === 'workspaces.list') this.observe((result as WorktreesResponse).worktrees.map((row) => row.path));
        if (command === 'repository.get') this.observe((result as EngineOutput<'repository.get'>).workspaces.worktrees.map((row) => row.path));
        if (!reads.has(command)) this.changed();
        return result;
      },
      { method: command, mutation: write },
      write ? 'info' : 'trace',
    );
    this.pending.add(operation);
    void operation
      .finally(() => {
        this.pending.delete(operation);
        if (write) --this.writers;
      })
      .catch(() => {});
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
    this.onError = (error) => {
      this.log.write('error', 'engine.observer.failed', {
        code: error instanceof WardenError ? error.code : undefined,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      onError(error);
    };
    await mkdir(path.dirname(this.store.file), { recursive: true });
    if (this.stopped) return;
    this.stateWatcher = watch(path.dirname(this.store.file), (_event, filename) => {
      if (filename?.toString() === path.basename(this.store.file)) this.changed();
    });
    this.stateWatcher.on('error', this.onError);
    this.observe([this.root]);
    this.timer = setInterval(() => {
      if (!this.ticking && this.writers === 0)
        this.ticking = (async () => {
          if (!this.lease) {
            this.lease = (await this.store.acquirePreviewLease()) ?? undefined;
            if (this.lease) this.log.write('info', 'preview.owner.acquired');
          }
          if (this.lease && !this.stopped) await this.preview.tick();
        })()
          .catch(this.onError)
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
    this.log.write('debug', 'engine.observers.started', { watchers: this.watchers.size });
    this.changed();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.notification);
    this.stateWatcher?.close();
    this.closing = this.log.measure(
      'engine.close',
      async () => {
        await Promise.allSettled([this.ticking, this.notifying, ...this.pending, ...[...this.watchers.values()].map((w) => w.close())]);
        await this.lease?.release();
        if (this.lease) this.log.write('info', 'preview.owner.released');
      },
      { pending: this.pending.size, watchers: this.watchers.size },
      'info',
    );
    return this.closing;
  }
}
