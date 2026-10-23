import type { DevelopmentChange, PreviewResponse, ReviewState } from '@warden/shared';
import { snapshotObjects, snapshotStore, snapshotWorktree } from './snapshots.js';
import { badRequest, HttpError } from './errors.js';
import { runGit } from './git.js';
import { applyPatch, GitSandbox, gitMessage, oid, patchBetween, deliveryBase } from './git-sandbox.js';
import { listWorktreesAll, type RepoContext } from './repo.js';
import type { StateStore } from './state.js';
import { checkoutState, listWorktreesDetailed } from './worktrees.js';
import { runSetupCommand } from './workspace.js';

function conflict(message: string, code = 'preview_conflict'): never {
  throw new HttpError(409, message, code);
}
export async function primaryCheckout(repo: RepoContext, branch: string) {
  const row = (await listWorktreesAll(repo)).find((w) => !w.clone && w.branch === branch && !w.prunable);
  if (!row) return conflict('请先在主目录检出主开发分支', 'development_checkout_missing');
  const state = await checkoutState(repo, row);
  if (state.foreign || state.busy) return conflict('主目录有未完成的 Git 操作，请先处理', 'development_busy');
  return row;
}

type Inputs = Awaited<ReturnType<PreviewService['inputs']>>;

/** A persistent independent repository; composition never stages or writes primary-directory files. */
export class PreviewService {
  private observed?: { key: string; since: number };
  constructor(
    private repo: RepoContext,
    private store: StateStore,
    private debounceMs = 800,
  ) {}

  async get(): Promise<PreviewResponse> {
    const state = await this.store.load();
    const saved = state.connectionPreview;
    if (saved) {
      const { tree: _tree, directory: _directory, sandbox: _sandbox, snapshot: _snapshot, pending: _pending, migrating: _migrating, ...response } = saved;
      return response;
    }
    return { developmentBranch: state.workflow?.developmentBranch, connectedIds: [], status: 'disconnected', files: [] };
  }

  set(ids: string[]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw badRequest('连接列表格式错误');
    return this.store.withRepositoryLock(async () => {
      try {
        return await this.compose(ids);
      } catch (error) {
        const saved = (await this.store.load()).connectionPreview;
        if (
          JSON.stringify(saved?.connectedIds) === JSON.stringify(ids) ||
          (error instanceof HttpError && ['preview_dirty', 'preview_interrupted'].includes(error.code ?? ''))
        )
          await this.failed(error);
        throw error;
      }
    });
  }
  refresh() {
    return this.store.withRepositoryLock(() => this.refreshLocked());
  }
  private async refreshLocked() {
    try {
      return await this.compose();
    } catch (error) {
      await this.failed(error);
      return this.get();
    }
  }
  private async failed(error: unknown) {
    await this.store.update((state) => {
      const saved = state.connectionPreview;
      if (!saved) return;
      saved.status = 'stale';
      saved.syncStatus = error instanceof HttpError && error.code === 'preview_conflict' ? 'conflict' : 'error';
      saved.message = gitMessage(error);
      for (const source of saved.sources ?? []) {
        if (source.status !== 'synced' || (error instanceof HttpError && ['preview_dirty', 'preview_interrupted'].includes(error.code ?? '')))
          source.status = error instanceof HttpError && error.code === 'preview_conflict' ? 'conflict' : 'error';
      }
    });
  }

  /** Observe content hashes, not porcelain status or agent activity; coalesce bursts before publication. */
  async tick() {
    return this.store.withRepositoryLock(async () => {
      const state = await this.store.load();
      if (!state.connectionPreview) return;
      if (!state.connectionPreview.directory || state.connectionPreview.pending) {
        await this.refreshLocked();
        return;
      }
      try {
        const inputs = await this.inputs(state, state.connectionPreview.connectedIds);
        const saved = state.connectionPreview;
        if ((await snapshotWorktree(GitSandbox.open(this.store, saved.directory!).path, snapshotStore(this.store.file))) !== saved.tree)
          conflict('预览目录有额外改动，已停止同步；请在主目录编辑代码', 'preview_dirty');
        const unchanged =
          saved.baselineTree === inputs.baseline &&
          saved.developmentHead === inputs.head &&
          inputs.sources.every((source) => saved.sources?.some((s) => s.changeId === source.change.id && s.appliedTree === source.tree));
        const command = state.workspaceConfig?.previewSetup;
        if (unchanged && saved.status !== 'stale' && (!command || (saved.setup?.command === command && !['pending', 'running'].includes(saved.setup.status))))
          return;
        const key = JSON.stringify([inputs.head, inputs.baseline, inputs.sources.map((s) => [s.change.id, s.from, s.tree]), command]);
        if (this.observed?.key !== key) {
          this.observed = { key, since: Date.now() };
          await this.store.update((s) => {
            s.connectionPreview!.sources = this.sourceStates(inputs, saved, 'pending');
            s.connectionPreview!.syncStatus = 'pending';
          });
        }
        if (Date.now() - this.observed.since >= this.debounceMs) await this.refreshLocked();
      } catch (error) {
        await this.failed(error);
      }
    });
  }

  /** Legacy callers prepare/commit in primary; only old primary-directory previews need removal. */
  async suspend() {
    const state = await this.store.load();
    if (state.connectionPreview && !state.connectionPreview.directory) await this.migrateLegacy(state);
  }
  /** Caller holds the repository lock. Recompose against the new saved primary content. */
  async resume() {
    if ((await this.store.load()).connectionPreview) await this.refreshLocked();
  }

  setup() {
    return this.store.withRepositoryLock(async () => {
      const state = await this.store.load();
      if (!state.connectionPreview?.directory) return this.compose();
      await this.runSetup();
      return this.get();
    });
  }
  private async runSetup() {
    const state = await this.store.load();
    const saved = state.connectionPreview;
    const command = state.workspaceConfig?.previewSetup;
    if (!saved?.directory || !command) return;
    const directory = GitSandbox.open(this.store, saved.directory).path;
    await this.store.update((s) => {
      s.connectionPreview!.setup = { command, status: 'running' };
    });
    const result = await runSetupCommand(this.repo.commonRoot, directory, command, {
      WARDEN_PREVIEW: directory,
      WARDEN_DEVELOPMENT_BRANCH: state.workflow!.developmentBranch,
      WARDEN_HOOK_EVENT: 'preview',
    });
    await this.store.update((s) => {
      s.connectionPreview!.setup = { command, ...result };
    });
    if ((await snapshotWorktree(directory, snapshotStore(this.store.file))) !== saved.tree)
      await this.failed(new HttpError(409, 'setup 修改了预览代码；请让脚本仅管理被忽略的环境文件，并恢复预览代码后重试', 'preview_dirty'));
  }

  /** Upgrade only a proven old composition; never silently turn agent preview files into the user's baseline. */
  private async migrateLegacy(state: ReviewState) {
    const saved = state.connectionPreview;
    if (!saved || saved.directory) return;
    const branch = saved.developmentBranch ?? state.workflow?.developmentBranch;
    if (!branch) return;
    const primary = await primaryCheckout(this.repo, branch);
    if (saved.pending) {
      const pending = saved.pending;
      const oldSandbox = saved.sandbox;
      const actual = await snapshotWorktree(primary.path, snapshotStore(this.store.file));
      if (actual === pending.tree) {
        Object.assign(saved, pending.response, { tree: pending.tree, sandbox: pending.sandbox, snapshot: pending.snapshot });
      } else if (actual !== saved.tree) conflict('旧预览更新被中断；请先处理主目录改动后再迁移', 'preview_interrupted');
      delete saved.pending;
      await this.store.update((s) => {
        s.connectionPreview = saved;
      });
      const obsolete = actual === pending.tree ? oldSandbox : pending.sandbox;
      if (obsolete && obsolete !== saved.sandbox) await GitSandbox.open(this.store, obsolete).dispose();
    }
    if (saved.tree && saved.developmentHead) {
      const baseline = await oid(primary.path, `${saved.developmentHead}^{tree}`);
      if (saved.tree !== baseline) {
        const actual = await snapshotWorktree(primary.path, snapshotStore(this.store.file));
        if (
          !saved.sandbox ||
          (await oid(primary.path, 'HEAD')) !== saved.developmentHead ||
          (actual !== saved.tree && !(saved.migrating && actual === baseline)) ||
          (await runGit(['diff', '--cached', '--quiet', saved.developmentHead, '--'], { cwd: primary.path, okCodes: [0, 1] })).code !== 0
        )
          conflict('旧预览仍在主目录且存在其他改动；请先在旧版中断开连接或恢复原预览后重试迁移', 'preview_migration_required');
        await this.store.update((s) => {
          s.connectionPreview!.migrating = true;
        });
        if (actual !== baseline)
          await applyPatch(primary.path, await patchBetween(GitSandbox.open(this.store, saved.sandbox).path, saved.tree, baseline), false);
      }
    }
    // Save the legacy baseline before allocating a new runtime. An interrupted upgrade can retry safely.
    await this.store.update((s) => {
      s.connectionPreview = { connectedIds: saved.connectedIds, files: [], status: 'disconnected' };
    });
    if (saved.sandbox) await GitSandbox.open(this.store, saved.sandbox).dispose();
  }

  private async recover(state: ReviewState) {
    const saved = state.connectionPreview;
    if (!saved?.pending || !saved.directory) return;
    const target = GitSandbox.open(this.store, saved.directory);
    const actual = await snapshotWorktree(target.path, snapshotStore(this.store.file));
    const pending = saved.pending;
    if (actual === pending.tree) {
      await target.fetch(GitSandbox.open(this.store, pending.sandbox).path, pending.snapshot);
      await target.write(['update-ref', 'HEAD', pending.snapshot]);
      await this.store.update((s) => {
        s.connectionPreview = { ...pending.response, directory: target.path, tree: pending.tree, snapshot: pending.snapshot };
      });
    } else if (actual === saved.tree) {
      await this.store.update((s) => {
        delete s.connectionPreview!.pending;
      });
    } else conflict('预览更新被中断且目录有额外改动；请检查预览目录后重试，主目录未被修改', 'preview_interrupted');
    await GitSandbox.open(this.store, pending.sandbox).dispose();
  }

  private async inputs(state: ReviewState, ids: string[]) {
    const workflow = state.workflow!;
    const primary = await primaryCheckout(this.repo, workflow.developmentBranch);
    const head = await oid(primary.path, 'HEAD');
    const baseline = await snapshotWorktree(primary.path, snapshotStore(this.store.file));
    const checkouts = ids.length ? await listWorktreesDetailed(this.repo) : [];
    const sources = [];
    for (const id of ids) {
      const change = workflow.changes.find((c): c is DevelopmentChange => c.id === id && !!c.worktree);
      if (!change || change.developmentBranch !== workflow.developmentBranch || change.status === 'accepted') throw badRequest('工作区不属于当前主开发分支');
      const checkout = checkouts.find((w) => w.path === change.worktree && w.branch === change.branch && !w.prunable && !w.foreign && !w.busy);
      if (!checkout || checkout.path === primary.path) conflict('工作区不可用或有未完成的 Git 操作', 'preview_source_busy');
      const from = await deliveryBase(change, await oid(checkout.path, 'HEAD'), head);
      const tree = await snapshotWorktree(checkout.path, snapshotStore(this.store.file));
      sources.push({ change, from, tree });
    }
    return { primary, head, baseline, sources };
  }
  private sourceStates(inputs: Inputs, previous: ReviewState['connectionPreview'], status: 'pending' | 'updating'): NonNullable<PreviewResponse['sources']> {
    return inputs.sources.map(({ change, tree }) => {
      const appliedTree = previous?.sources?.find((s) => s.changeId === change.id)?.appliedTree;
      return {
        changeId: change.id,
        observedTree: tree,
        appliedTree,
        status: appliedTree === tree && previous?.baselineTree === inputs.baseline ? 'synced' : status,
      };
    });
  }

  private async compose(requestedIds?: string[]): Promise<PreviewResponse> {
    let state = await this.store.load();
    if (!state.workflow) {
      if (!requestedIds?.length) return this.get();
      throw badRequest('请先选择主开发分支');
    }
    await this.migrateLegacy(state);
    state = await this.store.load();
    await this.recover(state);
    state = await this.store.load();
    const ids = requestedIds ?? state.connectionPreview?.connectedIds ?? [];
    const inputs = await this.inputs(state, ids);
    const { primary, head, baseline } = inputs;
    let previous = state.connectionPreview;
    const sandbox = await GitSandbox.create(this.store, primary.path, head);
    let retained = false;
    try {
      await applyPatch(
        sandbox.path,
        await patchBetween(primary.path, head, baseline, await snapshotObjects(primary.path, snapshotStore(this.store.file))),
        true,
      );
      if (previous?.directory && JSON.stringify(ids) === JSON.stringify(previous.connectedIds))
        await this.store.update((s) => {
          s.connectionPreview!.sources = this.sourceStates(inputs, previous, 'updating');
          s.connectionPreview!.syncStatus = 'updating';
        });
      for (const { change, from, tree } of inputs.sources) {
        await sandbox.fetch(change.worktree, from);
        try {
          await applyPatch(
            sandbox.path,
            await patchBetween(change.worktree, from, tree, await snapshotObjects(change.worktree, snapshotStore(this.store.file))),
            true,
            true,
          );
        } catch (error) {
          const conflicts = await sandbox.conflicts();
          conflict(`连接失败，${change.title} 的改动无法组合${conflicts.length ? `：${conflicts.join('、')}` : `：${gitMessage(error)}`}。原预览保持不变。`);
        }
      }
      const snapshot = await sandbox.commit();
      const tree = await oid(sandbox.path, 'HEAD^{tree}');
      if (!previous?.directory) {
        const target = await GitSandbox.create(this.store, primary.path, head);
        previous = {
          connectedIds: [],
          files: [],
          status: 'disconnected',
          directory: target.path,
          worktree: target.path,
          tree: await oid(target.path, 'HEAD^{tree}'),
        };
        try {
          await this.store.update((s) => {
            s.connectionPreview = previous;
          });
        } catch (error) {
          await target.dispose();
          throw error;
        }
      }
      const target = GitSandbox.open(this.store, previous.directory!);
      if ((await snapshotWorktree(target.path, snapshotStore(this.store.file))) !== previous.tree)
        conflict('预览目录有额外改动，已停止同步以保留这些文件；请在主目录编辑代码', 'preview_dirty');
      await sandbox.fetch(target.path, await oid(target.path, 'HEAD'));
      const patch = await patchBetween(sandbox.path, previous.tree!, tree);
      const command = state.workspaceConfig?.previewSetup;
      const needsSetup = !!command && (tree !== previous.tree || previous.setup?.command !== command || ['pending', 'running'].includes(previous.setup.status));
      const response: PreviewResponse = {
        developmentBranch: state.workflow!.developmentBranch,
        developmentHead: head,
        worktree: target.path,
        connectedIds: ids,
        status: ids.length ? 'current' : 'disconnected',
        syncStatus: 'synced',
        updatedAt: new Date().toISOString(),
        files: [],
        baselineTree: baseline,
        sources: inputs.sources.map(({ change, tree }) => ({ changeId: change.id, observedTree: tree, appliedTree: tree, status: 'synced' })),
        setup: needsSetup ? { command: command!, status: 'pending' } : previous.setup,
      };
      // Publish a complete candidate only. Source edits after capture will be observed in the next batch.
      await target.fetch(sandbox.path, snapshot);
      await this.store.update((s) => {
        s.connectionPreview = { ...previous!, pending: { tree, sandbox: sandbox.path, snapshot, response } };
      });
      retained = true;
      await applyPatch(target.path, patch, true);
      if ((await snapshotWorktree(target.path, snapshotStore(this.store.file))) !== tree)
        conflict('同步期间预览目录发生变化，已停止继续同步，请检查文件', 'preview_interrupted');
      await target.write(['update-ref', 'HEAD', snapshot]);
      await this.store.update((s) => {
        s.connectionPreview = { ...response, directory: target.path, tree, snapshot };
      });
      retained = false;
      if (needsSetup) await this.runSetup();
      return this.get();
    } finally {
      if (!retained) await sandbox.dispose();
    }
  }
}
