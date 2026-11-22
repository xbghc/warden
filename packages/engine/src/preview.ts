import type { DevelopmentChange, PreviewResponse, ReviewState, WorkFolderChanges } from '@warden/shared';
import { snapshotObjects, snapshotStore, snapshotWorktree } from './snapshots.js';
import { WorkFolder, workFolderPath } from './work-folder.js';
import { badRequest, WardenError } from './errors.js';
import { runGit } from './git.js';
import { mirrorLocalSetup } from './clones.js';
import { ensureSharedRepository, validatedSharedRepository } from './shared-repository.js';
import { GitSandbox, gitMessage, oid, patchBetween, deliveryBase, deliveryContentBase, deliveredTree } from './git-sandbox.js';
import { listWorktreesAll, type RepoContext } from './repo.js';
import type { StateStore } from './state.js';
import { checkoutIdentity, checkoutState, primaryDirectories, type PrimaryDirectories } from './worktrees.js';
import { assertSetupIdle, runSetupCommand, setupOwner } from './workspace.js';

function conflict(message: string, code = 'preview_conflict'): never {
  throw new WardenError(409, message, code);
}

function assertPreviewSetupIdle(setup: PreviewResponse['setup']) {
  // Legacy previews did not record an owner and recover under the repository lock as before.
  // New runs retain their owner when cleanup fails, so a retry cannot overlap surviving commands.
  if (setup?.status === 'running' && setup.owner !== undefined) assertSetupIdle({ status: setup.status, owner: setup.owner }, 'preview');
}

export async function primaryCheckout(repo: RepoContext, branch: string, listed?: Awaited<ReturnType<typeof listWorktreesAll>>, primary?: PrimaryDirectories) {
  const row = (listed ?? (await listWorktreesAll(repo))).find((w) => !w.clone && !w.shared && w.branch === branch && !w.prunable);
  if (!row) return conflict('Check out the base branch in the primary folder first.', 'development_checkout_missing');
  const state = await checkoutState(repo, row, false, primary);
  if (state.foreign || state.busy) return conflict('Finish the Git operation in the primary folder first.', 'development_busy');
  return row;
}

type Inputs = Awaited<ReturnType<PreviewService['inputs']>>;

/**
 * Keeps the work folder on the base branch commit plus the connected tasks' changes. The user's
 * edits there are merged into every new composition; primary's files and index are never written.
 */
export class PreviewService {
  private observed?: { key: string; since: number };
  /** Inputs whose automatic composition already failed; only new inputs or a request retry them. */
  private rejected?: string;
  constructor(
    private repo: RepoContext,
    private store: StateStore,
    private debounceMs = 800,
  ) {}

  async get(): Promise<PreviewResponse> {
    const state = await this.store.load();
    const saved = state.connectionPreview;
    if (saved) {
      const { tree: _tree, directory: _directory, snapshot: _snapshot, pending: _pending, ...response } = saved;
      return response;
    }
    return { developmentBranch: state.workflow?.developmentBranch, connectedIds: [], status: 'disconnected', files: [] };
  }

  set(ids: string[]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length)
      throw badRequest('Invalid work folder connection list.');
    return this.store.withRepositoryLock(async () => {
      this.rejected = undefined;
      try {
        return await this.compose(ids);
      } catch (error) {
        const saved = (await this.store.load()).connectionPreview;
        if (JSON.stringify(saved?.connectedIds) === JSON.stringify(ids) || (error instanceof WardenError && error.code === 'preview_interrupted'))
          await this.failed(error);
        throw error;
      }
    });
  }
  /** Task deletion already holds the repository lock. Recover publication before
   * deriving the remaining connection set, including an interrupted disconnection.
   */
  async disconnectTaskLocked(taskId: string) {
    await this.recover(await this.store.load());
    const saved = (await this.store.load()).connectionPreview;
    if (!saved?.connectedIds.includes(taskId)) return this.get();
    try {
      return await this.compose(saved.connectedIds.filter((id) => id !== taskId));
    } catch (error) {
      await this.failed(error);
      throw error;
    }
  }
  refresh() {
    return this.store.withRepositoryLock(() => {
      this.rejected = undefined;
      return this.refreshLocked();
    });
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
    const mark = (saved: NonNullable<ReviewState['connectionPreview']>) => {
      saved.status = 'stale';
      saved.syncStatus = error instanceof WardenError && error.code === 'preview_conflict' ? 'conflict' : 'error';
      saved.message = gitMessage(error);
      for (const source of saved.sources ?? []) {
        if (source.status !== 'synced' || (error instanceof WardenError && error.code === 'preview_interrupted'))
          source.status = error instanceof WardenError && error.code === 'preview_conflict' ? 'conflict' : 'error';
      }
    };
    // A repeated identical failure must not rewrite state: every write wakes each window's watcher.
    const current = (await this.store.load()).connectionPreview;
    if (!current) return;
    const before = JSON.stringify(current);
    mark(current);
    if (JSON.stringify(current) === before) return;
    await this.store.update((state) => {
      if (state.connectionPreview) mark(state.connectionPreview);
    });
  }

  /** Caller holds the repository lock. Creation is left to composition; ticks only refresh. */
  private async mirrorSetup(create: boolean) {
    const repository = create ? await ensureSharedRepository(this.store.repoRoot) : await validatedSharedRepository(this.store.repoRoot);
    if (repository) await mirrorLocalSetup(this.repo.commonRoot, repository);
    return repository;
  }

  /** Observe content hashes, not porcelain status or agent activity; coalesce bursts before publication. */
  async tick() {
    return this.store.withRepositoryLock(async () => {
      const state = await this.store.load();
      if (!state.connectionPreview || !state.workflow?.trackedBranches?.includes(state.workflow.developmentBranch)) return;
      if (state.workflow.changes.some((task) => task.deletion && state.connectionPreview!.connectedIds.includes(task.id))) return;
      // Leaving the base branch suspends its preview without turning a normal checkout
      // into a sync failure or composing unrelated primary content into retained connections.
      const primaryRef = (await runGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd: this.repo.commonRoot })).stdout.trim();
      if (primaryRef !== `refs/heads/${state.workflow?.developmentBranch}`) {
        this.observed = undefined;
        return;
      }
      if (!state.connectionPreview.directory || state.connectionPreview.pending) {
        await this.refreshLocked();
        return;
      }
      let key: string | undefined;
      try {
        assertPreviewSetupIdle(state.connectionPreview.setup);
        const shared = await this.mirrorSetup(false);
        const inputs = await this.inputs(state, state.connectionPreview.connectedIds, { shared });
        const saved = state.connectionPreview;
        const folder = await WorkFolder.open(this.repo.commonRoot, this.store.file, saved.directory!);
        const actual = await folder.snapshot();
        const command = state.workspaceConfig?.previewSetup;
        key = JSON.stringify([state.workflow?.developmentBranch, inputs.head, inputs.sources.map((s) => [s.change.id, s.from, s.tree]), command, actual]);
        // The same sources, base commit and folder content would fail the same way. Retrying each
        // second would rebuild a whole worktree and hold the repository lock for nothing.
        if (key === this.rejected) return;
        const unchanged =
          saved.developmentBranch === state.workflow?.developmentBranch &&
          saved.developmentHead === inputs.head &&
          inputs.sources.every((source) => saved.sources?.some((s) => s.changeId === source.change.id && s.appliedTree === source.tree));
        if (unchanged && saved.status !== 'stale' && (!command || (saved.setup?.command === command && !['pending', 'running'].includes(saved.setup.status))))
          return;
        if (this.observed?.key !== key) {
          this.observed = { key, since: Date.now() };
          await this.store.update((s) => {
            s.connectionPreview!.sources = this.sourceStates(inputs, saved, 'pending');
            s.connectionPreview!.syncStatus = 'pending';
          });
        }
        if (Date.now() - this.observed.since >= this.debounceMs) await this.compose();
      } catch (error) {
        // Busy checkouts and locks clear without changing any observed input, so only failures
        // decided by content are remembered.
        if (key && error instanceof WardenError && ['preview_conflict', 'preview_interrupted', 'git_failed'].includes(error.code ?? '')) this.rejected = key;
        await this.failed(error);
      }
    });
  }

  /** Caller holds the repository lock. Recompose against the new saved primary content. */
  async resume() {
    if ((await this.store.load()).connectionPreview) await this.refreshLocked();
  }

  setup() {
    return this.store.withRepositoryLock(async () => {
      try {
        const state = await this.store.load();
        if (!state.connectionPreview?.directory) return await this.compose();
        await this.runSetup();
        return this.get();
      } catch (error) {
        await this.failed(error);
        throw error;
      }
    });
  }
  private async runSetup() {
    const state = await this.store.load();
    const saved = state.connectionPreview;
    const command = state.workspaceConfig?.previewSetup;
    assertPreviewSetupIdle(saved?.setup);
    if (!saved?.directory || !command) return;
    const folder = await WorkFolder.open(this.repo.commonRoot, this.store.file, saved.directory);
    const directory = folder.path;
    const before = await folder.snapshot();
    const owner = setupOwner();
    await this.store.update((s) => {
      s.connectionPreview!.setup = { command, status: 'running', owner };
    });
    let recorded: Promise<unknown> | undefined;
    const result = await runSetupCommand(
      this.repo.commonRoot,
      directory,
      command,
      { WARDEN_PREVIEW: directory, WARDEN_DEVELOPMENT_BRANCH: state.workflow!.developmentBranch, WARDEN_HOOK_EVENT: 'preview' },
      undefined,
      (group) => {
        recorded = this.store
          .update((s) => {
            if (s.connectionPreview?.setup?.status === 'running') s.connectionPreview.setup.owner = { ...owner, group };
          })
          .catch(() => {});
      },
    );
    await recorded;
    await this.store.update((s) => {
      s.connectionPreview!.setup = { command, ...result };
    });
    // The user's own edits are expected here; only what changed while the script ran is reported.
    if ((await folder.snapshot()) !== before)
      await this.failed(
        new WardenError(
          409,
          'Source files changed while the setup script ran. Restrict it to ignored environment files and review the work folder.',
          'preview_setup_changed',
        ),
      );
  }

  /** The synced work folder and its composition, for reading or committing the user's edits. */
  async folder() {
    const saved = (await this.store.load()).connectionPreview;
    if (!saved?.directory || !saved.tree || !saved.snapshot || saved.pending) return undefined;
    return { saved, folder: await WorkFolder.open(this.repo.commonRoot, this.store.file, saved.directory), tree: saved.tree, snapshot: saved.snapshot };
  }

  async changes(): Promise<WorkFolderChanges> {
    const current = await this.folder();
    if (!current) return { files: [] };
    const tree = await current.folder.snapshot();
    const listed = await runGit(['diff', '--name-status', '--no-renames', '-z', current.tree, tree, '--'], {
      cwd: current.folder.path,
      snapshot: await current.folder.objects(),
    });
    const fields = listed.stdout.split('\0');
    const files: WorkFolderChanges['files'] = [];
    for (let index = 0; index + 1 < fields.length; index += 2)
      files.push({ path: fields[index + 1]!, status: fields[index] === 'A' ? 'added' : fields[index] === 'D' ? 'deleted' : 'modified' });
    return { directory: current.folder.path, composition: current.snapshot, developmentHead: current.saved.developmentHead, tree, files };
  }

  /** Finishes or drops an update that was interrupted between its journal and its last write. */
  private async recover(state: ReviewState) {
    const saved = state.connectionPreview;
    if (!saved?.pending || !saved.directory) return;
    assertPreviewSetupIdle(saved.setup);
    const pending = saved.pending;
    const folder = await WorkFolder.open(this.repo.commonRoot, this.store.file, saved.directory);
    // The journal is written after the objects arrive, so the folder can read every tree it names.
    await folder.publish(pending.from, pending.merged, pending.mergedTree);
    await folder.settle(pending.snapshot);
    await this.store.update((s) => {
      s.connectionPreview = { ...pending.response, directory: folder.path, tree: pending.tree, snapshot: pending.snapshot };
    });
    await GitSandbox.open(this.store, pending.sandbox).dispose();
  }

  /** `validated` holds the shared repository a tick validated just before, under the same repository lock. */
  private async inputs(state: ReviewState, ids: string[], validated?: { shared: string | undefined }) {
    const workflow = state.workflow!;
    // One inventory answers for primary and every source: this runs once a second.
    const listed = await listWorktreesAll(this.repo, undefined, validated);
    const directories = primaryDirectories(this.repo);
    const primary = await primaryCheckout(this.repo, workflow.developmentBranch, listed, directories);
    // Primary only carries commits to and from the remote; its working files are not an input.
    const head = await oid(primary.path, 'HEAD');
    const sources = [];
    for (const id of ids) {
      const change = workflow.changes.find((c): c is DevelopmentChange => c.id === id && !!c.worktree);
      if (!change || change.developmentBranch !== workflow.developmentBranch || change.status === 'accepted')
        throw badRequest('This workspace does not belong to the current base branch.');
      if (change.deletion) throw badRequest('Task deletion is pending. Retry deletion first.', 'task_deleting');
      // Only a connected source is verified, and by identity alone: its content is snapshotted
      // below, and the other checkouts, the work folder included, answer nothing asked here.
      const row = listed.find((w) => w.path === change.worktree && w.branch === change.branch && !w.prunable);
      const checkout = row && (await checkoutIdentity(this.repo, row, directories));
      if (!checkout || checkout.foreign || checkout.busy || checkout.path === primary.path)
        conflict('The workspace is unavailable or has an unfinished Git operation.', 'preview_source_busy');
      const from = await deliveryBase(change, await oid(checkout.path, 'HEAD'), head, this.repo.commonRoot);
      const tree = await snapshotWorktree(checkout.path, snapshotStore(this.store.file));
      sources.push({ change, from, tree });
    }
    return { primary, head, sources };
  }
  private sourceStates(inputs: Inputs, previous: ReviewState['connectionPreview'], status: 'pending' | 'updating'): NonNullable<PreviewResponse['sources']> {
    return inputs.sources.map(({ change, tree }) => {
      const appliedTree = previous?.sources?.find((s) => s.changeId === change.id)?.appliedTree;
      return {
        changeId: change.id,
        observedTree: tree,
        appliedTree,
        status: appliedTree === tree && previous?.developmentHead === inputs.head ? 'synced' : status,
      };
    });
  }

  private async compose(requestedIds?: string[]): Promise<PreviewResponse> {
    let state = await this.store.load();
    if (!state.workflow) {
      if (!requestedIds?.length) return this.get();
      throw badRequest('Select a base branch first.');
    }
    assertPreviewSetupIdle(state.connectionPreview?.setup);
    // Before recovery and every snapshot below: they must see primary's current ignore rules.
    await this.mirrorSetup(true);
    // A preview kept in Warden's data directory by an earlier version is not carried over.
    if (
      state.connectionPreview &&
      state.connectionPreview.directory !== undefined &&
      state.connectionPreview.directory !== workFolderPath(this.repo.commonRoot)
    ) {
      const obsolete = state.connectionPreview.directory;
      await this.store.update((s) => {
        s.connectionPreview = { connectedIds: s.connectionPreview!.connectedIds, files: [], status: 'disconnected' };
      });
      await GitSandbox.open(this.store, obsolete)
        .dispose()
        .catch(() => {});
      state = await this.store.load();
    }
    await this.recover(state);
    state = await this.store.load();
    const ids = requestedIds ?? state.connectionPreview?.connectedIds ?? [];
    const inputs = await this.inputs(state, ids);
    const { primary, head } = inputs;
    let previous = state.connectionPreview;
    const sandbox = await GitSandbox.create(this.store, primary.path, head);
    let retained = false;
    try {
      if (previous?.directory && JSON.stringify(ids) === JSON.stringify(previous.connectedIds))
        await this.store.update((s) => {
          s.connectionPreview!.sources = this.sourceStates(inputs, previous, 'updating');
          s.connectionPreview!.syncStatus = 'updating';
        });
      for (const { change, from, tree } of inputs.sources) {
        await sandbox.fetch(change.worktree, from);
        try {
          const objects = await snapshotObjects(change.worktree, snapshotStore(this.store.file));
          const contentBase = deliveryContentBase(change, from, await deliveredTree(change, head, this.repo.commonRoot));
          await sandbox.apply(
            await patchBetween(change.worktree, contentBase, tree, objects),
            true,
            true,
            contentBase !== from ? { cwd: change.worktree, snapshot: objects } : undefined,
          );
        } catch (error) {
          const conflicts = await sandbox.conflicts();
          conflict(
            `Cannot connect ${change.title}: its changes could not be combined${conflicts.length ? `: ${conflicts.join(', ')}` : `: ${gitMessage(error)}`}. The work folder is unchanged.`,
          );
        }
      }
      const snapshot = await sandbox.commit();
      const tree = await oid(sandbox.path, 'HEAD^{tree}');
      const folder = await WorkFolder.ensure(this.repo.commonRoot, this.store.file, head);
      if (!previous?.directory) {
        // A folder that already exists keeps whatever the user has in it; it is merged like any edit.
        const current = await folder.head();
        previous = {
          connectedIds: [],
          files: [],
          status: 'disconnected',
          directory: folder.path,
          worktree: folder.path,
          tree: await oid(folder.path, `${current}^{tree}`),
          snapshot: current,
        };
        await this.store.update((s) => {
          s.connectionPreview = previous;
        });
      }
      const from = await folder.snapshot();
      let merged = snapshot;
      let mergedTree = tree;
      if (from !== previous.tree) {
        // The user's edits are replayed on the new composition before the folder is touched, so a
        // conflict leaves every file as it is.
        const objects = await folder.objects();
        await sandbox.fetch(folder.path, previous.snapshot!);
        try {
          await sandbox.apply(await patchBetween(folder.path, previous.tree!, from, objects), true, true, { cwd: folder.path, snapshot: objects });
        } catch (error) {
          const conflicts = await sandbox.conflicts();
          conflict(
            `Your edits in the work folder conflict with the connected changes${conflicts.length ? `: ${conflicts.join(', ')}` : `: ${gitMessage(error)}`}. The work folder is unchanged.`,
          );
        }
        merged = await sandbox.commit('Warden temporary composition with work folder edits');
        mergedTree = await oid(sandbox.path, 'HEAD^{tree}');
      }
      const command = state.workspaceConfig?.previewSetup;
      const needsSetup =
        !!command &&
        (previous.developmentBranch !== state.workflow!.developmentBranch ||
          tree !== previous.tree ||
          previous.setup?.command !== command ||
          ['pending', 'running'].includes(previous.setup.status));
      const response: PreviewResponse = {
        developmentBranch: state.workflow!.developmentBranch,
        developmentHead: head,
        worktree: folder.path,
        connectedIds: ids,
        status: ids.length ? 'current' : 'disconnected',
        syncStatus: 'synced',
        updatedAt: new Date().toISOString(),
        files: [],
        sources: inputs.sources.map(({ change, tree }) => ({ changeId: change.id, observedTree: tree, appliedTree: tree, status: 'synced' })),
        setup: needsSetup ? { command: command!, status: 'pending' } : previous.setup,
      };
      // Source edits after capture will be observed in the next batch. An edit saved in the folder
      // since its snapshot would not be in `merged`; the next tick starts over from it.
      await folder.fetch(sandbox.path, merged);
      if ((await folder.snapshot()) !== from) conflict('The work folder changed while its update was prepared. It will be retried.', 'preview_source_busy');
      await this.store.update((s) => {
        s.connectionPreview = { ...previous!, pending: { from, merged, mergedTree, tree, sandbox: sandbox.path, snapshot, response } };
      });
      retained = true;
      await folder.publish(from, merged, mergedTree);
      await folder.settle(snapshot);
      await this.store.update((s) => {
        s.connectionPreview = { ...response, directory: folder.path, tree, snapshot };
      });
      retained = false;
      if (needsSetup) await this.runSetup();
      return this.get();
    } finally {
      if (!retained) await sandbox.dispose();
    }
  }
}
