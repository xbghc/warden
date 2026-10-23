import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { formatTargetKey, taskReview, sameReview } from '@warden/shared';
import type {
  FileEntry,
  TaskReview,
  FilesResponse,
  FullFileResponse,
  HistoryResponse,
  HistoryPreviewResponse,
  HistoryPreviewRequest,
  PreviewResponse,
  RebaseResponse,
  WorkflowResponse,
  WorkflowTask,
  WorktreesResponse,
  WorkspaceConfig,
} from '@warden/shared';
import { Backend } from './backend.js';

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
type Node =
  | { kind: 'preview' }
  | { kind: 'tasks' }
  | { kind: 'history' }
  | { kind: 'task'; task: WorkflowTask }
  | { kind: 'file'; file: FileEntry; target: string; task?: WorkflowTask; review?: TaskReview }
  | { kind: 'commit'; sha: string; message: string };

class Documents implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri) {
    const text = this.contents.get(uri.toString());
    if (text === undefined) throw new Error('此审阅快照已关闭，请重新打开文件');
    return text;
  }
  add(name: string, text: string) {
    const uri = vscode.Uri.from({ scheme: 'warden-review', path: `/${randomUUID()}/${name}` });
    this.contents.set(uri.toString(), text);
    return uri;
  }
  remove(uri: vscode.Uri) {
    this.contents.delete(uri.toString());
  }
}

export class Workbench implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private backend?: Backend;
  private data?: WorkflowResponse;
  private preview?: PreviewResponse;
  private history?: HistoryResponse;
  private checks?: RebaseResponse;
  private checkouts?: WorktreesResponse;
  private files = new Map<string, FileEntry[]>();
  private taskTargets = new Map<string, string>();
  private documents = new Documents();
  private reviews = new Map<string, TaskReview>();
  private reviewUris = new Map<string, Set<string>>();
  private output = vscode.window.createOutputChannel('Warden');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private active?: Promise<unknown>;
  private reading?: Promise<void>;
  private closing = false;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      this.output,
      this.status,
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider('warden-review', this.documents),
      vscode.workspace.onDidCloseTextDocument((doc) => this.documents.remove(doc.uri)),
      vscode.window.createTreeView('warden.workbench', { treeDataProvider: this, showCollapseAll: true }),
    );
    this.status.command = 'warden.previewTerminal';
    const commands: Record<string, (node?: Node) => unknown> = {
      selectRepository: () => this.selectRepository(),
      refresh: () => this.refresh(),
      configure: () => this.configure(),
      createTask: () => this.createTask(),
      taskActions: (node) => this.taskActions(node),
      startTask: (node) => this.startTask(node),
      editTask: (node) => this.editTask(node),
      moveTask: (node) => this.moveTask(node),
      connect: (node) => this.connect(node),
      openDiff: (node) => this.openDiff(node),
      deliver: (node) => this.deliver(node),
      retryHook: (node) => this.taskOperation(node, 'hook'),
      resumeTask: (node) => this.taskOperation(node, 'resume'),
      previewTerminal: () => this.previewTerminal(),
      runPreview: () => this.runPreview(),
      previewPath: () => this.previewPath(),
      refreshPreview: () => this.api('/preview/refresh', 'POST', {}),
      setup: () => this.setup(),
      configureScripts: () => this.configureScripts(),
      applyScripts: () => this.applyScripts(),
      rebase: () => this.rebase(),
      editHistory: () => this.editHistory(),
      applyHistory: () => this.applyHistory(),
      taskDetails: (node) => this.taskDetails(node),
      copyWorkspace: (node) => this.copyWorkspace(node),
      importNotes: () => this.importNotes(),
    };
    for (const [name, action] of Object.entries(commands))
      context.subscriptions.push(vscode.commands.registerCommand(`warden.${name}`, (node?: Node) => this.perform(() => action(node))));
  }
  private api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    if (!this.backend) throw new Error('请先运行 Warden: 选择仓库');
    return this.backend.request<T>(route, method, body);
  }
  private async perform(action: () => unknown) {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区');
    if (this.active || this.closing) return;
    this.active = Promise.resolve().then(action);
    try {
      return await this.active;
    } catch (error) {
      this.report(error);
    } finally {
      this.active = undefined;
      if (!this.closing) await this.refresh().catch((error) => this.report(error));
    }
  }
  private report(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    void vscode.window.showErrorMessage(`Warden: ${message}`);
  }
  async initialize() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1) {
      try {
        await this.open(folders[0]!.uri.fsPath);
      } catch (error) {
        this.output.appendLine(String(error));
      }
    }
  }
  private async open(directory: string) {
    try {
      await this.reading;
      await this.backend?.close();
      this.backend = await Backend.open(directory);
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
      this.backend.start(
        () => this.refresh(),
        (error) => this.output.appendLine(String(error)),
      );
    } catch (error) {
      this.backend = undefined;
      throw error;
    }
  }
  private async selectRepository() {
    const selected = await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择主目录所在的仓库' });
    if (selected) await this.open(selected.uri.fsPath);
  }
  refresh(): Promise<void> {
    if (this.reading) return this.reading;
    if (!this.backend || this.closing) return Promise.resolve();
    this.reading = (async () => {
      const [data, preview, checkouts] = await Promise.all([
        this.api<WorkflowResponse>('/workflow'),
        this.api<PreviewResponse>('/preview'),
        this.api<WorktreesResponse>('/worktrees'),
      ]);
      const changedHead = data.developmentHead !== this.data?.developmentHead;
      let changed = JSON.stringify([data, preview, checkouts]) !== JSON.stringify([this.data, this.preview, this.checkouts]);
      this.data = data;
      this.preview = preview;
      this.checkouts = checkouts;
      if (data.workflow && (changedHead || !this.history)) {
        this.history = await this.api<HistoryResponse>('/history');
        this.checks = await this.api<RebaseResponse>('/workflow/rebase-checks');
      }
      for (const key of this.files.keys()) {
        try {
          const response = await this.api<FilesResponse>(`/targets/${encodeURIComponent(key)}/files`);
          if (JSON.stringify(response.files) !== JSON.stringify(this.files.get(key))) changed = true;
          this.files.set(key, response.files);
        } catch {
          this.files.delete(key);
          changed = true;
        }
      }
      this.status.text = `$(layers) Warden: ${statusLabels[preview.syncStatus ?? preview.status] ?? preview.status}${preview.setup?.status === 'failed' ? ' · setup 失败' : ''}`;
      this.status.tooltip = `运行目录：${preview.worktree ?? '尚未初始化'}\n${preview.message ?? '主目录保存后自动同步至预览'}\n${data.error ?? ''}`;
      this.status.show();
      if (changed) this.emitter.fire(undefined);
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'tasks' || node.kind === 'history') {
      const item = new vscode.TreeItem(node.kind === 'tasks' ? '任务' : '提交历史', vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.kind;
      item.contextValue = node.kind;
      item.iconPath = new vscode.ThemeIcon(node.kind === 'tasks' ? 'list-ordered' : 'history');
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
      item.command = { command: 'warden.previewTerminal', title: '打开预览终端' };
      return item;
    }
    if (node.kind === 'task') {
      const task = node.task;
      const item = new vscode.TreeItem(task.title, task.worktree ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `task:${task.id}`;
      item.contextValue = task.worktree ? 'task' : 'plan';
      const source = this.preview?.sources?.find((s) => s.changeId === task.id);
      const connected = this.preview?.connectedIds.includes(task.id);
      const sync = this.checks?.checks.find((c) => c.changeId === task.id);
      item.description = [
        task.agent,
        task.worktree ? (connected ? (source ? statusLabels[source.status] : '待同步') : '未连接') : statusLabels[task.status],
        task.status === 'integrating' ? '待提交' : '',
        this.reviews.has(task.id) && !sameReview(this.reviews.get(task.id), taskReview(this.data!, task.id, this.checkouts?.worktrees ?? []))
          ? '审查版本已变化'
          : '',
        sync && sync.status !== 'current' ? '可检查 rebase' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      item.iconPath = new vscode.ThemeIcon(connected ? 'plug' : task.worktree ? 'git-branch' : 'circle-outline');
      item.tooltip = new vscode.MarkdownString(`${task.title}\n\n${task.body ?? ''}\n\n${task.worktree ?? '尚未分配工作区'}`);
      item.command = { command: 'warden.taskActions', title: '任务操作', arguments: [node] };
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
    item.description = `+${node.file.additions} −${node.file.deletions}`;
    item.iconPath = new vscode.ThemeIcon('diff');
    item.command = { command: 'warden.openDiff', title: '查看差异', arguments: [node] };
    return item;
  }
  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.backend) return [];
    if (!node) return [{ kind: 'preview' }, { kind: 'tasks' }, { kind: 'history' }];
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
      const response = await this.api<FilesResponse>(`/targets/${encodeURIComponent(target)}/files`);
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
  private async readReview(changeId: string) {
    const [data, checkouts] = await Promise.all([this.api<WorkflowResponse>('/workflow'), this.api<WorktreesResponse>('/worktrees')]);
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
      if (previous) void vscode.window.showInformationMessage('审查版本已更新，请完整审查本次交付。');
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
    const list = await this.api<WorktreesResponse>('/worktrees');
    const branch = await vscode.window.showQuickPick(
      list.branches.map((b) => b.name),
      { placeHolder: '选择主目录当前检出的主开发分支' },
    );
    if (branch) {
      await this.api('/workflow', 'PUT', { developmentBranch: branch });
      await this.api('/preview/refresh', 'POST', {});
    }
  }
  private async createTask() {
    if (!this.data?.workflow) await this.configure();
    const title = await vscode.window.showInputBox({ prompt: '任务标题', ignoreFocusOut: true });
    if (!title?.trim()) return;
    const body = await vscode.window.showInputBox({ prompt: '任务说明（可留空）', ignoreFocusOut: true });
    if (body !== undefined) await this.api('/workflow/changes', 'POST', { title, body });
  }
  private async taskActions(node?: Node) {
    const task = await this.pickTask(node);
    if (!task) return;
    const actions = task.worktree
      ? [
          ['查看任务说明', 'taskDetails'],
          ['连接／断开预览', 'connect'],
          ['交付提交', 'deliver'],
          ['复制工作区路径', 'copyWorkspace'],
          ['重试工作区脚本', 'retryHook'],
          ['结束已恢复的提交准备', 'resumeTask'],
          ['编辑任务', 'editTask'],
          ['调整计划顺序', 'moveTask'],
        ]
      : [
          ['分配工作区', 'startTask'],
          ['编辑任务', 'editTask'],
          ['调整计划顺序', 'moveTask'],
        ];
    const choice = await vscode.window.showQuickPick(actions.map(([label, command]) => ({ label: label!, command: command! })));
    if (!choice) return;
    // Dispatch inside the current action, without re-entering the command serialization guard.
    const taskNode: Node = { kind: 'task', task };
    switch (choice.command) {
      case 'taskDetails':
        return this.taskDetails(taskNode);
      case 'connect':
        return this.connect(taskNode);
      case 'deliver':
        return this.deliver(taskNode);
      case 'copyWorkspace':
        return this.copyWorkspace(taskNode);
      case 'retryHook':
        return this.taskOperation(taskNode, 'hook');
      case 'resumeTask':
        return this.taskOperation(taskNode, 'resume');
      case 'startTask':
        return this.startTask(taskNode);
      case 'editTask':
        return this.editTask(taskNode);
      case 'moveTask':
        return this.moveTask(taskNode);
    }
  }
  private async startTask(node?: Node) {
    const task = await this.pickTask(node);
    if (!task) return;
    const choice = await vscode.window.showQuickPick([
      { label: '独立 clone', slotKind: 'clone' },
      { label: 'Git worktree', slotKind: 'worktree' },
      { label: '复用已有工作区', slotKind: 'reuse' },
    ]);
    if (!choice) return;
    let worktree: string | undefined;
    if (choice.slotKind === 'reuse') {
      const list = await this.api<WorktreesResponse>('/worktrees');
      worktree = (
        await vscode.window.showQuickPick(
          list.worktrees
            .filter((w) => w.slot !== undefined && !this.tasks().some((t) => t.worktree === w.path))
            .map((w) => ({ label: w.path, description: w.branch })),
        )
      )?.label;
      if (!worktree) return;
    }
    const agent = await vscode.window.showInputBox({ prompt: '执行者名称（仅标签，可留空）' });
    if (agent !== undefined) await this.api(`/workflow/changes/${task.id}/start`, 'POST', { agent, ...(worktree ? { worktree } : { kind: choice.slotKind }) });
  }
  private async editTask(node?: Node) {
    const task = await this.pickTask(node);
    if (!task) return;
    const title = await vscode.window.showInputBox({ prompt: '任务标题', value: task.title });
    if (!title?.trim()) return;
    const body = await vscode.window.showInputBox({ prompt: '任务说明', value: task.body ?? '' });
    if (body === undefined) return;
    await this.api(`/workflow/changes/${task.id}`, 'PATCH', { title, body });
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
    if (before) await this.api(`/workflow/changes/${task.id}/move`, 'POST', { before: before.id });
  }
  private async connect(node?: Node) {
    const task = await this.pickTask(node);
    if (!task?.worktree) return;
    const current = await this.api<PreviewResponse>('/preview');
    await this.api('/preview', 'PUT', {
      connectedIds: current.connectedIds.includes(task.id) ? current.connectedIds.filter((id) => id !== task.id) : [...current.connectedIds, task.id],
    });
  }
  private async openDiff(node?: Node) {
    if (node?.kind !== 'file') return;
    const review = node.review;
    if (node.task && (!review || !sameReview(review, await this.readReview(node.task.id)))) throw new Error('审查版本已变化，请刷新文件列表并重新打开差异');
    const route = `/targets/${encodeURIComponent(node.target)}`;
    const latest = (await this.api<FilesResponse>(`${route}/files`)).files.find((f) => f.path === node.file.path);
    if (!latest) throw new Error('文件差异已变化，请刷新');
    if (latest.binary) {
      if (review) await this.rememberReview(review);
      void vscode.window.showInformationMessage(
        `此文件包含二进制变化，请使用外部工具审查此版本：${review?.sourceHead ?? review?.preparation?.head ?? node.target}`,
      );
      return;
    }
    const read = (side: 'old' | 'new') =>
      this.api<FullFileResponse>(`${route}/file/full?${new URLSearchParams({ path: side === 'old' ? (latest.oldPath ?? latest.path) : latest.path, side })}`);
    const [old, current] = await Promise.all([read('old'), read('new')]);
    const after = (await this.api<FilesResponse>(`${route}/files`)).files.find((f) => f.path === latest.path);
    if (after?.contentHash !== latest.contentHash) throw new Error('读取期间文件发生变化，请重新打开差异');
    if (review) {
      if (!sameReview(review, await this.readReview(review.changeId))) throw new Error('读取期间审查版本发生变化，请重新打开差异');
      await this.rememberReview(review);
    }
    const left = this.documents.add(path.basename(latest.oldPath ?? latest.path), old.content ?? '');
    const right = this.documents.add(path.basename(latest.path), current.content ?? '');
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
      `${node.task?.title ?? '提交'} · ${latest.path}${version ? ` · ${version.slice(0, 8)}` : ''}`,
      { preview: true },
    );
  }
  private async deliver(node?: Node) {
    const task = await this.pickTask(node);
    if (!task?.worktree) return;
    const current = await this.readReview(task.id);
    if (task.integration && !task.integration.prepared && !current?.preparation) {
      await this.api(`/workflow/changes/${task.id}/prepare`, 'POST', {
        sourceHead: task.integration.source,
        developmentHead: task.integration.parent,
      });
      this.reviews.delete(task.id);
      void vscode.window.showInformationMessage('提交准备已恢复，请重新打开差异审查主目录中保留的内容。');
      return;
    }
    const review = this.reviews.get(task.id);
    if (!review || !sameReview(review, current)) throw new Error('请重新打开任务差异，完整审查当前版本后再交付');
    const p = review.preparation;
    if (p?.canRecord && p.head) {
      await this.api(`/workflow/changes/${task.id}/accept`, 'POST', { mode: 'record', commit: p.head });
      this.reviews.delete(task.id);
      return;
    }
    if (p ? !p.canCommit : !review.sourceHead || !review.developmentHead) throw new Error(p?.message ?? '请先在任务工作区提交变更，再重新打开差异审查');
    const message = await vscode.window.showInputBox({ prompt: '提交到主开发分支', value: task.title, ignoreFocusOut: true });
    if (!message?.trim()) return;
    if (!sameReview(review, await this.readReview(task.id))) throw new Error('审查版本已变化，请重新打开差异后交付');
    if (p) {
      await this.api(`/workflow/changes/${task.id}/accept`, 'POST', { mode: 'commit', developmentHead: p.head, indexFingerprint: p.indexFingerprint, message });
    } else {
      await this.api(`/workflow/changes/${task.id}/deliver`, 'POST', {
        sourceHead: review.sourceHead,
        sourceBase: review.sourceBase,
        developmentHead: review.developmentHead,
        message,
      });
    }
    this.reviews.delete(task.id);
  }
  private async taskOperation(node: Node | undefined, operation: string) {
    const task = await this.pickTask(node);
    if (task) await this.api(`/workflow/changes/${task.id}/${operation}`, 'POST', {});
  }
  private async ensurePreview() {
    let preview = await this.api<PreviewResponse>('/preview');
    if (!preview.worktree) preview = await this.api<PreviewResponse>('/preview/refresh', 'POST', {});
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
    const result = await this.api<PreviewResponse>('/preview/setup', 'POST', {});
    this.output.appendLine(result.setup?.output ?? '尚未配置 setup 脚本');
    this.output.show(true);
  }
  private async configureScripts() {
    const current = await this.api<WorkflowResponse>('/workflow');
    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(
        { wardenRepository: this.backend!.root, hooks: current.workspaceConfig?.hooks ?? {}, previewSetup: current.workspaceConfig?.previewSetup ?? '' },
        null,
        2,
      ),
    });
    await vscode.window.showTextDocument(document);
    void vscode.window.showInformationMessage('编辑脚本后运行「Warden: 保存脚本配置」。setup 在预览目录初始化及代码变化后执行，应保持幂等。');
  }
  private async applyScripts() {
    const text = vscode.window.activeTextEditor?.document.getText();
    if (!text) return;
    const config = JSON.parse(text) as WorkspaceConfig & { wardenRepository: string };
    if (config.wardenRepository !== this.backend?.root) throw new Error('配置草稿不属于当前仓库');
    await this.api('/workspace/config', 'PUT', config);
  }
  private async rebase() {
    const response = await this.api<RebaseResponse>('/workflow/rebase-checks');
    const selected = await vscode.window.showQuickPick(
      response.checks.map((check) => ({
        label: this.tasks().find((c) => c.id === check.changeId)?.title ?? check.changeId,
        description: check.status,
        detail: check.message,
        check,
      })),
      { canPickMany: true, placeHolder: '选择要 rebase 的工作区（可全选）；仅执行本次选择' },
    );
    if (!selected?.length) return;
    const result = await this.api<{ results: { changeId: string; status: string; message?: string }[] }>('/workflow/rebase', 'POST', {
      items: selected.map((s) => s.check),
    });
    for (const row of result.results) this.output.appendLine(`${row.changeId}: ${row.status} ${row.message ?? ''}`);
    this.output.show(true);
    this.checks = await this.api('/workflow/rebase-checks');
  }
  private async editHistory() {
    const history = await this.api<HistoryResponse>('/history');
    const start = await vscode.window.showQuickPick(
      history.commits.map((commit) => ({ label: commit.message.split('\n')[0]!, description: commit.sha.slice(0, 8), commit })),
      { placeHolder: '选择要编排的最早提交；从此提交至 HEAD 的全部提交都会进入草稿' },
    );
    if (!start) return;
    const draft = {
      wardenRepository: this.backend!.root,
      head: history.head,
      start: start.commit.sha,
      commits: history.commits.slice(history.commits.findIndex((c) => c.sha === start.commit.sha)).map(({ sha, message }) => ({ sha, message })),
    };
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(draft, null, 2) }));
    void vscode.window.showInformationMessage('调整 commits 数组顺序或 message，再运行「Warden: 预览并应用历史编排」。');
  }
  private async applyHistory() {
    const text = vscode.window.activeTextEditor?.document.getText();
    if (!text) return;
    const draft = JSON.parse(text) as HistoryPreviewRequest & { wardenRepository: string };
    if (draft.wardenRepository !== this.backend?.root) throw new Error('历史草稿不属于当前仓库');
    const result = await this.api<HistoryPreviewResponse>('/history/preview', 'POST', draft);
    if (!result.canApply) throw new Error(result.message ?? `编排冲突：${result.conflicts.join('、')}`);
    const confirm = await vscode.window.showInformationMessage(
      '历史编排预览通过，最终文件内容不变。应用以下提交顺序和信息？',
      { modal: true, detail: result.commits.map((c, i) => `${i + 1}. ${c.message}`).join('\n') },
      '应用',
    );
    if (confirm === '应用') await this.api('/history/apply', 'POST', { id: result.id, head: result.head });
  }
  private async taskDetails(node?: Node) {
    const task = await this.pickTask(node);
    if (!task) return;
    const text =
      `${task.title}\n\n${task.body ?? ''}\n\n${task.acceptance ?? ''}\n\n工作区：${task.worktree ?? '未分配'}\n` +
      (task.worktree
        ? `\n脚本：${task.workspaceHook?.status ?? '未配置'}\n${task.workspaceHook?.output ?? ''}\n\n交付：\n${task.deliveries?.map((d) => `${d.commit} ${d.message}`).join('\n') ?? ''}`
        : '');
    await vscode.window.showTextDocument(this.documents.add('task.txt', text));
  }
  private async copyWorkspace(node?: Node) {
    const task = await this.pickTask(node);
    if (task?.worktree) await vscode.env.clipboard.writeText(task.worktree);
  }
  private async importNotes() {
    const selected = await vscode.window.showQuickPick(
      (this.data?.legacyTodos ?? []).map((todo) => ({ label: todo.title, description: todo.branch, todo })),
      { canPickMany: true, placeHolder: '选择旧笔记导入当前计划' },
    );
    for (const item of selected ?? []) await this.api(`/workflow/import-todos/${item.todo.id}`, 'POST', {});
  }
  async close() {
    this.closing = true;
    await this.active;
    await this.reading;
    await this.backend?.close();
  }
}

let workbench: Workbench | undefined;
export async function activate(context: vscode.ExtensionContext) {
  workbench = new Workbench(context);
  await workbench.initialize();
  return workbench;
}
export async function deactivate() {
  await workbench?.close();
  workbench = undefined;
}
