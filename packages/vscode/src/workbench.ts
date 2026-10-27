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
import type { WorkbenchAction, WorkbenchModel, Surface, TaskSection, WorkspaceRow, WorkbenchError, RebaseBatchResponse } from '@warden/shared';
import type { AcpBinding } from '@warden/shared';
import { Documents } from './documents.js';
import { Views } from './views.js';
import { AcpConversations } from './acp/conversations.js';
import { BranchViews } from './branch-view.js';

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
const fileModeChange = (file: FileEntry): string | undefined =>
  file.oldMode === file.newMode ? undefined : `文件模式 ${file.oldMode ?? '无'} → ${file.newMode ?? '无'}`;
type Node =
  | { kind: 'preview' }
  | { kind: 'tasks' }
  | { kind: 'history' }
  | { kind: 'settings' }
  | { kind: 'task'; task: WorkflowTask }
  | { kind: 'file'; file: FileEntry; target: string; task?: WorkflowTask; review?: TaskReview }
  | { kind: 'commit'; sha: string; message: string };

export class Workbench {
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

  private readonly views: Views;
  private commitInput?: vscode.InputBox;
  private fileErrors = new Map<string, string>();
  private readonly conversations: AcpConversations;
  private readonly branchViews: BranchViews;
  private branch?: string;
  private branchTransition = false;
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
    this.branchViews = new BranchViews(context.workspaceState);
    this.documents = new Documents(context);
    this.conversations = new AcpConversations(
      context,
      (binding) => this.reviewConversation(binding),
      () => this.views.render(),
      (error) => this.output.appendLine(String(error)),
    );
    this.views = new Views(
      context,
      (surface) => this.model(surface),
      (action, session) => this.handleAction(action, session),
      (error, surface) => this.report(error, surface === 'task' ? `task:${this.selected ?? 'new'}` : surface),
    );
    context.subscriptions.push(
      this.output,
      this.status,
      vscode.workspace.registerTextDocumentContentProvider('warden-review', this.documents),
      vscode.workspace.onDidCloseTextDocument((doc) => this.documents.remove(doc.uri)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('warden.previewCommand')) this.views.render();
      }),
      this.views,
      // Reuse the old task pane identity so VS Code restores its unsaved webview drafts after upgrading.
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
      deliver: (node) => this.promptDelivery(node),
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
    return this.backend.execute(command, request, { developmentBranch: this.branch ?? null });
  }
  private async perform(action: () => unknown, busy?: string, scope = 'repository') {
    if (!vscode.workspace.isTrusted) {
      this.report(new Error('请先信任此工作区'), scope);
      return;
    }
    if (this.closing) return;
    if (this.switching || this.branchTransition) {
      this.report(new Error('正在切换仓库或主开发分支，请稍后重试'), scope);
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
    this.commitInput?.hide();
    this.switching = true;
    this.session = randomUUID();
    this.status.hide();
    await this.updateContext();
    try {
      await Promise.allSettled([...this.navigation]);
      await this.reading;
      await this.backend?.close();
      this.backend = await Engine.open(directory);
      this.selected = undefined;
      this.branch = undefined;
      this.expanded = this.context.workspaceState.get<Record<string, boolean>>(`warden.expanded:${this.backend.root}`, {});
      this.selectedFiles = this.context.workspaceState.get<Record<string, string>>(`warden.files:${this.backend.root}`, {});
      this.taskSection = undefined;
      this.rebaseSelection = undefined;
      this.messages = this.context.workspaceState.get<Record<string, string>>(`warden.messages:${this.backend.root}`, {});
      this.historyDraft = undefined;
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
      this.fileErrors.clear();
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
      if (this.backend)
        await Promise.all(
          this.tasks()
            .filter((task) => task.worktree && this.expanded[task.id])
            .map((task) => this.getChildren({ kind: 'task', task })),
        );
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
  private async changeBranch(data: WorkflowResponse) {
    this.commitInput?.hide();
    this.branchTransition = true;
    this.session = randomUUID();
    this.branch = data.workflow?.developmentBranch;
    this.selected = undefined;
    this.creating = false;
    this.taskSection = undefined;
    this.historyDraft = undefined;
    this.historyPreview = undefined;
    this.history = undefined;
    this.checks = undefined;
    this.rebaseSelection = undefined;
    this.rebaseResult = undefined;
    this.reviews.clear();
    this.files.clear();
    this.fileErrors.clear();
    this.taskTargets.clear();
    this.errors.clear();
    this.views.render();
    try {
      const saved = await this.branchViews.load(this.backend!.root, data);
      this.selected = saved.selected;
      this.historyDraft = saved.historyDraft;
    } finally {
      this.branchTransition = false;
    }
  }
  refresh(afterMutation = false): Promise<void> {
    // A read begun before a write cannot acknowledge that write to the next user action.
    if (this.reading) return afterMutation ? this.reading.catch(() => {}).then(() => this.refresh()) : this.reading;
    if (!this.backend || this.closing) return Promise.resolve();
    this.reading = (async () => {
      const engine = this.backend!;
      for (let attempt = 0; attempt < 3; ++attempt) {
        let [data, preview, checkouts] = await Promise.all([
          engine.execute('workflow.get', undefined),
          engine.execute('preview.get', undefined),
          engine.execute('workspaces.list', undefined),
        ]);
        if (this.closing) return;
        // Migrate the old repository-wide UI state into its original requirement before following Git.
        if (this.branch === undefined && data.workflow) await this.branchViews.load(engine.root, data);
        const primary = checkouts.worktrees.find((row) => row.isMain && !row.shared && !row.clone);
        let branchProblem: WorkbenchError | undefined;
        if (data.workflow && primary?.branch && !primary.detached && !primary.busy && !primary.foreign && primary.branch !== data.workflow.developmentBranch) {
          const previous = data.workflow.developmentBranch;
          try {
            await engine.execute('workflow.configure', { branch: primary.branch }, { developmentBranch: previous });
            [data, preview] = await Promise.all([engine.execute('workflow.get', undefined), engine.execute('preview.get', undefined)]);
          } catch (error) {
            if (error instanceof WardenError && error.code === 'requirement_changed') continue;
            if (!(error instanceof WardenError) || !['development_in_use', 'operation_locked'].includes(error.code ?? '')) throw error;
            branchProblem = {
              scope: 'repository',
              code: error.code,
              message: `主目录已切到 ${primary.branch}，Warden 仍在 ${previous}。${
                error.code === 'development_in_use' ? `请切回 ${previous} 完成交付准备并断开预览连接。` : error.message
              }`,
            };
          }
        }
        const branch = data.workflow?.developmentBranch;
        const changedBranch = branch !== this.branch;
        const changedHead = data.developmentHead !== this.data?.developmentHead;
        const history = data.workflow
          ? changedBranch || changedHead || !this.history
            ? await engine.execute('history.get', undefined)
            : this.history
          : undefined;
        const checkSignature = JSON.stringify([
          branch,
          data.developmentHead,
          checkouts.worktrees.map((row) => [row.path, row.head, row.branch, row.dirty, row.busy]),
          data.workflow?.changes.map((task) => [task.id, task.base, task.worktree ? task.sourceBase : undefined]),
        ]);
        const checks = data.workflow ? (checkSignature !== this.checkSignature ? await engine.execute('rebase.check', undefined) : this.checks) : undefined;
        const current = await engine.execute('workflow.context', undefined);
        const taskIds =
          data.workflow?.changes
            .filter((task) => task.worktree && task.status !== 'accepted' && task.developmentBranch === branch)
            .map((task) => task.id)
            .sort() ?? [];
        if (
          current.developmentBranch !== branch ||
          (history && (history.branch !== branch || history.head !== data.developmentHead)) ||
          (checks &&
            (JSON.stringify(checks.checks.map((check) => check.changeId).sort()) !== JSON.stringify(taskIds) ||
              checks.checks.some((check) => check.developmentHead !== data.developmentHead)))
        )
          continue;
        this.data = data;
        this.preview = preview;
        this.checkouts = checkouts;
        if (changedBranch) await this.changeBranch(data);
        this.history = history;
        this.checks = checks;
        this.checkSignature = checkSignature;
        if (branchProblem) {
          if (this.errors.get('branch')?.message !== branchProblem.message) this.output.appendLine(branchProblem.message);
          this.errors.set('branch', branchProblem);
        } else this.errors.delete('branch');
        await this.updateContext();
        this.views.render();
        for (const key of this.files.keys()) {
          try {
            const response = await this.api('review.files', { key });
            this.files.set(key, response.files);
          } catch {
            this.files.delete(key);
          }
        }
        this.status.text = `$(layers) Warden: ${statusLabels[preview.syncStatus ?? preview.status] ?? preview.status}${preview.setup?.status === 'failed' ? ' · setup 失败' : ''}`;
        this.status.tooltip = `运行目录：${preview.worktree ?? '尚未初始化'}\n${preview.message ?? '主目录保存后自动同步至预览'}\n${data.error ?? ''}`;
        if (data.workflow) this.status.show();
        else this.status.hide();
        await Promise.all(
          this.tasks()
            .filter((task) => task.worktree && this.expanded[task.id])
            .map((task) => this.getChildren({ kind: 'task', task })),
        );
        this.views.render();
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
        return;
      }
      throw new WardenError(409, '主开发分支正在变化，请稍后刷新', 'requirement_changed');
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  private workspaceRow(task: WorkflowTask): WorkspaceRow {
    const source = this.preview?.sources?.find((row) => row.changeId === task.id);
    const connected = this.preview?.connectedIds.includes(task.id);
    const sync = this.checks?.checks.find((check) => check.changeId === task.id);
    const connection = task.worktree ? (connected ? (source ? statusLabels[source.status] : '待同步') : '未连接') : statusLabels[task.status];
    const problem = source?.status === 'conflict' || source?.status === 'error';
    const activity = this.backend && this.conversations.activity(this.backend.root, task.id);
    const facts = [
      activity === 'Agent 等待授权' ? activity : '',
      task.integration?.error ? '提交失败' : '',
      problem ? connection : '',
      this.reviews.has(task.id) && !sameReview(this.reviews.get(task.id), taskReview(this.data!, task.id, this.checkouts?.worktrees ?? []))
        ? '审阅版本已变化'
        : '',
      task.worktree && task.workspaceHook?.status === 'failed' ? '初始化失败' : '',
      activity !== 'Agent 等待授权' ? activity : '',
      task.status === 'integrating' ? '待提交' : '',
      !problem ? connection : '',
      task.agent,
    ].filter(Boolean);
    const target = this.taskTargets.get(task.id);
    return {
      task,
      expanded: !!this.expanded[task.id],
      description: facts.slice(0, 2).join(' · '),
      tooltip: [task.title, task.body, task.worktree ?? '尚未分配工作区', facts.join(' · '), sync?.status !== 'current' ? sync?.message : '']
        .filter(Boolean)
        .join('\n\n'),
      files: target ? this.files.get(target) : undefined,
      filesError: this.fileErrors.get(task.id),
      review: this.reviews.get(task.id),
    };
  }
  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.backend || this.switching || this.branchTransition || !this.data?.workflow) return [];
    const session = this.session;
    if (node?.kind === 'task' && !this.tasks().some((task) => task.id === node.task.id)) return [];
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
      if (!review || session !== this.session) return [];
      target = review.targetKey;
      const previous = this.taskTargets.get(node.task.id);
      if (previous && previous !== target) this.files.delete(previous);
      this.taskTargets.set(node.task.id, target);
    } else if (node.kind === 'commit') target = formatTargetKey({ kind: 'commit', sha: node.sha });
    else return [];
    try {
      const response = await this.api('review.files', { key: target });
      if (session !== this.session) return [];
      this.files.set(target, response.files);
      if (node.kind === 'task') this.fileErrors.delete(node.task.id);
      return response.files.map((file) => ({ kind: 'file', file, target, ...(node.kind === 'task' ? { task: node.task, review } : {}) }));
    } catch (error) {
      if (session !== this.session) return [];
      this.output.appendLine(String(error));
      if (node.kind === 'task') this.fileErrors.set(node.task.id, error instanceof Error ? error.message : String(error));
      return [];
    }
  }
  private tasks() {
    return this.data?.workflow?.changes.filter((c) => c.developmentBranch === this.data?.workflow?.developmentBranch) ?? [];
  }
  private async readReview(changeId: string) {
    const [data, checkouts] = await Promise.all([this.api('workflow.get', undefined), this.api('workspaces.list', undefined)]);
    if (
      data.workflow?.developmentBranch !== this.branch ||
      !data.workflow?.changes.some((task) => task.id === changeId && task.developmentBranch === this.branch)
    )
      return undefined;
    return taskReview(data, changeId, checkouts.worktrees);
  }
  private async rememberReview(review: TaskReview) {
    const session = this.session;
    const previous = this.reviews.get(review.changeId);
    if (!sameReview(previous, review)) {
      const uris = this.reviewUris.get(review.changeId);
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && uris?.has(tab.input.modified.toString()));
      await vscode.window.tabGroups.close(tabs, true);
      this.assertSession(session);
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
    return this.tasks().find((task) => task.id === picked?.task.id);
  }
  private async configure() {
    const session = this.session;
    const list = await this.api('workspaces.list', undefined);
    const branch = await vscode.window.showQuickPick(
      list.branches.map((b) => b.name),
      { placeHolder: '选择主目录当前检出的主开发分支' },
    );
    if (branch) {
      this.assertSession(session);
      const current = await this.api('workspaces.list', undefined);
      const primary = current.worktrees.find((row) => row.isMain && !row.shared && !row.clone);
      if (primary?.branch !== branch || primary.detached || primary.busy) throw new Error('请先在主目录检出这个开发分支并完成当前 Git 操作');
      await this.api('workflow.configure', { branch });
      await this.refresh(true);
      await this.api('preview.refresh', undefined);
    }
  }
  private async createTask() {
    if (!this.data?.workflow) await this.configure();
    if (!(await this.api('workflow.get', undefined)).workflow) return;
    await this.refresh(true);
    this.creating = true;
    this.selected = undefined;
    this.taskSection = undefined;
    this.views.render();
    await this.views.show('task');
  }
  private async rememberExpansion(node: Node, expanded: boolean) {
    if (node.kind !== 'task' || !this.backend) return;
    this.expanded[node.task.id] = expanded;
    this.views.render();
    await this.context.workspaceState.update(`warden.expanded:${this.backend.root}`, this.expanded);
  }
  private async selectTask(node?: Node, openFile = true, section?: TaskSection, refreshReview = false) {
    const session = this.session;
    const task = await this.pickTask(node);
    if (!task || session !== this.session) return;
    if (this.selected !== task.id) this.taskSection = undefined;
    this.selected = task.id;
    this.creating = false;
    if (section) this.taskSection = { request: randomUUID(), section };
    await this.branchViews.select(this.backend!.root, task.developmentBranch, task.id);
    if (session !== this.session) return;
    this.views.render();
    await this.views.show('task');
    if (session !== this.session) return;
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
    const session = this.session;
    if (node.task) {
      if (!this.tasks().some((task) => task.id === node.task!.id)) throw new Error('任务已不属于当前主开发分支');
      if (this.selected !== node.task.id) this.taskSection = undefined;
      this.selected = node.task.id;
      this.creating = false;
      this.selectedFiles[node.task.id] = node.file.path;
      await this.branchViews.select(this.backend!.root, node.task.developmentBranch, node.task.id);
      await this.context.workspaceState.update(`warden.files:${this.backend!.root}`, this.selectedFiles);
      this.assertSession(session);
    }
    const review = node.review;
    if (node.task && (!review || !sameReview(review, await this.readReview(node.task.id)))) throw new Error('审查版本已变化，请刷新文件列表并重新打开差异');
    const key = node.target;
    const latest = (await this.api('review.files', { key })).files.find((f) => f.path === node.file.path);
    this.assertSession(session);
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
    this.assertSession(session);
    if (after?.contentHash !== latest.contentHash) throw new Error('读取期间文件发生变化，请重新打开差异');
    if (review) {
      if (!sameReview(review, await this.readReview(review.changeId))) throw new Error('读取期间审查版本发生变化，请重新打开差异');
      this.assertSession(session);
      await this.rememberReview(review);
    }
    const left = await this.documents.add(path.basename(latest.oldPath ?? latest.path), old.content ?? '', this.backend!.root, latest.oldPath ?? latest.path);
    const right = await this.documents.add(path.basename(latest.path), current.content ?? '', this.backend!.root, latest.path);
    this.assertSession(session);
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
  private async promptDelivery(node?: Node) {
    if (this.commitInput) {
      this.commitInput.show();
      return;
    }
    const task = await this.pickTask(node);
    if (!task?.worktree || !this.backend) return;
    const session = this.session;
    const pinned = this.reviews.get(task.id);
    const recovery = !!task.integration && !task.integration.prepared && !(await this.readReview(task.id))?.preparation;
    const record = !!pinned?.preparation?.canRecord;
    if (!recovery && !sameReview(pinned, await this.readReview(task.id))) throw new Error('请重新打开任务差异，完整审查当前版本后再提交');
    if (recovery || record) {
      await this.perform(() => this.deliver({ kind: 'task', task }), '正在恢复提交…', `task:${task.id}`);
      return;
    }
    const input = vscode.window.createInputBox();
    this.commitInput = input;
    input.title = `${task.title} · 提交到 ${task.developmentBranch}`;
    input.prompt = '输入 commit message，Enter 提交，Esc 取消';
    input.placeholder = '提交说明';
    input.value = this.messages[task.id] ?? task.title;
    input.ignoreFocusOut = true;
    const validate = (value: string) => (!value.trim() ? '请输入提交说明' : value.length > 10000 ? '提交说明不能超过 10000 个字符' : undefined);
    input.validationMessage = validate(input.value);
    const drafts = this.messages;
    const key = `warden.messages:${this.backend.root}`;
    let saving = Promise.resolve();
    const subscriptions: vscode.Disposable[] = [];
    let message: string | undefined;
    try {
      message = await new Promise<string | undefined>((resolve) => {
        subscriptions.push(
          input.onDidChangeValue((value) => {
            drafts[task.id] = value;
            input.validationMessage = validate(value);
            saving = saving.then(() => this.context.workspaceState.update(key, drafts));
          }),
          input.onDidAccept(() => {
            input.validationMessage = validate(input.value);
            if (input.validationMessage) return;
            resolve(input.value);
            input.hide();
          }),
          input.onDidHide(() => resolve(undefined)),
        );
        input.show();
      });
    } finally {
      drafts[task.id] = input.value;
      for (const subscription of subscriptions) subscription.dispose();
      input.dispose();
      if (this.commitInput === input) this.commitInput = undefined;
      await saving;
      await this.context.workspaceState.update(key, drafts);
    }
    if (message === undefined) return;
    await this.perform(
      async () => {
        // Typing never replaces the review pinned when this input opened, even if navigation changed it.
        this.assertSession(session);
        if (!sameReview(pinned, this.reviews.get(task.id)) || !sameReview(pinned, await this.readReview(task.id)))
          throw new Error('输入期间审阅版本已变化，请重新打开差异后提交');
        await this.deliver({ kind: 'task', task }, message);
      },
      '正在提交…',
      `task:${task.id}`,
    );
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
    if (node?.kind === 'task' && !this.tasks().some((task) => task.id === node.task.id)) return;
    this.rebaseSelection = { request: randomUUID(), taskIds: node?.kind === 'task' ? [node.task.id] : [] };
    await this.views.show('rebase');
    await this.refreshChecks();
  }
  private async refreshChecks() {
    await this.reading;
    this.checkSignature = undefined;
    await this.refresh(true);
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
      workflow: this.branchTransition ? undefined : this.data,
      task,
      creating: this.creating,
      taskSection: this.taskSection,
      workspaces: this.tasks().map((task) => this.workspaceRow(task)),
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
      busy: this.branchTransition ? '正在切换主开发分支…' : this.busy,
      errors: [...this.errors.values()],
    };
  }
  private async saveDraft() {
    if (this.backend && this.branch) await this.branchViews.draft(this.backend.root, this.branch, this.historyDraft);
  }
  private assertSession(session: string) {
    if (session !== this.session || this.switching || this.branchTransition) throw new Error('仓库或主开发分支已切换，请使用当前界面重试');
  }
  private async handleAction(action: WorkbenchAction, session: string) {
    this.assertSession(session);
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
    const navigation = [
      'task.review',
      'task.open',
      'task.copy',
      'task.brief',
      'task.chat',
      'task.select',
      'task.edit',
      'task.history',
      'task.output',
      'task.options',
      'task.toggle',
      'task.file',
      'task.sync',
      'task.commit',
      'workspaces.create',
      'workspaces.show',
      'workspaces.refresh',
      'preview.copy',
      'preview.terminal',
      'settings.agents',
      'history.review',
    ];
    await this.perform(
      async () => {
        // A queued message must never be interpreted in the next repository session.
        this.assertSession(session);
        switch (action.type) {
          case 'workspaces.create':
            await this.createTask();
            break;
          case 'workspaces.refresh':
            await this.refresh();
            break;
          case 'workspaces.show':
            if (action.surface === 'rebase') await this.showRebase();
            else await this.views.show(action.surface);
            break;
          case 'task.select':
            await this.selectTask(node);
            break;
          case 'task.edit':
          case 'task.history':
          case 'task.output':
          case 'task.options':
            await this.selectTask(
              node,
              false,
              { 'task.edit': 'edit', 'task.history': 'history', 'task.output': 'hook', 'task.options': 'workspace' }[action.type] as TaskSection,
            );
            break;
          case 'task.toggle':
            await this.rememberExpansion(node!, action.expanded);
            break;
          case 'task.file': {
            const file = (await this.getChildren(node)).find((entry) => entry.kind === 'file' && entry.file.path === action.path);
            if (!file) throw new Error('文件差异已变化，请刷新列表');
            await this.openDiff(file);
            break;
          }
          case 'task.move':
            if (action.before !== null && !this.tasks().some((row) => row.id === action.before)) throw new Error('目标任务已不属于当前主开发分支');
            if (action.before !== action.taskId) await this.api('task.move', { taskId: action.taskId, before: action.before });
            break;
          case 'task.connect':
            await this.connect(node);
            break;
          case 'task.sync':
            await this.showRebase(node);
            break;
          case 'task.commit':
            await this.promptDelivery(node);
            break;
          case 'task.create': {
            const repository = this.backend!.root;
            const created = await this.api('task.create', { title: action.title, body: action.body });
            await this.branchViews.select(repository, created.developmentBranch, created.id);
            if (session !== this.session) break;
            this.selected = created.id;
            this.creating = false;
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
            await this.refreshChecks();
            break;
          case 'rebase.run': {
            const result = await this.api('rebase.run', { items: action.items });
            if (session === this.session) this.rebaseResult = result;
            break;
          }
          case 'history.discard':
            this.historyDraft = undefined;
            this.historyPreview = undefined;
            await this.saveDraft();
            break;
          case 'history.review': {
            const commit = this.history?.commits.find((row) => row.sha === action.sha);
            if (!commit) throw new Error('提交已不在当前历史中，请刷新');
            const files = (await this.getChildren({ kind: 'commit', sha: commit.sha, message: commit.message })).filter((row) => row.kind === 'file');
            const selected = await vscode.window.showQuickPick(
              files.map((row) => ({ label: row.file.path, node: row })),
              { placeHolder: `查看提交 ${commit.sha.slice(0, 8)} 的文件变更` },
            );
            this.assertSession(session);
            if (selected) await this.openDiff(selected.node);
            break;
          }
          case 'history.preview': {
            const candidate = JSON.stringify(action.draft);
            this.historyDraft = action.draft;
            this.historyPreview = undefined;
            await this.saveDraft();
            this.assertSession(session);
            const result = await this.api('history.preview', action.draft);
            // Typing while replay runs invalidates the candidate instead of authorizing newer edits.
            if (session === this.session && candidate === JSON.stringify(this.historyDraft)) this.historyPreview = result;
            break;
          }
          case 'history.apply': {
            const candidate = this.historyPreview;
            const appliedDraft = JSON.stringify(this.historyDraft);
            if (!candidate?.canApply || candidate.id !== action.id || candidate.head !== action.head) throw new Error('历史草稿已变化，请重新预览');
            await this.api('history.apply', { id: action.id, head: action.head });
            if (session !== this.session) break;
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

  async close() {
    this.closing = true;
    this.commitInput?.hide();
    await this.conversations.close();
    await Promise.allSettled([this.active, ...this.navigation, this.reading]);
    await this.backend?.close();
  }
}
