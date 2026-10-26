import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { formatTargetKey, taskReview, sameReview } from '@warden/shared';
import type {
  FileEntry,
  TaskReview,
  HistoryResponse,
  HistoryPreviewResponse,
  HistoryPreviewRequest,
  PreviewResponse,
  RebaseResponse,
  WorkflowResponse,
  WorkflowTask,
  WorktreesResponse,
} from '@warden/shared';
import { Engine, WardenError } from '@warden/engine';
import type { EngineCommand, EngineInput, EngineOutput } from '@warden/engine';
import type { WorkbenchAction, WorkbenchModel, Surface, TaskSection, WorkbenchError, RebaseBatchResponse } from '@warden/shared';
import type { AcpBinding } from '@warden/shared';
import { Documents } from './documents.js';
import { Views } from './views.js';
import { AcpConversations } from './acp/conversations.js';

const statusLabels: Record<string, string> = {
  pending: '待同步',
  updating: '同步中',
  synced: '已同步',
  conflict: '冲突',
  error: '同步失败',
  running: 'setup 运行中',
  succeeded: 'setup 成功',
  failed: 'setup 失败',
  planned: '待分配',
  archived: '已归档',
  current: '已更新',
  disconnected: '仅主目录',
  stale: '待更新',
  paused: '待迁移',
};
const fileModeChange = (file: FileEntry): string | undefined => {
  if (file.oldMode === file.newMode) return undefined;
  return `文件模式 ${file.oldMode ?? '无'} → ${file.newMode ?? '无'}`;
};
type Node =
  | { kind: 'preview' }
  | { kind: 'tasks' }
  | { kind: 'history' }
  | { kind: 'settings' }
  | { kind: 'task'; task: WorkflowTask }
  | { kind: 'file'; file: FileEntry; target: string; task?: WorkflowTask; review?: TaskReview }
  | { kind: 'commit'; sha: string; message: string };

export class Workbench implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private backend?: Engine;
  private data?: WorkflowResponse;
  private preview?: PreviewResponse;
  private history?: HistoryResponse;
  private checks?: RebaseResponse;
  private checkouts?: WorktreesResponse;
  private files = new Map<string, FileEntry[]>();
  private taskTargets = new Map<string, string>();
  private documents: Documents;
  private reviews = new Map<string, TaskReview>();
  private reviewUris = new Map<string, Set<string>>();
  private output = vscode.window.createOutputChannel('Warden');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private active?: Promise<unknown>;
  private reading?: Promise<void>;
  private closing = false;
  private switching = false;
  private navigation = new Set<Promise<unknown>>();

  readonly dragMimeTypes = ['application/vnd.code.tree.warden.workbench'];
  readonly dropMimeTypes = ['application/vnd.code.tree.warden.workbench'];
  private readonly views: Views;
  private readonly tree: vscode.TreeView<Node>;
  private readonly conversations: AcpConversations;
  private selected?: string;
  private expanded: Record<string, boolean> = {};
  private selectedFiles: Record<string, string> = {};
  private taskSection?: WorkbenchModel['taskSection'];
  private creating = false;
  private session = randomUUID();
  private busy?: string;
  private errors = new Map<string, WorkbenchError>();
  private messages: Record<string, string> = {};
  private historyDraft?: HistoryPreviewRequest;
  private historyPreview?: HistoryPreviewResponse;
  private rebaseResult?: RebaseBatchResponse;
  private rebaseSelection?: WorkbenchModel['rebaseSelection'];
  private checkSignature?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.documents = new Documents(context);
    this.conversations = new AcpConversations(
      context,
      (binding) => this.reviewConversation(binding),
      () => this.emitter.fire(undefined),
      (error) => this.output.appendLine(String(error)),
    );
    this.views = new Views(
      context,
      (surface) => this.model(surface),
      (action, session) => this.handleAction(action, session),
      (error, surface) => this.report(error, surface === 'task' ? `task:${this.selected ?? 'new'}` : surface),
    );
    this.tree = vscode.window.createTreeView('warden.workbench', { treeDataProvider: this, dragAndDropController: this });
    context.subscriptions.push(
      this.output,
      this.status,
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider('warden-review', this.documents),
      vscode.workspace.onDidCloseTextDocument((doc) => this.documents.remove(doc.uri)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('warden.previewCommand')) this.views.render();
      }),
      this.tree,
      this.tree.onDidExpandElement(({ element }) => this.rememberExpansion(element, true)),
      this.tree.onDidCollapseElement(({ element }) => this.rememberExpansion(element, false)),
      this.views,
      vscode.window.registerWebviewViewProvider('warden.task', this.views),
    );
    this.status.command = 'warden.showPreview';
    const commands: Record<string, (node?: Node) => unknown> = {
      selectRepository: () => this.selectRepository(),
      refresh: () => this.refresh(),
      configure: () => this.configure(),
      createTask: () => this.createTask(),
      taskActions: (node) => this.selectTask(node),
      selectTask: (node) => this.selectTask(node),
      startTask: (node) => this.startTask(node),
      editTask: (node) => this.selectTask(node, false, 'edit'),
      moveTask: (node) => this.moveTask(node),
      connect: (node) => this.connect(node),
      openDiff: (node) => this.openDiff(node),
      deliver: (node) => this.selectTask(node, false, 'commit'),
      openWorkspace: (node) => this.openWorkspace(node),
      retryHook: (node) => this.taskOperation(node, 'task.hook'),
      resumeTask: (node) => this.taskOperation(node, 'task.resume'),
      previewTerminal: () => this.previewTerminal(),
      runPreview: () => this.runPreview(),
      previewPath: () => this.previewPath(),
      refreshPreview: () => this.api('preview.refresh', undefined),
      setup: () => this.setup(),
      configureScripts: () => this.views.show('settings'),
      rebase: (node) => this.showRebase(node),
      syncTask: (node) => this.showRebase(node),
      syncConflict: (node) => this.showRebase(node),
      editHistory: () => this.views.show('history'),
      taskDetails: (node) => this.selectTask(node, false, 'details'),
      copyWorkspace: (node) => this.copyWorkspace(node),
      importNotes: () => this.importNotes(),
      showPreview: () => this.views.show('preview'),
      copyLocation: () => this.documents.copyLocation(),
      chat: (node) => this.openConversation(node),
      configureAgents: () => vscode.commands.executeCommand('workbench.action.openSettings', 'warden.acpAgents'),
      sendSelectionToAgent: () => this.sendSelectionToAgent(),
    };
    const navigation = new Set([
      'refresh',
      'selectTask',
      'taskActions',
      'editTask',
      'deliver',
      'openDiff',
      'configureScripts',
      'editHistory',
      'taskDetails',
      'copyWorkspace',
      'openWorkspace',
      'showPreview',
      'copyLocation',
      'chat',
      'configureAgents',
      'sendSelectionToAgent',
    ]);
    for (const [name, action] of Object.entries(commands))
      context.subscriptions.push(
        vscode.commands.registerCommand(`warden.${name}`, (node?: Node) =>
          this.perform(() => action(node), navigation.has(name) ? undefined : '正在执行操作…', node?.kind === 'task' ? `task:${node.task.id}` : 'repository'),
        ),
      );
  }
  private api<K extends EngineCommand>(command: K, request: EngineInput<K>): Promise<EngineOutput<K>> {
    if (!this.backend) throw new Error('请先运行 Warden: 选择仓库');
    return this.backend.execute(command, request);
  }
  private async perform(action: () => unknown, busy?: string, scope = 'repository') {
    if (!vscode.workspace.isTrusted) {
      this.report(new Error('请先信任此工作区'), scope);
      return;
    }
    if (this.closing) return;
    if (this.switching) {
      this.report(new Error('正在切换仓库，请稍后重试'), scope);
      return;
    }
    if (busy && this.active) {
      this.report(new WardenError(409, '另一个操作正在进行，请等待结果后重试', 'operation_busy'), scope);
      return;
    }
    this.errors.delete(scope);
    const operation = Promise.resolve().then(action);
    if (!busy) this.navigation.add(operation);
    if (busy) {
      this.active = operation;
      this.busy = busy;
      this.views.render();
    }
    try {
      return await operation;
    } catch (error) {
      this.report(error, scope);
    } finally {
      this.navigation.delete(operation);
      if (!this.closing) await this.refresh(!!busy).catch((error) => this.report(error));
      if (this.active === operation) {
        this.active = undefined;
        this.busy = undefined;
      }
      this.views.render();
    }
  }
  private report(error: unknown, scope = 'repository') {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof WardenError ? error.code : undefined;
    this.errors.set(scope, { scope, message, code });
    this.output.appendLine(`${code ?? 'error'}: ${message}`);
    this.views.render();
    if (!this.views.displaysError(scope)) void vscode.window.showErrorMessage(`Warden: ${message}`);
  }
  async initialize() {
    const folders = vscode.workspace.workspaceFolders;
    const remembered = this.context.workspaceState.get<string>('warden.repository');
    const folder = folders?.find((candidate) => candidate.uri.fsPath === remembered) ?? (folders?.length === 1 ? folders[0] : undefined);
    if (folder) {
      try {
        await this.open(folder.uri.fsPath);
      } catch (error) {
        this.output.appendLine(String(error));
      }
    }
  }
  private async open(directory: string) {
    this.switching = true;
    this.session = randomUUID();
    this.status.hide();
    await this.updateContext();
    try {
      await Promise.allSettled([...this.navigation]);
      await this.reading;
      await this.backend?.close();
      this.backend = await Engine.open(directory);
      this.selected = this.context.workspaceState.get<string>(`warden.selected:${this.backend.root}`);
      this.expanded = this.context.workspaceState.get<Record<string, boolean>>(`warden.expanded:${this.backend.root}`, {});
      this.selectedFiles = this.context.workspaceState.get<Record<string, string>>(`warden.files:${this.backend.root}`, {});
      this.taskSection = undefined;
      this.rebaseSelection = undefined;
      this.messages = this.context.workspaceState.get<Record<string, string>>(`warden.messages:${this.backend.root}`, {});
      this.historyDraft = this.context.workspaceState.get<HistoryPreviewRequest>(`warden.history:${this.backend.root}`);
      this.historyPreview = undefined;
      this.errors.clear();
      this.checkSignature = undefined;
      this.rebaseResult = undefined;
      this.creating = false;
      await this.context.workspaceState.update('warden.repository', this.backend.root);
      this.data = undefined;
      this.preview = undefined;
      this.history = undefined;
      this.checks = undefined;
      this.checkouts = undefined;
      this.files.clear();
      this.taskTargets.clear();
      this.reviews.clear();
      this.reviewUris.clear();
      await this.refresh();
    } catch (error) {
      await this.backend?.close();
      this.backend = undefined;
      throw error;
    } finally {
      this.switching = false;
      await this.updateContext();
      if (!this.backend) this.tree.description = undefined;
      this.emitter.fire(undefined);
      this.views.render();
    }
  }
  private async selectRepository() {
    const selected = await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择主目录所在的仓库' });
    if (selected) await this.open(selected.uri.fsPath);
  }
  private async updateContext() {
    const hasRepository = !!this.backend && !this.switching;
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'warden.hasRepository', hasRepository),
      vscode.commands.executeCommand('setContext', 'warden.hasDevelopmentBranch', hasRepository && !!this.data?.workflow),
      vscode.commands.executeCommand('setContext', 'warden.multipleRoots', (vscode.workspace.workspaceFolders?.length ?? 0) > 1),
    ]);
  }
  refresh(afterMutation = false): Promise<void> {
    // A read begun before a write cannot acknowledge that write to the next user action.
    if (this.reading) return afterMutation ? this.reading.catch(() => {}).then(() => this.refresh()) : this.reading;
    if (!this.backend || this.closing) return Promise.resolve();
    this.reading = (async () => {
      const [data, preview, checkouts] = await Promise.all([
        this.api('workflow.get', undefined),
        this.api('preview.get', undefined),
        this.api('workspaces.list', undefined),
      ]);
      const changedHead = data.developmentHead !== this.data?.developmentHead;
      let changed = JSON.stringify([data, preview, checkouts]) !== JSON.stringify([this.data, this.preview, this.checkouts]);
      this.data = data;
      this.preview = preview;
      this.checkouts = checkouts;
      if (data.workflow && (changedHead || !this.history)) this.history = await this.api('history.get', undefined);
      const checkSignature = JSON.stringify([
        data.developmentHead,
        checkouts.worktrees.map((row) => [row.path, row.head, row.branch, row.dirty, row.busy]),
        data.workflow?.changes.map((task) => [task.id, task.base, task.worktree ? task.sourceBase : undefined]),
      ]);
      if (data.workflow && checkSignature !== this.checkSignature) {
        this.checks = await this.api('rebase.check', undefined);
        this.checkSignature = checkSignature;
      }
      this.tree.description = data.workflow?.developmentBranch ?? path.basename(this.backend!.root);
      await this.updateContext();
      this.views.render();
      for (const key of this.files.keys()) {
        try {
          const response = await this.api('review.files', { key });
          if (JSON.stringify(response.files) !== JSON.stringify(this.files.get(key))) changed = true;
          this.files.set(key, response.files);
        } catch {
          this.files.delete(key);
          changed = true;
        }
      }
      this.status.text = `$(layers) Warden: ${statusLabels[preview.syncStatus ?? preview.status] ?? preview.status}${preview.setup?.status === 'failed' ? ' · setup 失败' : ''}`;
      this.status.tooltip = `运行目录：${preview.worktree ?? '尚未初始化'}\n${preview.message ?? '主目录保存后自动同步至预览'}\n${data.error ?? ''}`;
      if (data.workflow) this.status.show();
      else this.status.hide();
      if (changed) this.emitter.fire(undefined);
      if (data.workflow)
        await this.backend!.start(
          () => this.refresh(),
          (error) => {
            this.output.appendLine(String(error));
            if (!(error instanceof WardenError && error.code === 'operation_locked')) {
              this.errors.set('repository', { scope: 'repository', message: String(error) });
              this.views.render();
            }
          },
        );
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'settings') {
      const item = new vscode.TreeItem('设置');
      item.id = node.kind;
      item.iconPath = new vscode.ThemeIcon('settings-gear');
      item.command = { command: 'warden.configureScripts', title: '设置' };
      return item;
    }
    if (node.kind === 'tasks' || node.kind === 'history') {
      const item = new vscode.TreeItem(
        node.kind === 'tasks' ? '任务' : '提交历史',
        node.kind === 'tasks' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = node.kind;
      item.contextValue = node.kind;
      item.iconPath = new vscode.ThemeIcon(node.kind === 'tasks' ? 'list-ordered' : 'history');
      if (node.kind === 'history') item.command = { command: 'warden.editHistory', title: '查看提交历史' };
      return item;
    }
    if (node.kind === 'preview') {
      const item = new vscode.TreeItem('预览运行目录');
      item.id = 'preview';
      item.contextValue = 'preview';
      item.iconPath = new vscode.ThemeIcon('layers');
      item.description = [
        statusLabels[this.preview?.syncStatus ?? this.preview?.status ?? 'disconnected'],
        this.preview?.setup ? statusLabels[this.preview.setup.status] : '',
      ]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = `${this.preview?.worktree ?? '点击初始化'}\n${this.preview?.message ?? ''}`;
      item.command = { command: 'warden.showPreview', title: '查看预览' };
      return item;
    }
    if (node.kind === 'task') {
      const task = node.task;
      const item = new vscode.TreeItem(
        task.title,
        task.worktree
          ? this.expanded[task.id]
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `task:${task.id}`;
      item.contextValue = task.worktree ? (this.preview?.connectedIds.includes(task.id) ? 'task-connected' : 'task') : 'plan';
      const source = this.preview?.sources?.find((s) => s.changeId === task.id);
      const connected = this.preview?.connectedIds.includes(task.id);
      const sync = this.checks?.checks.find((c) => c.changeId === task.id);
      if (task.worktree && sync && sync.status !== 'current') item.contextValue += sync.status === 'conflict' ? '-conflict' : '-sync';
      const connection = task.worktree ? (connected ? (source ? statusLabels[source.status] : '待同步') : '未连接') : statusLabels[task.status];
      const connectionProblem = source?.status === 'conflict' || source?.status === 'error';
      const activity = this.backend && this.conversations.activity(this.backend.root, task.id);
      const facts = [
        activity === 'Agent 等待授权' ? activity : '',
        task.integration?.error ? '提交失败' : '',
        connectionProblem ? connection : '',
        this.reviews.has(task.id) && !sameReview(this.reviews.get(task.id), taskReview(this.data!, task.id, this.checkouts?.worktrees ?? []))
          ? '审阅版本已变化'
          : '',
        task.worktree && task.workspaceHook?.status === 'failed' ? '初始化失败' : '',
        activity !== 'Agent 等待授权' ? activity : '',
        task.status === 'integrating' ? '待提交' : '',
        !connectionProblem ? connection : '',
        task.agent,
      ].filter(Boolean);
      item.description = facts.slice(0, 2).join(' · ');
      item.iconPath = new vscode.ThemeIcon(connected ? 'plug' : task.worktree ? 'git-branch' : 'circle-outline');
      item.tooltip = [task.title, task.body, task.worktree ?? '尚未分配工作区', facts.join(' · '), sync?.status !== 'current' ? sync?.message : '']
        .filter(Boolean)
        .join('\n\n');
      item.command = { command: 'warden.selectTask', title: '查看任务变更', arguments: [node] };
      return item;
    }
    if (node.kind === 'commit') {
      const item = new vscode.TreeItem(node.message.split('\n')[0]!, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `commit:${node.sha}`;
      item.description = node.sha.slice(0, 8);
      item.iconPath = new vscode.ThemeIcon('git-commit');
      return item;
    }
    const item = new vscode.TreeItem(node.file.path);
    item.id = `file:${node.target}:${node.file.path}`;
    item.contextValue = 'reviewFile';
    item.description = [`+${node.file.additions} −${node.file.deletions}`, fileModeChange(node.file)].filter(Boolean).join(' · ');
    item.tooltip = [node.file.path, fileModeChange(node.file)].filter(Boolean).join('\n');
    item.iconPath = new vscode.ThemeIcon('diff');
    item.command = { command: 'warden.openDiff', title: '查看差异', arguments: [node] };
    return item;
  }
  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.backend || this.switching || !this.data?.workflow) return [];
    if (!node) return [{ kind: 'preview' }, { kind: 'history' }, { kind: 'tasks' }, { kind: 'settings' }];
    if (node.kind === 'tasks') return this.tasks().map((task) => ({ kind: 'task', task }));
    if (node.kind === 'history')
      return (this.history?.commits ?? [])
        .slice()
        .reverse()
        .map((c) => ({ kind: 'commit', sha: c.sha, message: c.message }));
    let target: string;
    let review: TaskReview | undefined;
    if (node.kind === 'task' && node.task.worktree) {
      review = await this.readReview(node.task.id);
      if (!review) return [];
      target = review.targetKey;
      const previous = this.taskTargets.get(node.task.id);
      if (previous && previous !== target) this.files.delete(previous);
      this.taskTargets.set(node.task.id, target);
    } else if (node.kind === 'commit') target = formatTargetKey({ kind: 'commit', sha: node.sha });
    else return [];
    try {
      const response = await this.api('review.files', { key: target });
      this.files.set(target, response.files);
      return response.files.map((file) => ({ kind: 'file', file, target, ...(node.kind === 'task' ? { task: node.task, review } : {}) }));
    } catch (error) {
      this.output.appendLine(String(error));
      return [];
    }
  }
  private tasks() {
    return this.data?.workflow?.changes.filter((c) => c.developmentBranch === this.data?.workflow?.developmentBranch) ?? [];
  }
  getParent(node: Node): Node | undefined {
    if (node.kind === 'task') return { kind: 'tasks' };
    if (node.kind === 'file' && node.task) return { kind: 'task', task: node.task };
    if (node.kind === 'commit') return { kind: 'history' };
    return undefined;
  }
  private async readReview(changeId: string) {
    const [data, checkouts] = await Promise.all([this.api('workflow.get', undefined), this.api('workspaces.list', undefined)]);
    return taskReview(data, changeId, checkouts.worktrees);
  }
  private async rememberReview(review: TaskReview) {
    const previous = this.reviews.get(review.changeId);
    if (!sameReview(previous, review)) {
      const uris = this.reviewUris.get(review.changeId);
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && uris?.has(tab.input.modified.toString()));
      await vscode.window.tabGroups.close(tabs, true);
      this.reviewUris.delete(review.changeId);
    }
    this.reviews.set(review.changeId, review);
  }
  private async pickTask(node?: Node) {
    const task = node?.kind === 'task' ? node.task : node?.kind === 'file' ? node.task : undefined;
    if (task) return this.tasks().find((c) => c.id === task.id);
    const picked = await vscode.window.showQuickPick(
      this.tasks().map((task) => ({ label: task.title, task })),
      { placeHolder: '选择任务' },
    );
    return picked?.task;
  }
  private async configure() {
    const list = await this.api('workspaces.list', undefined);
    const branch = await vscode.window.showQuickPick(
      list.branches.map((b) => b.name),
      { placeHolder: '选择主目录当前检出的主开发分支' },
    );
    if (branch) {
      await this.api('workflow.configure', { branch });
      await this.api('preview.refresh', undefined);
    }
  }
  private async createTask() {
    if (!this.data?.workflow) await this.configure();
    if (!(await this.api('workflow.get', undefined)).workflow) return;
    this.creating = true;
    this.selected = undefined;
    this.taskSection = undefined;
    this.views.render();
    await this.views.show('task');
  }
  private async rememberExpansion(node: Node, expanded: boolean) {
    if (node.kind !== 'task' || !this.backend) return;
    this.expanded[node.task.id] = expanded;
    await this.context.workspaceState.update(`warden.expanded:${this.backend.root}`, this.expanded);
  }
  private async selectTask(node?: Node, openFile = true, section?: TaskSection, refreshReview = false) {
    const task = await this.pickTask(node);
    if (!task) return;
    if (this.selected !== task.id) this.taskSection = undefined;
    this.selected = task.id;
    this.creating = false;
    if (section) this.taskSection = { request: randomUUID(), section };
    await this.context.workspaceState.update(`warden.selected:${this.backend!.root}`, task.id);
    this.views.render();
    await this.views.show('task');
    if (openFile && task.worktree) {
      const uris = this.reviewUris.get(task.id);
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && uris?.has(tab.input.modified.toString()));
      const lastUri = uris && [...uris].at(-1);
      const existing =
        tabs.find((tab) => tab.isActive) ??
        tabs.find((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === lastUri) ??
        tabs.at(-1);
      // Selecting or collapsing a row must not replace the user's pinned diff or scroll position.
      // Refreshing a stale review is a separate explicit action in the task form/file list.
      if (!refreshReview && existing?.input instanceof vscode.TabInputTextDiff) {
        if (!existing.isActive)
          await vscode.commands.executeCommand('vscode.diff', existing.input.original, existing.input.modified, existing.label, {
            viewColumn: existing.group.viewColumn,
          });
        return;
      }
      const files = await this.getChildren({ kind: 'task', task });
      const file = files.find((entry) => entry.kind === 'file' && entry.file.path === this.selectedFiles[task.id]) ?? files[0];
      if (file) await this.openDiff(file);
    }
  }
  private async startTask(node?: Node) {
    const task = await this.pickTask(node);
    if (!task || task.worktree || task.status === 'archived') return;
    await this.api('task.start', { taskId: task.id, kind: 'shared' });
    await this.selectTask({ kind: 'task', task }, false);
  }
  private async moveTask(node?: Node) {
    const task = await this.pickTask(node);
    if (!task) return;
    const before = await vscode.window.showQuickPick([
      { label: '移到末尾', id: null as string | null },
      ...this.tasks()
        .filter((t) => t.id !== task.id)
        .map((t) => ({ label: `移到「${t.title}」之前`, id: t.id })),
    ]);
    if (before) await this.api('task.move', { taskId: task.id, before: before.id });
  }
  private async connect(node?: Node) {
    const task = await this.pickTask(node);
    if (!task?.worktree) return;
    const current = await this.api('preview.get', undefined);
    await this.api('preview.connect', {
      connectedIds: current.connectedIds.includes(task.id) ? current.connectedIds.filter((id) => id !== task.id) : [...current.connectedIds, task.id],
    });
  }
  private async openDiff(node?: Node) {
    if (node?.kind !== 'file') return;
    if (node.task) {
      if (this.selected !== node.task.id) this.taskSection = undefined;
      this.selected = node.task.id;
      this.creating = false;
      this.selectedFiles[node.task.id] = node.file.path;
      await this.context.workspaceState.update(`warden.selected:${this.backend!.root}`, node.task.id);
      await this.context.workspaceState.update(`warden.files:${this.backend!.root}`, this.selectedFiles);
    }
    const review = node.review;
    if (node.task && (!review || !sameReview(review, await this.readReview(node.task.id)))) throw new Error('审查版本已变化，请刷新文件列表并重新打开差异');
    const key = node.target;
    const latest = (await this.api('review.files', { key })).files.find((f) => f.path === node.file.path);
    if (!latest) throw new Error('文件差异已变化，请刷新');
    if (latest.binary) {
      if (review) await this.rememberReview(review);
      void vscode.window.showInformationMessage(
        `此文件包含二进制变化，请使用外部工具审查此版本：${review?.sourceHead ?? review?.preparation?.head ?? node.target}`,
      );
      return;
    }
    const read = (side: 'old' | 'new') => this.api('review.file', { key, file: side === 'old' ? (latest.oldPath ?? latest.path) : latest.path, side });
    const [old, current] = await Promise.all([read('old'), read('new')]);
    const after = (await this.api('review.files', { key })).files.find((f) => f.path === latest.path);
    if (after?.contentHash !== latest.contentHash) throw new Error('读取期间文件发生变化，请重新打开差异');
    if (review) {
      if (!sameReview(review, await this.readReview(review.changeId))) throw new Error('读取期间审查版本发生变化，请重新打开差异');
      await this.rememberReview(review);
    }
    const left = await this.documents.add(path.basename(latest.oldPath ?? latest.path), old.content ?? '', this.backend!.root, latest.oldPath ?? latest.path);
    const right = await this.documents.add(path.basename(latest.path), current.content ?? '', this.backend!.root, latest.path);
    if (review) {
      const uris = this.reviewUris.get(review.changeId) ?? new Set<string>();
      uris.add(right.toString());
      this.reviewUris.set(review.changeId, uris);
    }
    const version = review?.sourceHead ?? review?.preparation?.head;
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      [node.task?.title ?? '提交', latest.path, fileModeChange(latest), version?.slice(0, 8)].filter(Boolean).join(' · '),
      { preview: true },
    );
    this.views.render();
  }
  private async deliver(node?: Node, submittedMessage?: string) {
    const task = await this.pickTask(node);
    if (!task?.worktree) return;
    const current = await this.readReview(task.id);
    if (task.integration && !task.integration.prepared && !current?.preparation) {
      await this.api('task.prepare', { taskId: task.id, sourceHead: task.integration.source, developmentHead: task.integration.parent });
      this.reviews.delete(task.id);
      void vscode.window.showInformationMessage('提交准备已恢复，请重新打开差异审查主目录中保留的内容。');
      return;
    }
    const review = this.reviews.get(task.id);
    if (!review || !sameReview(review, current)) throw new Error('请重新打开任务差异，完整审查当前版本后再交付');
    const p = review.preparation;
    if (p?.canRecord && p.head) {
      await this.api('task.accept', { taskId: task.id, mode: 'record', commit: p.head });
      this.reviews.delete(task.id);
      return;
    }
    if (p ? !p.canCommit : !review.sourceHead || !review.developmentHead) throw new Error(p?.message ?? '请先在任务工作区提交变更，再重新打开差异审查');
    const message = submittedMessage ?? this.messages[task.id] ?? task.title;
    if (!message?.trim()) return;
    if (!sameReview(review, await this.readReview(task.id))) throw new Error('审查版本已变化，请重新打开差异后交付');
    if (p) {
      await this.api('task.accept', { taskId: task.id, mode: 'commit', developmentHead: p.head!, indexFingerprint: p.indexFingerprint!, message });
    } else {
      await this.api('task.deliver', {
        taskId: task.id,
        sourceHead: review.sourceHead!,
        sourceBase: review.sourceBase,
        developmentHead: review.developmentHead!,
        message,
      });
    }
    this.reviews.delete(task.id);
  }
  private async taskOperation(node: Node | undefined, operation: 'task.hook' | 'task.resume') {
    const task = await this.pickTask(node);
    if (task) await this.api(operation, { taskId: task.id });
  }
  private async ensurePreview() {
    let preview = await this.api('preview.get', undefined);
    if (!preview.worktree) preview = await this.api('preview.refresh', undefined);
    if (!preview.worktree) throw new Error(preview.message ?? '请先选择主开发分支并初始化预览');
    return preview;
  }
  private async previewTerminal() {
    const preview = await this.ensurePreview();
    vscode.window
      .createTerminal({ name: 'Warden · 预览', cwd: preview.worktree, env: { WARDEN_PREVIEW: preview.worktree!, WARDEN_REPO: this.backend!.root } })
      .show();
  }
  private async previewPath() {
    const preview = await this.ensurePreview();
    await vscode.env.clipboard.writeText(preview.worktree!);
    return preview.worktree;
  }
  private async runPreview() {
    const preview = await this.ensurePreview();
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.backend!.root));
    const command = vscode.workspace.getConfiguration('warden', folder).get<string>('previewCommand');
    if (!command?.trim()) {
      await this.previewTerminal();
      return;
    }
    const task = new vscode.Task(
      { type: 'warden' },
      folder ?? vscode.TaskScope.Workspace,
      '运行预览',
      'Warden',
      new vscode.ShellExecution(command, { cwd: preview.worktree }),
      [],
    );
    await vscode.tasks.executeTask(task);
  }
  private async setup() {
    const result = await this.api('preview.setup', undefined);
    this.output.appendLine(result.setup?.output ?? '尚未配置 setup 脚本');
    this.output.show(true);
  }
  private async showRebase(node?: Node) {
    this.rebaseSelection = { request: randomUUID(), taskIds: node?.kind === 'task' ? [node.task.id] : [] };
    await this.views.show('rebase');
    this.checks = await this.api('rebase.check', undefined);
    this.views.render();
  }
  private async copyWorkspace(node?: Node) {
    const task = await this.pickTask(node);
    if (task?.worktree) await vscode.env.clipboard.writeText(task.worktree);
  }
  private async openWorkspace(node?: Node) {
    const task = await this.pickTask(node);
    if (task?.worktree) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.worktree), { forceNewWindow: true });
  }
  private async openConversation(node?: Node) {
    const task = await this.pickTask(node);
    if (!task?.worktree || !this.backend) throw new Error('请先为任务创建工作区');
    await this.conversations.show(this.backend.root, task.id);
  }
  private async reviewConversation(binding: AcpBinding) {
    await this.perform(
      async () => {
        if (this.backend?.root !== binding.repository) await this.open(binding.repository);
        await this.refresh();
        const task = this.tasks().find((row) => row.id === binding.taskId && row.worktree === binding.workspace);
        if (!task) throw new Error('任务已不属于当前主开发分支，请先切回对应主开发分支');
        await this.selectTask({ kind: 'task', task });
      },
      '正在打开任务审阅…',
      `task:${binding.taskId}`,
    );
  }
  private async sendSelectionToAgent() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('请先选择要引用的文本');
    const text = editor.document.getText(editor.selection);
    if (text.length > 80_000) throw new Error('选区过长，请缩小后重试');
    const uri = editor.document.uri;
    const source = uri.scheme === 'warden-review' ? await this.documents.snapshot(uri) : undefined;
    const origin = source
      ? `审阅快照（只读）：${source.repository} / ${source.path}\n快照：${uri.toString()}`
      : `文件：${uri.toString()}${editor.document.isDirty ? '（包含未保存内容，只作为引用）' : ''}`;
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + (editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line ? 0 : 1);
    const task = await this.pickTask();
    if (!task?.worktree || !this.backend) throw new Error('请选择已创建工作区的任务');
    await this.conversations.append(this.backend.root, task.id, `${origin}\n行：${start}–${end}\n以下内容仅作为上下文引用：\n\n${text}`);
  }
  private async importNotes() {
    const selected = await vscode.window.showQuickPick(
      (this.data?.legacyTodos ?? []).map((todo) => ({ label: todo.title, description: todo.branch, todo })),
      { canPickMany: true, placeHolder: '选择旧笔记导入当前计划' },
    );
    for (const item of selected ?? []) await this.api('task.import', { taskId: item.todo.id });
  }

  private model(surface: Surface): WorkbenchModel {
    const task = this.creating ? undefined : this.tasks().find((row) => row.id === this.selected);
    const review = task ? this.reviews.get(task.id) : undefined;
    const folder = this.backend ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.backend.root)) : undefined;
    const previewCommand = vscode.workspace.getConfiguration('warden', folder).get<unknown>('previewCommand');
    return {
      session: this.session,
      repository: this.switching ? '' : (this.backend?.root ?? ''),
      surface,
      workflow: this.data,
      task,
      creating: this.creating,
      taskSection: this.taskSection,
      preview: this.preview,
      hasPreviewCommand: typeof previewCommand === 'string' && !!previewCommand.trim(),
      history: this.history,
      historyDraft: this.historyDraft,
      historyPreview: this.historyPreview,
      checks: this.checks,
      rebaseResult: this.rebaseResult,
      rebaseSelection: this.rebaseSelection,
      review,
      reviewCurrent: !!task && !!this.data && sameReview(review, taskReview(this.data, task.id, this.checkouts?.worktrees ?? [])),
      message: task ? (this.messages[task.id] ?? task.title) : '',
      busy: this.busy,
      errors: [...this.errors.values()],
    };
  }
  private async saveDraft() {
    if (this.backend) await this.context.workspaceState.update(`warden.history:${this.backend.root}`, this.historyDraft);
  }
  private async handleAction(action: WorkbenchAction, session: string) {
    if (session !== this.session || this.switching) throw new Error('仓库已切换，请使用当前界面重试');
    if (action.type === 'setup.repository' || action.type === 'setup.branch') {
      await this.perform(() => (action.type === 'setup.repository' ? this.selectRepository() : this.configure()), '正在选择…');
      return;
    }
    if (!this.backend) throw new Error('请先选择仓库');
    const taskId = 'taskId' in action ? action.taskId : undefined;
    const task = taskId ? this.tasks().find((row) => row.id === taskId) : undefined;
    if (taskId && !task) throw new Error('任务已不属于当前主开发分支');
    const node: Node | undefined = task ? { kind: 'task', task } : undefined;
    const scope = action.type.startsWith('task.') ? `task:${taskId ?? 'new'}` : action.type.split('.')[0]!;
    // Draft edits do not queue behind Git operations and cannot change their pinned inputs.
    if (action.type === 'task.message') {
      this.messages[action.taskId] = action.message;
      await this.context.workspaceState.update(`warden.messages:${this.backend.root}`, this.messages);
      return;
    }
    if (action.type === 'history.draft') {
      this.historyDraft = action.draft;
      this.historyPreview = undefined;
      await this.saveDraft();
      this.views.render();
      return;
    }
    const navigation = ['task.review', 'task.open', 'task.copy', 'task.brief', 'task.chat', 'preview.copy', 'preview.terminal', 'settings.agents'];
    await this.perform(
      async () => {
        // A queued message must never be interpreted in the next repository session.
        if (session !== this.session) throw new Error('仓库已切换');
        switch (action.type) {
          case 'task.create': {
            const created = await this.api('task.create', { title: action.title, body: action.body });
            this.selected = created.id;
            this.creating = false;
            await this.context.workspaceState.update(`warden.selected:${this.backend!.root}`, created.id);
            break;
          }
          case 'task.update':
            await this.api('task.update', { taskId: action.taskId, title: action.title, body: action.body });
            break;
          case 'task.restore':
            await this.api('task.update', { taskId: action.taskId, status: 'planned' });
            break;
          case 'task.start':
            await this.api('task.start', { taskId: action.taskId, kind: action.kind, agent: action.agent });
            break;
          case 'task.review':
            await this.selectTask(node, true, undefined, true);
            break;
          case 'task.open':
            await this.openWorkspace(node);
            break;
          case 'task.chat':
            await this.openConversation(node);
            break;
          case 'task.copy':
            await this.copyWorkspace(node);
            break;
          case 'task.brief':
            await vscode.env.clipboard.writeText(
              [
                `# ${task!.title}`,
                task!.body,
                task!.acceptance && `验收说明：${task!.acceptance}`,
                task!.agent && `执行者：${task!.agent}`,
                `工作区：${task!.worktree ?? '尚未创建'}`,
                `主开发分支：${task!.developmentBranch}`,
                '在任务工作区修改和提交代码；用户在独立预览目录验证，并在 Warden 中审阅后交付。',
              ]
                .filter(Boolean)
                .join('\n\n'),
            );
            break;
          case 'task.deliver':
            await this.deliver(node, action.message);
            break;
          case 'task.hook':
          case 'task.resume':
            await this.taskOperation(node, action.type);
            break;
          case 'preview.refresh':
            await this.api('preview.refresh', undefined);
            break;
          case 'preview.setup':
            await this.setup();
            break;
          case 'preview.terminal':
            await this.previewTerminal();
            break;
          case 'preview.run':
            await this.runPreview();
            break;
          case 'preview.copy':
            await this.previewPath();
            break;
          case 'settings.save':
            await this.api('config.save', action.config);
            void vscode.window.showInformationMessage('脚本配置已保存');
            break;
          case 'settings.agents':
            await vscode.commands.executeCommand('workbench.action.openSettings', 'warden.acpAgents');
            break;
          case 'rebase.check':
            this.checks = await this.api('rebase.check', undefined);
            break;
          case 'rebase.run':
            this.rebaseResult = await this.api('rebase.run', { items: action.items });
            this.checks = await this.api('rebase.check', undefined);
            break;
          case 'history.discard':
            this.historyDraft = undefined;
            this.historyPreview = undefined;
            await this.saveDraft();
            break;
          case 'history.preview': {
            const candidate = JSON.stringify(action.draft);
            this.historyDraft = action.draft;
            this.historyPreview = undefined;
            await this.saveDraft();
            const result = await this.api('history.preview', action.draft);
            // Typing while replay runs invalidates the candidate instead of authorizing newer edits.
            if (candidate === JSON.stringify(this.historyDraft)) this.historyPreview = result;
            break;
          }
          case 'history.apply': {
            const candidate = this.historyPreview;
            const appliedDraft = JSON.stringify(this.historyDraft);
            if (!candidate?.canApply || candidate.id !== action.id || candidate.head !== action.head) throw new Error('历史草稿已变化，请重新预览');
            await this.api('history.apply', { id: action.id, head: action.head });
            if (JSON.stringify(this.historyDraft) === appliedDraft) this.historyDraft = undefined;
            this.historyPreview = undefined;
            await this.saveDraft();
            this.reviews.clear();
            break;
          }
        }
      },
      navigation.includes(action.type) ? undefined : '正在执行操作…',
      scope,
    );
  }

  handleDrag(source: readonly Node[], transfer: vscode.DataTransfer) {
    const task = source.find((node) => node.kind === 'task');
    if (task?.kind === 'task') transfer.set(this.dragMimeTypes[0]!, new vscode.DataTransferItem({ session: this.session, taskId: task.task.id }));
  }
  async handleDrop(target: Node | undefined, transfer: vscode.DataTransfer) {
    const value = transfer.get(this.dropMimeTypes[0]!)?.value as { session?: string; taskId?: string } | undefined;
    if (!value || value.session !== this.session || !this.tasks().some((task) => task.id === value.taskId)) return;
    if (target && target.kind !== 'task' && target.kind !== 'tasks') return;
    if (target?.kind === 'task' && target.task.id === value.taskId) return;
    await this.perform(() => this.api('task.move', { taskId: value.taskId!, before: target?.kind === 'task' ? target.task.id : null }), '正在调整计划顺序…');
  }
  async close() {
    this.closing = true;
    await this.conversations.close();
    await Promise.allSettled([this.active, ...this.navigation, this.reading]);
    await this.backend?.close();
  }
}
