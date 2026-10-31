import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { FileEntry, TaskReview, WorkflowTask, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { previewStatusLabels } from '@warden/shared';

type Entry =
  | { kind: 'task'; task: WorkflowTask }
  | { kind: 'file'; file: FileEntry; target: string; task?: WorkflowTask; review?: TaskReview }
  | { kind: 'notice'; message: string; error: boolean; task: WorkflowTask };
export type SidebarNode = Entry & { session?: string };

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

  constructor(
    private readonly model: () => WorkbenchModel,
    private readonly children: (node?: SidebarNode) => Promise<SidebarNode[]>,
    private readonly action: (action: WorkbenchAction, session: string) => Promise<unknown>,
    expansion: (node: SidebarNode, expanded: boolean) => Promise<void>,
  ) {
    this.view = vscode.window.createTreeView('warden.task', { treeDataProvider: this, dragAndDropController: this });
    this.subscriptions = [
      this.view.onDidExpandElement(({ element }) => {
        void expansion(element, true);
      }),
      this.view.onDidCollapseElement(({ element }) => {
        void expansion(element, false);
      }),
    ];
  }

  refresh() {
    const model = this.model();
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
  }

  async getChildren(node?: SidebarNode): Promise<SidebarNode[]> {
    const session = this.model().session;
    if (node?.session && node.session !== session) return [];
    const children = await this.children(node);
    if (session !== this.model().session) return [];
    if (!children.length && node?.kind === 'task' && node.task.worktree) {
      const error = this.model().workspaces?.find((row) => row.task.id === node.task.id)?.filesError;
      if (error) return [{ kind: 'notice', task: node.task, session, message: error, error: true }];
    }
    return children.map((child) => ({ ...child, session }));
  }

  async select(taskId: string) {
    const node = (await this.getChildren()).find((node) => node.kind === 'task' && node.task.id === taskId);
    if (node) await this.view.reveal(node, { select: true, focus: false, expand: false });
  }

  getParent(node: SidebarNode): SidebarNode | undefined {
    if ((node.kind === 'file' || node.kind === 'notice') && node.task) return { kind: 'task', task: node.task, session: node.session };
    return undefined;
  }

  getTreeItem(node: SidebarNode): vscode.TreeItem {
    const model = this.model();
    const prefix = `${model.repository}:${model.workflow?.workflow?.developmentBranch ?? ''}:`;
    if (node.kind === 'task') {
      const row = model.workspaces?.find((row) => row.task.id === node.task.id);
      const task = row?.task ?? node.task;
      const item = new vscode.TreeItem(
        task.title,
        task.worktree
          ? row?.expanded
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      const connected = model.preview?.connectedIds.includes(task.id);
      const sync = model.checks?.checks.find((check) => check.changeId === task.id);
      const errors = model.errors.filter((error) => error.scope === `task:${task.id}`);
      const flags = [task.worktree ? 'workspace' : task.status === 'archived' ? 'archived' : 'plan'];
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
        errors.length || task.workspaceError || task.integration?.error || sync?.status === 'conflict'
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
      item.command = { command: 'warden.selectTask', title: 'View Task Changes', arguments: [node] };
      return item;
    }
    if (node.kind === 'file') {
      const mode = node.file.oldMode === node.file.newMode ? undefined : `File mode ${node.file.oldMode ?? 'none'} → ${node.file.newMode ?? 'none'}`;
      const item = new vscode.TreeItem(node.file.path);
      item.id = `${prefix}file:${node.task?.id ?? node.target}:${node.file.path}`;
      item.description = [`+${node.file.additions} −${node.file.deletions}`, mode].filter(Boolean).join(' · ');
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
    if (target && !['task', 'file'].includes(target.kind)) return;
    if (target?.kind === 'file' && !target.task) return;
    const value = await transfer.get(dragType)?.asString();
    if (token.isCancellationRequested || drag.session !== this.model().session || value !== JSON.stringify(drag) || drag !== this.drag) return;
    const before = target?.kind === 'task' || target?.kind === 'file' ? (target.task?.id ?? null) : null;
    this.drag = undefined;
    await this.action({ type: 'task.move', taskId: drag.taskId, before }, drag.session);
  }

  dispose() {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}
