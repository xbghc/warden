import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileEntry, TaskReview, WorkflowTask, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { previewStatusLabels } from '@warden/shared';

type Entry =
  | { kind: 'task'; task: WorkflowTask }
  | { kind: 'folder'; path: string; task: WorkflowTask }
  | { kind: 'file'; file: FileEntry; target: string; task?: WorkflowTask; review?: TaskReview }
  | { kind: 'notice'; message: string; error: boolean; task: WorkflowTask };
export type SidebarNode = Entry & { session?: string; scope?: string };
type FileNode = Extract<SidebarNode, { kind: 'file' }>;
type FileViewMode = 'list' | 'tree';

const dragType = 'application/vnd.code.tree.warden.task';

/** Native navigation owns selection and keyboard access; editor panels open only for explicit actions. */
export class Sidebar implements vscode.TreeDataProvider<SidebarNode>, vscode.TreeDragAndDropController<SidebarNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SidebarNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = [dragType];
  readonly dropMimeTypes = [dragType];
  readonly view: vscode.TreeView<SidebarNode>;
  private drag?: { session: string; taskId: string; nonce: string };
  private signature?: string;
  private readonly subscriptions: vscode.Disposable[];
  private readonly files = new Map<string, { session: string; nodes: FileNode[] }>();
  private mode: FileViewMode;
  private context?: string;
  private pendingExpansion?: { scope: string; session: string; published?: boolean };
  private restoring?: Promise<void>;
  private disposed = false;

  get fileViewMode() {
    return this.mode;
  }

  constructor(
    private readonly model: () => WorkbenchModel,
    private readonly children: (node?: SidebarNode) => Promise<SidebarNode[]>,
    private readonly action: (action: WorkbenchAction, session: string) => Promise<unknown>,
    expansion: (node: SidebarNode, expanded: boolean) => Promise<void>,
    private readonly state: vscode.Memento,
    private readonly report: (error: unknown) => void = console.error,
  ) {
    this.mode = state.get('warden.fileViewMode') === 'tree' ? 'tree' : 'list';
    this.view = vscode.window.createTreeView('warden.task', { treeDataProvider: this, dragAndDropController: this });
    this.subscriptions = [
      this.view.onDidExpandElement(({ element }) => {
        void expansion(element, true);
      }),
      this.view.onDidCollapseElement(({ element }) => {
        void expansion(element, false);
      }),
      this.view.onDidChangeVisibility(() => this.restoreExpansion()),
    ];
  }

  async setFileViewMode(mode: FileViewMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.refresh();
    await this.state.update('warden.fileViewMode', mode);
  }

  refresh() {
    if (this.disposed) return;
    const model = this.model();
    const scope = `${model.repository}:${model.workflow?.workflow?.developmentBranch ?? ''}:`;
    const context = JSON.stringify([model.session, scope, model.repositoryState, model.agentReadiness.status === 'ready']);
    if (context !== this.context) {
      this.context = context;
      this.pendingExpansion =
        model.repositoryState === 'ready' &&
        model.agentReadiness.status === 'ready' &&
        model.workflow?.workflow &&
        model.workspaces?.some((row) => row.expanded)
          ? { scope, session: model.session }
          : undefined;
    }
    for (const [taskId, files] of this.files) {
      if (files.session !== model.session || !model.workspaces?.some((row) => row.task.id === taskId)) this.files.delete(taskId);
    }
    const branch = model.workflow?.workflow?.developmentBranch;
    if (this.view.description !== branch) this.view.description = branch;
    let message: string | undefined;
    if (model.agentConfiguration.status !== 'configured' || model.agentReadiness.status !== 'ready') {
      // Connection progress and recovery belong in Settings, not a separate workbench gate.
      message = undefined;
    } else {
      const preview = model.preview;
      const status = preview?.syncStatus ?? preview?.status;
      const previewProblem = status && ['stale', 'conflict', 'error', 'paused'].includes(status);
      message =
        model.repositoryState === 'loading'
          ? undefined
          : [
              model.busy,
              ...model.errors.filter((error) => ['repository', 'preview'].includes(error.scope)).map((error) => error.message),
              previewProblem
                ? `${previewStatusLabels[status]}: ${preview?.message ?? 'Preview content is not current. Open Show Preview Output for details.'}`
                : '',
              preview?.setup?.status === 'failed' ? 'Preview setup failed. Open Show Preview Output for details, then retry setup.' : '',
            ]
              .filter(Boolean)
              .join('\n') || undefined;
    }
    if (this.view.message !== message) this.view.message = message;

    // Invalidating an unchanged tree makes VS Code reload expanded files and show progress.
    // Include content hashes and review versions, but leave check timestamps and editor drafts out.
    const signature = JSON.stringify({
      fileViewMode: this.mode,
      session: model.session,
      repository: model.repository,
      repositoryState: model.repositoryState,
      branch,
      agentConfiguration: model.agentConfiguration,
      agentReadiness: model.agentReadiness,
      workspaces: model.workspaces,
      checks: model.checks?.checks.map(({ checkedAt: _checkedAt, ...check }) => check),
      checkingRebase: model.checkingRebase,
      errors: model.errors.filter((error) => error.scope.startsWith('task:')),
    });
    if (signature === this.signature) return;
    this.signature = signature;
    this.changed.fire(undefined);
    this.restoreExpansion();
  }

  private restoreExpansion() {
    const pending = this.pendingExpansion;
    if (!pending || this.restoring || this.disposed || !this.view.visible) return;
    const current = () => !this.disposed && this.pendingExpansion === pending;
    this.restoring = (async () => {
      const roots = await this.getChildren();
      if (!current() || !this.view.visible) return;
      const selected = this.model().task?.id;
      const anchor = roots.find((node) => node.kind === 'task' && node.task.id === selected) ?? roots[0];
      if (!anchor) {
        this.pendingExpansion = undefined;
        return;
      }
      // VS Code replaces its data nodes before awaiting expanded descendants, while its
      // menu renderer still holds the old rows. Publish collapsed roots first. reveal()
      // waits for the native refresh promise, providing a barrier without a timed delay.
      if (!pending.published) {
        await this.view.reveal(anchor, { select: false, focus: false, expand: false });
        if (!current()) return;
        pending.published = true;
      }
      for (const node of roots) {
        if (!current() || !this.view.visible) return;
        if (node.kind === 'task' && this.model().workspaces?.some((row) => row.task.id === node.task.id && row.expanded))
          await this.view.reveal(node, { select: false, focus: false, expand: true });
      }
      if (current() && this.view.visible) {
        await this.view.reveal(anchor, { select: false, focus: false, expand: false });
        if (current()) this.pendingExpansion = undefined;
      }
    })()
      .catch((error) => {
        if (current()) {
          this.pendingExpansion = undefined;
          this.report(error);
        }
      })
      .finally(() => {
        this.restoring = undefined;
        this.restoreExpansion();
      });
  }

  async getChildren(node?: SidebarNode): Promise<SidebarNode[]> {
    const model = this.model();
    const session = model.session;
    const scope = `${model.repository}:${model.workflow?.workflow?.developmentBranch ?? ''}:`;
    if (node?.session && node.session !== session) return [];
    if (node?.kind === 'folder') {
      if (this.mode !== 'tree' || model.repositoryState !== 'ready' || model.agentReadiness.status !== 'ready') return [];
      const files = this.files.get(node.task.id);
      return files?.session === session ? this.fileChildren(files.nodes, node.task, session, node.scope ?? scope, node.path) : [];
    }
    const children = await this.children(node);
    if (session !== this.model().session) return [];
    const current = children.map((child) => ({ ...child, session, scope }));
    if (node?.kind === 'task') {
      const files = current.filter((child): child is FileNode & { session: string; scope: string } => child.kind === 'file');
      this.files.set(node.task.id, { session, nodes: files });
      if (files.length && this.mode === 'tree') return this.fileChildren(files, node.task, session, scope);
    }
    if (!children.length && node?.kind === 'task' && node.task.worktree) {
      const error = this.model().workspaces?.find((row) => row.task.id === node.task.id)?.filesError;
      if (error) return [{ kind: 'notice', task: node.task, session, scope, message: error, error: true }];
    }
    return current;
  }

  private fileChildren(files: FileNode[], task: WorkflowTask, session: string, scope: string, directory = ''): SidebarNode[] {
    const prefix = directory ? `${directory}/` : '';
    const folders = new Set<string>();
    const children: FileNode[] = [];
    for (const file of files) {
      if (!file.file.path.startsWith(prefix)) continue;
      const relative = file.file.path.slice(prefix.length);
      const separator = relative.indexOf('/');
      if (separator < 0) children.push(file);
      else folders.add(`${prefix}${relative.slice(0, separator)}`);
    }
    const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    return [
      ...[...folders].sort(compare).map((path): SidebarNode => ({ kind: 'folder', path, task, session, scope })),
      ...children.sort((a, b) => compare(a.file.path, b.file.path)),
    ];
  }

  async select(taskId: string) {
    const node = (await this.getChildren()).find((node) => node.kind === 'task' && node.task.id === taskId);
    if (node) await this.view.reveal(node, { select: true, focus: false, expand: false });
  }

  getParent(node: SidebarNode): SidebarNode | undefined {
    if ((node.kind === 'file' || node.kind === 'folder' || node.kind === 'notice') && node.task) {
      if (this.mode === 'tree' && node.kind !== 'notice') {
        const directory = path.posix.dirname(node.kind === 'file' ? node.file.path : node.path);
        if (directory !== '.') return { kind: 'folder', path: directory, task: node.task, session: node.session, scope: node.scope };
      }
      return { kind: 'task', task: node.task, session: node.session, scope: node.scope };
    }
    return undefined;
  }

  getTreeItem(node: SidebarNode): vscode.TreeItem {
    const model = this.model();
    // VS Code can render a retained node after navigation changes the current model.
    // Its identity must still match the tree that originally published it.
    const prefix = node.scope ?? `${model.repository}:${model.workflow?.workflow?.developmentBranch ?? ''}:`;
    if (node.kind === 'task') {
      const row = model.workspaces?.find((row) => row.task.id === node.task.id);
      const task = row?.task ?? node.task;
      const item = new vscode.TreeItem(
        task.title,
        task.worktree
          ? row?.expanded && !(this.pendingExpansion?.scope === prefix && this.pendingExpansion.session === node.session && !this.pendingExpansion.published)
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      const connected = model.preview?.connectedIds.includes(task.id);
      const sync = model.checks?.checks.find((check) => check.changeId === task.id);
      const errors = model.errors.filter((error) => error.scope === `task:${task.id}`);
      const flags = [task.deletion ? 'deleting' : task.worktree ? 'workspace' : task.status === 'archived' ? 'archived' : 'plan'];
      if (task.workspaceError) flags.push('allocationFailed');
      if (connected) flags.push('connected');
      if (sync && sync.status !== 'current') flags.push(sync.status === 'conflict' ? 'conflict' : 'sync');
      if (task.worktree && task.workspaceHook?.status === 'failed') flags.push('hookFailed');
      if (task.integration) flags.push('recovery');
      if (task.integration && !task.integration.prepared) flags.push('prepareRecovery');
      else if (row?.review?.preparation?.canRecord) flags.push('recordDelivery');
      item.id = `${prefix}task:${task.id}`;
      item.contextValue = `wardenTask:${flags.join(':')}`;
      item.description = errors.length ? `Failed · ${row?.description ?? ''}` : row?.description;
      item.tooltip = [row?.tooltip ?? task.title, task.integration?.error, row?.review?.preparation?.message, ...errors.map((error) => error.message)]
        .filter(Boolean)
        .join('\n\n');
      item.iconPath = new vscode.ThemeIcon(
        errors.length || task.deletion || task.workspaceError || task.integration?.error || sync?.status === 'conflict'
          ? 'warning'
          : model.checkingRebase && sync
            ? 'sync~spin'
            : sync && sync.status !== 'current'
              ? 'sync'
              : connected
                ? 'plug'
                : task.worktree
                  ? 'git-branch'
                  : 'circle-outline',
      );
      item.command = { command: 'warden.selectTask', title: 'Open Task Chat', arguments: [node] };
      return item;
    }
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(path.posix.basename(node.path), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${prefix}folder:${node.task.id}:${node.path}`;
      item.tooltip = node.path;
      item.contextValue = 'wardenFolder';
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    if (node.kind === 'file') {
      const mode = node.file.oldMode === node.file.newMode ? undefined : `File mode ${node.file.oldMode ?? 'none'} → ${node.file.newMode ?? 'none'}`;
      const directory = path.posix.dirname(node.file.path);
      const item = new vscode.TreeItem(path.posix.basename(node.file.path));
      item.id = `${prefix}file:${node.task?.id ?? node.target}:${node.file.path}`;
      item.description = [this.mode === 'list' && directory !== '.' ? directory : undefined, `+${node.file.additions} −${node.file.deletions}`, mode]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = [node.file.path, mode].filter(Boolean).join('\n');
      item.contextValue = 'wardenFile';
      item.iconPath = new vscode.ThemeIcon('diff');
      item.command = { command: 'warden.openDiff', title: 'View Diff', arguments: [node] };
      return item;
    }
    const item = new vscode.TreeItem(node.error ? 'Unable to read changes. Refresh to retry.' : node.message);
    item.id = `${prefix}notice:${node.task.id}`;
    item.tooltip = node.message;
    item.iconPath = new vscode.ThemeIcon(node.error ? 'warning' : 'info');
    if (node.error) item.command = { command: 'warden.refresh', title: 'Refresh', arguments: [node] };
    return item;
  }

  handleDrag(source: readonly SidebarNode[], transfer: vscode.DataTransfer, token: vscode.CancellationToken) {
    this.drag = undefined;
    const node = source[0];
    if (token.isCancellationRequested || source.length !== 1 || node?.kind !== 'task' || node.session !== this.model().session) return;
    this.drag = { session: node.session, taskId: node.task.id, nonce: randomUUID() };
    transfer.set(dragType, new vscode.DataTransferItem(JSON.stringify(this.drag)));
  }

  async handleDrop(target: SidebarNode | undefined, transfer: vscode.DataTransfer, token: vscode.CancellationToken) {
    const drag = this.drag;
    if (!drag || token.isCancellationRequested || drag.session !== this.model().session || (target?.session && target.session !== drag.session)) return;
    if (target && !['task', 'file', 'folder'].includes(target.kind)) return;
    if (target?.kind === 'file' && !target.task) return;
    const value = await transfer.get(dragType)?.asString();
    if (token.isCancellationRequested || drag.session !== this.model().session || value !== JSON.stringify(drag) || drag !== this.drag) return;
    const before = target?.kind === 'task' || target?.kind === 'file' || target?.kind === 'folder' ? (target.task?.id ?? null) : null;
    this.drag = undefined;
    await this.action({ type: 'task.move', taskId: drag.taskId, before }, drag.session);
  }

  dispose() {
    this.disposed = true;
    this.pendingExpansion = undefined;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}
