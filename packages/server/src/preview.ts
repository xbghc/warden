import type { DevelopmentChange, PreviewResponse, ReviewState } from '@warden/shared';
import { checkpointObjects, checkpointStore, snapshotWorktree } from './checkpoints.js';
import { badRequest, HttpError } from './errors.js';
import { runGit } from './git.js';
import { applyPatch, GitSandbox, gitMessage, oid, patchBetween, deliveryBase } from './git-sandbox.js';
import { listWorktreesAll, type RepoContext } from './repo.js';
import type { StateStore } from './state.js';
import { checkoutState, listWorktreesDetailed } from './worktrees.js';

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

/** Temporary working files only. The actual primary index and HEAD never belong to preview. */
export class PreviewService {
  constructor(
    private repo: RepoContext,
    private store: StateStore,
  ) {}

  async get(): Promise<PreviewResponse> {
    const state = await this.store.load();
    const saved = state.connectionPreview;
    if (saved) {
      const { tree: _tree, sandbox: _sandbox, snapshot: _snapshot, pending: _pending, ...response } = saved;
      return response;
    }
    const branch = state.workflow?.developmentBranch;
    const checkout = branch ? await primaryCheckout(this.repo, branch).catch(() => undefined) : undefined;
    return { developmentBranch: branch, developmentHead: checkout?.head, worktree: checkout?.path, connectedIds: [], status: 'disconnected', files: [] };
  }

  set(ids: string[]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw badRequest('连接列表格式错误');
    return this.store.withRepositoryLock(() => this.compose(ids));
  }
  refresh() {
    return this.store.withRepositoryLock(async () => {
      const state = await this.store.load();
      const saved = state.connectionPreview;
      if (saved?.status === 'paused') {
        if (!state.workflow?.changes.some((c) => c.status === 'integrating')) await this.resume();
        return this.get();
      }
      try {
        return await this.compose();
      } catch (error) {
        await this.store.update((state) => {
          if (state.connectionPreview) Object.assign(state.connectionPreview, { status: 'stale', message: gitMessage(error) });
        });
        return this.get();
      }
    });
  }
  async tick() {
    const saved = (await this.store.load()).connectionPreview;
    if (saved?.pending || (saved?.connectedIds.length && saved.status !== 'paused')) await this.refresh();
  }

  /** Caller holds the repository lock. Restore only files proven to be our last composition. */
  async suspend() {
    const saved = (await this.store.load()).connectionPreview;
    if (!saved?.connectedIds.length || saved.status === 'paused') return;
    await this.compose([], true);
  }
  /** Caller holds the lock. A completed commit/history publication establishes the new baseline. */
  async resume() {
    const state = await this.store.load();
    if (state.connectionPreview?.status !== 'paused' || !state.workflow) return;
    const primary = await primaryCheckout(this.repo, state.workflow.developmentBranch);
    const head = await oid(primary.path, 'HEAD');
    const tree = await oid(primary.path, 'HEAD^{tree}');
    if ((await snapshotWorktree(primary.path, checkpointStore(this.store.file))) !== tree) return;
    const ids = state.connectionPreview.connectedIds;
    const previousSandbox = state.connectionPreview.sandbox;
    await this.store.update((s) => {
      Object.assign(s.connectionPreview!, { developmentHead: head, tree, sandbox: undefined, snapshot: undefined, status: 'stale' });
    });
    if (previousSandbox) await GitSandbox.open(this.store, previousSandbox).dispose();
    try {
      await this.compose(ids);
    } catch (error) {
      await this.store.update((s) => {
        Object.assign(s.connectionPreview!, { status: 'stale', message: gitMessage(error) });
      });
    }
  }

  private async recover(state: ReviewState, cwd: string) {
    const saved = state.connectionPreview;
    if (!saved?.pending) return;
    const obsolete: string[] = [];
    const actual = await snapshotWorktree(cwd, checkpointStore(this.store.file));
    if (actual === saved.pending.tree) {
      const pending = saved.pending;
      const keepSnapshot = pending.response.status !== 'paused' && pending.response.connectedIds.length > 0;
      state.connectionPreview = {
        ...pending.response,
        tree: pending.tree,
        ...(keepSnapshot ? { sandbox: pending.sandbox, snapshot: pending.snapshot } : {}),
      };
      if (saved.sandbox && saved.sandbox !== pending.sandbox) obsolete.push(saved.sandbox);
      if (!keepSnapshot) obsolete.push(pending.sandbox);
    } else if (actual === saved.tree) {
      obsolete.push(saved.pending.sandbox);
      delete saved.pending;
    } else conflict('连接更新被中断，主目录有其他改动；请手动处理后重试', 'preview_interrupted');
    await this.store.update((s) => {
      s.connectionPreview = state.connectionPreview;
    });
    for (const sandbox of obsolete) await GitSandbox.open(this.store, sandbox).dispose();
  }

  private async compose(requestedIds?: string[], suspending = false): Promise<PreviewResponse> {
    const state = await this.store.load();
    const workflow = state.workflow;
    if (!workflow) {
      if (!requestedIds?.length) return this.get();
      throw badRequest('请先选择主开发分支');
    }
    if (!suspending && (state.connectionPreview?.status === 'paused' || workflow.changes.some((c) => c.status === 'integrating')))
      conflict('主目录正在准备提交，完成后可以调整连接', 'preview_paused');
    const primary = await primaryCheckout(this.repo, workflow.developmentBranch);
    await this.recover(state, primary.path);
    const ids = requestedIds ?? state.connectionPreview?.connectedIds ?? [];
    const head = await oid(primary.path, 'HEAD');
    const baseline = await oid(primary.path, 'HEAD^{tree}');
    const previous = state.connectionPreview;
    if (previous?.developmentHead && previous.developmentHead !== head && previous.tree !== baseline)
      conflict('主开发分支已变化，请先处理主目录的临时改动', 'preview_head_changed');
    const expected = previous?.tree ?? baseline;
    const assertOwned = async () => {
      if ((await oid(primary.path, 'HEAD')) !== head) conflict('主开发分支已变化，请刷新', 'preview_head_changed');
      if ((await runGit(['diff', '--cached', '--quiet', head, '--'], { cwd: primary.path, okCodes: [0, 1] })).code !== 0)
        conflict('主目录暂存区有改动，连接没有修改它', 'development_dirty');
      if ((await snapshotWorktree(primary.path, checkpointStore(this.store.file))) !== expected)
        conflict('主目录有不属于当前连接的改动，请自行处理后再连接', 'development_dirty');
    };
    await assertOwned();
    const checkouts = await listWorktreesDetailed(this.repo);
    const sandbox = await GitSandbox.create(this.store, primary.path, head);
    let retained = false;
    try {
      const files = new Map<string, string[]>();
      for (const id of ids) {
        const change = workflow.changes.find((c): c is DevelopmentChange => c.id === id && !!c.worktree);
        if (!change || change.developmentBranch !== workflow.developmentBranch || change.status === 'accepted') throw badRequest('工作区不属于当前主开发分支');
        const checkout = checkouts.find((w) => w.path === change.worktree && w.branch === change.branch && !w.prunable && !w.foreign && !w.busy);
        if (!checkout || checkout.path === primary.path) conflict('工作区不可用或有未完成的 Git 操作', 'preview_source_busy');
        const from = await deliveryBase(change, await oid(checkout.path, 'HEAD'), head);
        const tree = await snapshotWorktree(checkout.path, checkpointStore(this.store.file));
        const snapshot = await checkpointObjects(checkout.path, checkpointStore(this.store.file));
        const paths = (await runGit(['diff', '--name-only', '-z', from, tree, '--'], { cwd: checkout.path, snapshot })).stdout.split('\0').filter(Boolean);
        for (const file of paths) files.set(file, [...(files.get(file) ?? []), id]);
        await sandbox.fetch(checkout.path, from);
        try {
          await applyPatch(sandbox.path, await patchBetween(checkout.path, from, tree, snapshot), true, true);
        } catch (error) {
          const conflicts = await sandbox.conflicts();
          conflict(`连接失败，${change.title} 的改动无法组合${conflicts.length ? `：${conflicts.join('、')}` : `：${gitMessage(error)}`}。原预览保持不变。`);
        }
      }
      const snapshot = await sandbox.commit();
      const tree = await oid(sandbox.path, 'HEAD^{tree}');
      if (previous?.sandbox && previous.snapshot) await sandbox.fetch(GitSandbox.open(this.store, previous.sandbox).path, previous.snapshot);
      const patch = await patchBetween(sandbox.path, expected, tree);
      const response: PreviewResponse = {
        developmentBranch: workflow.developmentBranch,
        developmentHead: head,
        worktree: primary.path,
        connectedIds: suspending ? (previous?.connectedIds ?? []) : ids,
        status: suspending ? 'paused' : ids.length ? 'current' : 'disconnected',
        message: suspending ? '正在主目录准备提交，连接同步已暂停' : undefined,
        updatedAt: new Date().toISOString(),
        files: [...files].map(([path, changeIds]) => ({ path, changeIds })),
      };
      await assertOwned();
      if (!patch && previous?.tree === tree) {
        if (
          previous.status !== response.status ||
          previous.developmentHead !== head ||
          JSON.stringify(previous.connectedIds) !== JSON.stringify(ids) ||
          JSON.stringify(previous.files) !== JSON.stringify(response.files) ||
          (!ids.length && !!previous.sandbox)
        )
          await this.store.update((s) => {
            s.connectionPreview = { ...previous, ...response, ...(!ids.length ? { sandbox: undefined, snapshot: undefined } : {}) };
          });
        if (!ids.length && previous.sandbox) {
          await GitSandbox.open(this.store, previous.sandbox).dispose();
        }
        return response;
      }
      // Durable before touching files. On restart, accept only the complete old or new tree.
      await this.store.update((s) => {
        s.connectionPreview = {
          ...(previous ?? { connectedIds: [], files: [], status: 'disconnected' }),
          tree: expected,
          pending: { tree, sandbox: sandbox.path, snapshot, response },
        };
      });
      retained = true;
      await applyPatch(primary.path, patch, false);
      if ((await snapshotWorktree(primary.path, checkpointStore(this.store.file))) !== tree)
        conflict('同步期间主目录发生变化，已停止继续同步，请检查文件', 'preview_interrupted');
      await this.store.update((s) => {
        s.connectionPreview = { ...response, tree, ...(ids.length ? { sandbox: sandbox.path, snapshot } : {}) };
      });
      retained = ids.length > 0;
      if (previous?.sandbox && previous.sandbox !== sandbox.path) await GitSandbox.open(this.store, previous.sandbox).dispose();
      return response;
    } finally {
      if (!retained) await sandbox.dispose();
    }
  }
}
