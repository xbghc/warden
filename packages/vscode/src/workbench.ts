import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DiagnosticLog, formatTargetKey, sameReview, previewStatusLabels, scriptStatusLabels } from '@warden/shared';
import { readWorkspaceReference } from './acp/file-reference.js';
import type {
  FileEntry,
  TaskReview,
  PreviewResponse,
  RebaseResponse,
  WorkflowResponse,
  WorkflowTask,
  WorktreesResponse,
  WorkspaceConfig,
} from '@warden/shared';
import { Engine, WardenError } from '@warden/engine';
import type { EngineCommand, EngineInput, EngineOutput } from '@warden/engine';
import type { WorkbenchAction, WorkbenchModel, Surface, WorkspaceRow, WorkbenchError, RebaseBatchResponse } from '@warden/shared';
import type { AcpBinding } from '@warden/shared';
import { Documents } from './documents.js';
import { Views } from './views.js';
import { Sidebar } from './sidebar.js';
import type { SidebarNode } from './sidebar.js';
import { Settings } from './settings.js';
import type { SettingsNode } from './settings.js';
import { ScriptSettings, scriptValue } from './script-settings.js';
import type { ScriptBinding, ScriptKind } from './script-settings.js';

import { AcpConversations } from './acp/conversations.js';
import { AcpAgentSetup } from './acp/setup.js';
import { acpDiagnosticSecrets, acpErrorDiagnostic } from './acp/diagnostics.js';
import { BranchViews } from './branch-view.js';
import { PerformanceLog } from './performance.js';
import type { PerformanceOutcome, PerformanceSpan, PerformanceStage } from './performance.js';

type Node = SidebarNode | SettingsNode | { kind: 'commit'; sha: string; message: string; session?: string };
type CheckRequest = { engine: Engine; session: string; revision: number; head?: string; tasks: string[]; traced: boolean };

const fileModeChange = (file: FileEntry): string | undefined =>
  file.oldMode === file.newMode ? undefined : `File mode ${file.oldMode ?? 'none'} → ${file.newMode ?? 'none'}`;

export class Workbench {
  private backend?: Engine;
  private data?: WorkflowResponse;
  private preview?: PreviewResponse;
  private checks?: RebaseResponse;
  private checkouts?: WorktreesResponse;
  private files = new Map<string, FileEntry[]>();
  private taskTargets = new Map<string, string>();
  private documents: Documents;
  private reviews = new Map<string, TaskReview>();
  private observedReviews = new Map<string, TaskReview>();
  private reviewUris = new Map<string, Set<string>>();
  private output = vscode.window.createOutputChannel('Warden', { log: true });
  private readonly log = new DiagnosticLog((level, line) => this.output[level](line), { run: randomUUID() }, acpDiagnosticSecrets());
  private readonly performance: PerformanceLog;
  private activation?: PerformanceSpan;
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private active?: Promise<unknown>;
  private reading?: Promise<void>;
  private contextUpdate: Promise<void> = Promise.resolve();
  private readonly contextValues = new Map<string, unknown>();
  private closing = false;
  private initializing = true;
  private switching = false;
  private repositoryRevision = 0;
  private navigation = new Set<Promise<unknown>>();

  private readonly views: Views;
  private readonly sidebar: Sidebar;
  private readonly settings: Settings;
  private readonly scriptSettings: ScriptSettings;
  private taskInput?: vscode.InputBox;
  private commitInput?: vscode.InputBox;
  private fileErrors = new Map<string, string>();
  private readonly conversations: AcpConversations;
  private readonly agentSetup: AcpAgentSetup;
  private agentConfigurationStatus?: WorkbenchModel['agentConfiguration']['status'];
  private agentReadinessStatus?: WorkbenchModel['agentReadiness']['status'];
  private agentSetupRequired?: boolean;
  private readonly branchViews: BranchViews;
  private branch?: string;
  private configuredBranch?: string;
  private checkoutBranch?: string;
  private branchTransition = false;
  private selected?: string;
  private expanded: Record<string, boolean> = {};
  private selectedFiles: Record<string, string> = {};
  private session = randomUUID();
  private busy?: string;
  private errors = new Map<string, WorkbenchError>();
  private messages: Record<string, string> = {};
  private rebaseResult?: RebaseBatchResponse;
  private rebaseSelection?: WorkbenchModel['rebaseSelection'];
  private checkSignature?: string;
  private checkRevision = 0;
  private checkReading?: Promise<void>;
  private pendingCheck?: CheckRequest;
  private checkingRebase = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    started = performance.now(),
  ) {
    this.log.write('info', 'extension.activate', {
      version: context.extension.packageJSON.version,
      vscode: vscode.version,
      platform: process.platform,
      remote: vscode.env.remoteName ?? 'local',
      trusted: vscode.workspace.isTrusted,
    });
    this.performance = new PerformanceLog((line) => this.output.appendLine(line), started);
    this.activation = this.performance.start('activation', undefined, started);
    this.agentSetup = new AcpAgentSetup(
      () => this.backend?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      () => {
        this.conversations?.refresh();
        this.render();
      },
      context.globalState,
      this.performance,
      this.log.child({ component: 'acp.workbench' }),
    );
    this.branchViews = new BranchViews(context.workspaceState);
    this.documents = new Documents(context);
    this.conversations = new AcpConversations(
      context,
      (binding, reference) => this.reviewConversation(binding, reference),
      () => this.render(),
      (error) => this.log.write('error', 'conversation.failed', { diagnostic: acpErrorDiagnostic(error) }),
      async () => {
        await vscode.commands.executeCommand('warden.configureAgents');
      },
      (profile, message) => this.agentSetup.readiness.unavailable(profile, message),
      () => {
        const readiness = this.agentSetup.readiness.snapshot();
        return readiness.status === 'ready' ? readiness.profile?.id : undefined;
      },
      this.log.child({ component: 'acp.task' }),
    );
    this.views = new Views(
      context,
      (surface) => this.model(surface),
      (action, session) => this.handleAction(action, session),
      (error, surface, taskId) => this.report(error, surface === 'task' ? `task:${taskId ?? 'new'}` : surface),
    );
    this.sidebar = new Sidebar(
      () => this.model('workspaces'),
      (node) => this.getChildren(node),
      (action, session) => this.handleAction(action, session),
      (node, expanded) => this.rememberExpansion(node, expanded).catch((error) => this.report(error)),
      context.workspaceState,
      (error) => this.report(error),
    );
    this.settings = new Settings(() => this.model('settings'), context.extensionUri);
    this.scriptSettings = new ScriptSettings(
      () => this.model('settings'),
      (binding, value) => this.saveScript(binding, value),
    );
    context.subscriptions.push(
      this.agentSetup,
      this.sidebar,
      this.settings,
      this.scriptSettings,
      this.output,
      this.status,
      vscode.workspace.registerTextDocumentContentProvider('warden-review', this.documents),
      vscode.workspace.onDidCloseTextDocument((doc) => this.documents.remove(doc.uri)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('warden.previewCommand')) {
          void this.updateContext();
          this.render();
        }
      }),
      this.views,
      vscode.commands.registerCommand('warden.editSetupScript', (kind: ScriptKind, session: string) =>
        this.perform(
          async () => {
            this.assertSession(session);
            if (!['workspace', 'reuse', 'preview'].includes(kind)) throw new Error('Unknown setup script.');
            await this.scriptSettings.open(kind, session);
          },
          undefined,
          'settings',
        ),
      ),
    );
    this.status.command = 'warden.showPreview';
    const commands: Record<string, (node?: Node) => unknown> = {
      selectRepository: () => this.selectRepository(),
      refresh: () => this.refresh(),
      viewAsTree: () => this.sidebar.setFileViewMode('tree'),
      viewAsList: () => this.sidebar.setFileViewMode('list'),
      configure: () => this.configure(),
      createTask: () => this.createTask(),
      moveTaskUp: (node) => this.moveTaskBy(node, -1),
      moveTaskDown: (node) => this.moveTaskBy(node, 1),
      taskHistory: (node) => this.showTaskHistory(node),
      taskOptions: (node) => this.selectTask(node, 'select'),
      taskOutput: (node) => this.showTaskOutput(node),
      copyBrief: (node) => this.taskAction(node, 'task.brief'),
      restoreTask: (node) => this.taskAction(node, 'task.restore'),
      taskActions: (node) => this.selectTask(node),
      selectTask: (node) => this.selectTask(node),
      startTask: (node) => this.selectTask(node, 'select'),
      editTask: (node) => this.selectTask(node, 'edit'),
      moveTask: (node) => this.moveTask(node),
      connect: (node) => this.connect(node),
      openDiff: (node) => this.openDiff(node),
      deliver: (node) => this.promptDelivery(node),
      recoverDelivery: (node) => this.promptDelivery(node),
      recordDelivery: (node) => this.promptDelivery(node),
      reviewTask: (node) => this.selectTask(node, 'review', true),
      openWorkspace: (node) => this.openWorkspace(node),
      retryHook: (node) => this.taskOperation(node, 'task.hook'),
      resumeTask: (node) => this.taskOperation(node, 'task.resume'),
      previewTerminal: () => this.previewTerminal(),
      runPreview: () => this.runPreview(),
      previewPath: () => this.previewPath(),
      refreshPreview: () => this.api('preview.refresh', undefined),
      setup: () => this.setup(),
      configureScripts: () => this.settings.show(),
      rebase: (node) => this.showRebase(node),
      syncTask: (node) => this.showRebase(node),
      syncConflict: (node) => this.showRebase(node),
      copyWorkspace: (node) => this.copyWorkspace(node),
      importNotes: () => this.importNotes(),
      showPreview: () => this.showPreviewOutput(),
      copyLocation: () => this.documents.copyLocation(),
      chat: (node) => this.openConversation(node),
      switchChat: () => this.openConversation(),
      expandChat: () => this.conversations.expand(),
      configureAgents: () => this.settings.show(),
      chooseAgentPreset: () => this.agentSetup.configure(),
      checkAgent: () => (this.conversations.configuration().status === 'configured' ? this.agentSetup.check() : this.settings.show()),
      cancelAgentCheck: () => this.agentSetup.disconnect(),
      sendSelectionToAgent: () => this.sendSelectionToAgent(),
    };
    const navigation = new Set([
      'refresh',
      'viewAsTree',
      'viewAsList',
      'createTask',
      'taskHistory',
      'taskOutput',
      'copyBrief',
      'restoreTask',
      'selectTask',
      'taskActions',
      'editTask',
      'deliver',
      'recoverDelivery',
      'recordDelivery',
      'reviewTask',
      'openDiff',
      'configureScripts',
      'copyWorkspace',
      'openWorkspace',
      'showPreview',
      'copyLocation',
      'chat',
      'switchChat',
      'expandChat',
      'configureAgents',
      'sendSelectionToAgent',
    ]);
    for (const [name, action] of Object.entries(commands))
      context.subscriptions.push(
        vscode.commands.registerCommand(`warden.${name}`, (node?: Node) =>
          ['configureScripts', 'configureAgents', 'chooseAgentPreset', 'checkAgent', 'cancelAgentCheck'].includes(name)
            ? this.agentAction(() => action(node))
            : this.perform(
                () => {
                  if (node?.session) this.assertSession(node.session);
                  return action(node);
                },
                navigation.has(name) ? undefined : 'Working…',
                node?.kind === 'task' ? `task:${node.task.id}` : node?.kind === 'setting' ? 'settings' : 'repository',
              ),
        ),
      );
  }
  private render() {
    const status = this.conversations.configuration().status;
    if (status !== this.agentConfigurationStatus) {
      this.agentConfigurationStatus = status;
      void vscode.commands.executeCommand('setContext', 'warden.agentConfiguration', status);
    }
    const readiness = this.agentSetup.readiness.snapshot().status;
    if (readiness !== this.agentReadinessStatus) {
      this.agentReadinessStatus = readiness;
      void vscode.commands.executeCommand('setContext', 'warden.agentReady', this.agentReady);
      void vscode.commands.executeCommand('setContext', 'warden.agentReadiness', readiness);
    }
    const setupRequired = this.repositoryState !== 'loading' && !this.agentReady && (status !== 'configured' || !this.agentSetup.connecting);
    if (setupRequired !== this.agentSetupRequired) {
      this.agentSetupRequired = setupRequired;
      void vscode.commands.executeCommand('setContext', 'warden.agentSetupRequired', setupRequired);
    }
    if (!this.agentReady) {
      this.commitInput?.hide();
      this.taskInput?.hide();
    }
    if (this.agentReady && this.repositoryState === 'ready' && !this.branchTransition && this.data?.workflow) {
      const preview = this.preview;
      const sync = preview?.syncStatus ?? preview?.status ?? 'disconnected';
      const problem = ['stale', 'conflict', 'error', 'paused'].includes(sync) || preview?.setup?.status === 'failed';
      this.status.text = `$(${problem ? 'warning' : sync === 'updating' ? 'sync~spin' : 'layers'}) Warden: ${previewStatusLabels[sync]}${preview?.setup?.status === 'failed' ? ' · Preview setup failed' : ''}`;
      this.status.backgroundColor = problem ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      this.status.tooltip = `${this.previewSummary()}\nShow Preview Output`;
      this.status.show();
    } else this.status.hide();
    this.sidebar?.refresh();
    this.settings?.refresh();
    this.views.render();
  }
  private get agentReady() {
    return this.conversations.configuration().status === 'configured' && this.agentSetup.readiness.snapshot().status === 'ready';
  }
  private async agentAction(action: () => unknown | Promise<unknown>) {
    if (this.closing || !vscode.workspace.isTrusted) return;
    this.errors.delete('agent');
    try {
      return await action();
    } catch (error) {
      this.report(error, 'agent');
    } finally {
      if (!this.closing) this.render();
    }
  }
  private api<K extends EngineCommand>(command: K, request: EngineInput<K>): Promise<EngineOutput<K>> {
    if (!this.backend) throw new Error('Run Warden: Select Repository first.');
    const branch = command === 'workflow.configure' || command === 'config.save' ? this.configuredBranch : this.branch;
    return this.backend.execute(command, request, { developmentBranch: branch ?? null });
  }
  private async perform<T>(action: () => T | Promise<T>, busy?: string, scope = 'repository') {
    if (!vscode.workspace.isTrusted) {
      this.report(new Error('Trust this workspace first.'), scope);
      return;
    }
    if (this.closing) return;
    if (!this.agentReady) {
      await vscode.commands.executeCommand('warden.task.focus');
      return;
    }
    if (this.initializing || this.switching || this.branchTransition) {
      this.report(new Error('The repository or base branch is changing. Retry shortly.'), scope);
      return;
    }
    if (busy && this.active) {
      this.report(new WardenError(409, 'Another operation is running. Wait for its result before retrying.', 'operation_busy'), scope);
      return;
    }
    this.errors.delete(scope);
    const operation = Promise.resolve().then(action);
    if (!busy) this.navigation.add(operation);
    if (busy) {
      this.active = operation;
      this.busy = busy;
      this.render();
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
      this.render();
    }
  }
  private report(error: unknown, scope = 'repository') {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof WardenError ? error.code : undefined;
    this.errors.set(scope, { scope, message, code });
    this.log.write('error', 'workbench.action.failed', { scope, code, diagnostic: acpErrorDiagnostic(error) });
    this.render();
    if (!(this.settings?.view.visible && ['settings', 'agent', 'repository'].includes(scope)) && !this.views.displaysError(scope))
      void vscode.window.showErrorMessage(`Warden: ${message}`);
  }
  async initialize() {
    const span = this.activation ?? this.performance.start('activation');
    this.activation = undefined;
    let outcome: PerformanceOutcome = 'error';
    try {
      this.initializing = true;
      let failed = false;
      try {
        await this.updateContext(span);
        this.render();
        const folders = vscode.workspace.workspaceFolders;
        const remembered = this.context.workspaceState.get<string>('warden.repository');
        const folder = folders?.find((candidate) => candidate.uri.fsPath === remembered) ?? (folders?.length === 1 ? folders[0] : undefined);
        if (folder) await this.open(folder.uri.fsPath, span);
      } catch (error) {
        failed = true;
        this.log.write('error', 'extension.initialize.failed', { diagnostic: acpErrorDiagnostic(error) });
      } finally {
        this.initializing = false;
        await this.updateContext(span);
        this.agentSetup.start();
        this.render();
      }
      outcome = failed ? 'error' : 'ok';
    } finally {
      span.end(outcome);
    }
  }
  private open(directory: string, parent?: PerformanceSpan) {
    return this.performance.measure('repository.open', (span) => this.openRepository(directory, span), parent);
  }
  private async openRepository(directory: string, span: PerformanceSpan) {
    const previous = this.backend;
    // Retire the old engine before awaiting UI work so its observer cannot start a
    // refresh with the replacement repository's revision while it is draining.
    this.backend = undefined;
    this.commitInput?.hide();
    this.taskInput?.hide();
    this.switching = true;
    this.repositoryRevision++;
    this.session = randomUUID();
    this.invalidateChecks();
    this.status.hide();
    try {
      // Publish menu contexts while the old native tree still exists; replacing
      // its roots first lets VS Code rerender removed rows during context updates.
      await this.updateContext(span);
      this.render();
      await span.measure('repository.wait', async () => {
        await Promise.allSettled([...this.navigation]);
        await this.reading;
        await previous?.close();
      });
      this.backend = await span.measure('engine.open', () => Engine.open(directory, undefined, this.log));
      // The primary path is known now; agent readiness does not depend on Git inventories
      // or advisory synchronization checks. Repository loading still gates navigation.
      this.agentSetup.start();
      this.selected = undefined;
      this.branch = undefined;
      this.configuredBranch = undefined;
      this.checkoutBranch = undefined;
      this.expanded = this.context.workspaceState.get<Record<string, boolean>>(`warden.expanded:${this.backend.root}`, {});
      this.selectedFiles = this.context.workspaceState.get<Record<string, string>>(`warden.files:${this.backend.root}`, {});
      this.rebaseSelection = undefined;
      this.messages = this.context.workspaceState.get<Record<string, string>>(`warden.messages:${this.backend.root}`, {});

      this.errors.clear();
      this.checkSignature = undefined;
      this.rebaseResult = undefined;
      await this.context.workspaceState.update('warden.repository', this.backend.root);
      this.data = undefined;
      this.preview = undefined;

      this.checks = undefined;
      this.checkouts = undefined;
      this.files.clear();
      this.fileErrors.clear();
      this.taskTargets.clear();
      this.reviews.clear();
      this.observedReviews.clear();
      this.reviewUris.clear();
      await span.measure('repository.refresh', (refresh) => this.refresh(false, refresh));
    } catch (error) {
      await this.backend?.close();
      this.backend = undefined;
      throw error;
    } finally {
      this.switching = false;
      await this.updateContext(span);
      if (this.backend)
        await span.measure('review.restore', () =>
          Promise.all(
            this.tasks()
              .filter((task) => task.worktree && (this.expanded[task.id] || this.reviews.has(task.id)))
              .map((task) => this.getChildren({ kind: 'task', task })),
          ),
        );
      this.render();
    }
  }
  private async selectRepository() {
    const selected = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the repository containing the primary folder' });
    if (selected) await this.open(selected.uri.fsPath);
  }
  private get repositoryState(): WorkbenchModel['repositoryState'] {
    if (this.initializing || this.switching) return 'loading';
    return this.backend ? 'ready' : 'unselected';
  }
  private updateContext(trace?: PerformanceSpan): Promise<void> {
    const update = async () => {
      if (this.closing) return;
      const state = this.repositoryState;
      const session = this.session;
      const hasRepository = state === 'ready';
      const preview = hasRepository && this.data?.workflow ? this.preview : undefined;
      const sync = preview?.syncStatus ?? preview?.status;
      const publish = async (key: string, value: unknown) => {
        if (this.contextValues.has(key) && this.contextValues.get(key) === value) return;
        await vscode.commands.executeCommand('setContext', key, value);
        this.contextValues.set(key, value);
      };
      // Preserve the loading/ready barrier, while avoiding repeated remote round trips
      // for flags that have already been acknowledged by the workbench.
      if (state === 'loading') await publish('warden.repositoryState', state);
      const published = await Promise.allSettled([
        publish('warden.hasRepository', hasRepository),
        publish('warden.hasDevelopmentBranch', hasRepository && !!this.data?.workflow),
        publish('warden.fileViewMode', this.sidebar.fileViewMode),
        publish('warden.multipleRoots', (vscode.workspace.workspaceFolders?.length ?? 0) > 1),
        publish('warden.hasPreviewCommand', hasRepository && !!this.previewCommand()?.trim()),
        publish('warden.hasPreviewSetup', hasRepository && !!this.data?.workspaceConfig?.previewSetup?.trim()),
        publish('warden.previewNeedsSync', !!sync && ['stale', 'conflict', 'error', 'paused'].includes(sync)),
        publish('warden.previewSetupFailed', preview?.setup?.status === 'failed'),
      ]);
      const failed = published.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (state !== 'loading' && state === this.repositoryState && session === this.session) await publish('warden.repositoryState', state);
    };
    const previous = this.contextUpdate;
    const publish = () => previous.then(update);
    const pending = trace ? trace.measure('context.update', publish) : publish();
    // A failed publication is retried by the next update; it must not poison the queue.
    this.contextUpdate = pending.catch(() => {});
    return pending;
  }
  private previewCommand() {
    const resource = this.backend ? vscode.Uri.file(this.backend.root) : null;
    const value = vscode.workspace.getConfiguration('warden', resource).get<unknown>('previewCommand');
    return typeof value === 'string' ? value : undefined;
  }
  private async changeBranch(data: WorkflowResponse, checkoutBranch?: string) {
    this.commitInput?.hide();
    this.taskInput?.hide();
    this.branchTransition = true;
    this.session = randomUUID();
    this.invalidateChecks();
    this.branch = data.workflow?.developmentBranch;
    this.checkoutBranch = checkoutBranch;
    this.selected = undefined;

    this.checks = undefined;
    this.rebaseSelection = undefined;
    this.rebaseResult = undefined;
    this.reviews.clear();
    this.observedReviews.clear();
    this.files.clear();
    this.fileErrors.clear();
    this.taskTargets.clear();
    this.errors.clear();
    try {
      const saved = await this.branchViews.load(this.backend!.root, data);
      this.selected = saved.selected;
    } finally {
      this.branchTransition = false;
    }
  }
  refresh(afterMutation = false, trace?: PerformanceSpan): Promise<void> {
    // A read begun before a write cannot acknowledge that write to the next user action.
    if (this.reading) return afterMutation ? this.reading.catch(() => {}).then(() => this.refresh(true)) : this.reading;
    if (!this.backend || this.closing) return Promise.resolve();
    this.reading = (async () => {
      const engine = this.backend!;
      const revision = this.repositoryRevision;
      const currentRepository = () => !this.closing && engine === this.backend && revision === this.repositoryRevision;
      const measure = <T>(stage: PerformanceStage, operation: () => Promise<T>) => (trace ? trace.measure(stage, operation) : operation());
      for (let attempt = 0; attempt < 3; ++attempt) {
        let { workflow: data, preview, workspaces: checkouts } = await measure('repository.get', () => engine.execute('repository.get', undefined));
        if (!currentRepository()) return;
        // Migrate the old repository-wide UI state into its original requirement before following Git.
        if (this.branch === undefined && data.workflow) await this.branchViews.load(engine.root, data);
        const primary = checkouts.worktrees.find((row) => row.isMain && !row.shared && !row.clone);
        const tracked = !!primary?.branch && !!data.workflow?.trackedBranches?.includes(primary.branch);
        let branchProblem: WorkbenchError | undefined;
        if (
          tracked &&
          data.workflow &&
          primary?.branch &&
          !primary.detached &&
          !primary.busy &&
          !primary.foreign &&
          primary.branch !== data.workflow.developmentBranch
        ) {
          const previous = data.workflow.developmentBranch;
          try {
            await measure('workflow.configure', () => engine.execute('workflow.configure', { branch: primary.branch! }, { developmentBranch: previous }));
            continue;
          } catch (error) {
            if (error instanceof WardenError && error.code === 'requirement_changed') continue;
            if (!(error instanceof WardenError) || !['development_in_use', 'operation_locked'].includes(error.code ?? '')) throw error;
            branchProblem = {
              scope: 'repository',
              code: error.code,
              message: `The primary folder switched to ${primary.branch}, but Warden is still on ${previous}. ${
                error.code === 'development_in_use'
                  ? `Switch back to ${previous} to finish commit preparation and disconnect preview connections.`
                  : error.message
              }`,
            };
          }
        }
        const current = await measure('workflow.context', () => engine.execute('workflow.context', undefined));
        if (!currentRepository()) return;
        if (current.developmentBranch !== data.workflow?.developmentBranch) continue;
        // A Git checkout is not consent to track a new requirement. Keep saved engine
        // state for returning to its branch, but expose no task or preview state here.
        if (!tracked || primary?.detached) data = { workflow: null, workspaceConfig: data.workspaceConfig, legacyTodos: data.legacyTodos };
        const branch = data.workflow?.developmentBranch;
        const changedBranch = branch !== this.branch || primary?.branch !== this.checkoutBranch || current.developmentBranch !== this.configuredBranch;
        const checkSignature = JSON.stringify([
          branch,
          data.developmentHead,
          checkouts.worktrees.map((row) => [row.path, row.head, row.branch, row.dirty, row.busy, row.foreign, row.prunable, row.clone, row.shared]),
          data.workflow?.changes.map((task) => [
            task.id,
            task.status,
            task.developmentBranch,
            task.worktree,
            task.branch,
            task.base,
            task.worktree ? task.sourceBase : undefined,
          ]),
        ]);
        if (data.workflow && (this.preview?.status !== preview.status || this.preview?.syncStatus !== preview.syncStatus))
          this.log.write(preview.syncStatus === 'error' || preview.syncStatus === 'conflict' ? 'warn' : 'info', 'preview.state', {
            status: preview.status,
            syncStatus: preview.syncStatus,
            connections: preview.connectedIds.length,
          });
        this.data = data;
        this.configuredBranch = current.developmentBranch;
        this.preview = data.workflow ? preview : undefined;
        this.checkouts = checkouts;
        if (changedBranch) await this.changeBranch(data, primary?.branch);
        if (!currentRepository()) return;

        this.scheduleChecks(engine, checkSignature, !!trace);
        if (branchProblem) {
          if (this.errors.get('branch')?.message !== branchProblem.message)
            this.log.write('warn', 'repository.branch.blocked', { code: branchProblem.code, diagnostic: branchProblem.message });
          this.errors.set('branch', branchProblem);
        } else this.errors.delete('branch');
        await this.updateContext(trace);
        if (!currentRepository()) return;
        this.render();
        for (const key of this.files.keys()) {
          try {
            const response = await engine.execute('review.files', { key });
            if (!currentRepository()) return;
            this.files.set(key, response.files);
          } catch {
            if (!currentRepository()) return;
            this.files.delete(key);
          }
        }
        await measure('review.restore', async () => {
          await Promise.all(
            this.tasks()
              .filter((task) => task.worktree && (this.expanded[task.id] || this.reviews.has(task.id)))
              .map((task) => this.getChildren({ kind: 'task', task })),
          );
        });
        if (!currentRepository()) return;
        this.render();
        if (current.developmentBranch)
          await measure('engine.start', () =>
            engine.start(
              () => this.refresh(),
              (error) => {
                this.log.write('error', 'repository.refresh.failed', { diagnostic: acpErrorDiagnostic(error) });
                if (!(error instanceof WardenError && error.code === 'operation_locked')) {
                  this.errors.set('repository', { scope: 'repository', message: String(error) });
                  this.render();
                }
              },
            ),
          );
        return;
      }
      throw new WardenError(409, 'The base branch is changing. Refresh shortly.', 'requirement_changed');
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  private invalidateChecks() {
    this.checkRevision++;
    this.checkSignature = undefined;
    this.pendingCheck = undefined;
    this.checks = undefined;
    this.checkingRebase = false;
    this.errors.delete('rebase');
  }
  private scheduleChecks(engine: Engine, signature: string, traced: boolean) {
    if (signature === this.checkSignature) return;
    this.invalidateChecks();
    this.checkSignature = signature;
    if (!this.data?.workflow) return;
    const tasks = this.tasks().filter((task) => task.worktree && task.status !== 'accepted');
    this.checks = {
      checks: tasks.map((task) => ({
        changeId: task.id,
        sourceHead: '',
        developmentHead: this.data?.developmentHead ?? '',
        status: 'unknown',
        checkedAt: new Date().toISOString(),
        message: 'Checking synchronization…',
      })),
    };
    if (!tasks.length) return;
    this.checkingRebase = true;
    this.errors.delete('rebase');
    this.pendingCheck = {
      engine,
      session: this.session,
      revision: this.checkRevision,
      head: this.data.developmentHead,
      tasks: tasks.map((task) => task.id).sort(),
      traced,
    };
    // Keep one running check and only the latest queued observation. Frequent file events
    // must not launch competing replay trials or publish results for a replaced task binding.
    this.startChecks();
  }
  private startChecks() {
    if (!this.checkReading && this.pendingCheck && !this.closing) {
      this.checkReading = this.readChecks().finally(() => {
        this.checkReading = undefined;
        this.startChecks();
      });
    }
  }
  private async readChecks() {
    while (this.pendingCheck && !this.closing) {
      const request = this.pendingCheck;
      this.pendingCheck = undefined;
      const current = () => !this.closing && request.engine === this.backend && request.session === this.session && request.revision === this.checkRevision;
      try {
        const read = () => request.engine.execute('rebase.check', undefined);
        const result = await (request.traced ? this.performance.measure('rebase.check', read) : read());
        if (!current()) continue;
        const context = await request.engine.execute('workflow.context', undefined);
        if (!current()) continue;
        if (
          context.developmentBranch !== this.branch ||
          JSON.stringify(result.checks.map((check) => check.changeId).sort()) !== JSON.stringify(request.tasks) ||
          result.checks.some((check) => {
            const task = this.tasks().find((task) => task.id === check.changeId);
            const source = this.checkouts?.worktrees.find((row) => row.path === task?.worktree);
            return check.developmentHead !== request.head || (!!check.sourceHead && !!source?.head && check.sourceHead !== source.head);
          })
        ) {
          this.checkSignature = undefined;
          for (const check of this.checks?.checks ?? []) check.message = 'Code changed during the check. Refresh and retry.';
        } else {
          this.checks = result;
          this.errors.delete('rebase');
        }
      } catch (error) {
        if (current()) {
          this.checkSignature = undefined;
          for (const check of this.checks?.checks ?? []) check.message = 'Synchronization check failed. Check again to retry.';
          this.report(error, 'rebase');
        }
      } finally {
        if (current()) {
          this.checkingRebase = false;
          this.render();
        }
      }
    }
  }
  private workspaceRow(task: WorkflowTask): WorkspaceRow {
    const source = this.preview?.sources?.find((row) => row.changeId === task.id);
    const connected = this.preview?.connectedIds.includes(task.id);
    const sync = this.checks?.checks.find((check) => check.changeId === task.id);
    const connection = task.worktree
      ? connected
        ? `Preview: ${source ? previewStatusLabels[source.status] : 'Out of Date'}`
        : 'Not in Preview'
      : task.status === 'archived'
        ? 'Archived'
        : task.workspaceError
          ? 'Workspace Allocation Failed'
          : 'Prepared on first use';
    const problem = source?.status === 'conflict' || source?.status === 'error';
    const activity = this.backend && this.conversations.activity(this.backend.root, task.id);
    const facts = [
      activity === 'Agent: Permission Required' ? activity : '',
      task.integration?.error ? 'Commit Failed' : '',
      problem ? connection : '',
      this.reviews.has(task.id) && !sameReview(this.reviews.get(task.id), this.observedReviews.get(task.id)) ? 'Review Out of Date' : '',
      task.worktree && task.workspaceHook?.status === 'failed' ? 'Setup Failed' : '',
      activity !== 'Agent: Permission Required' ? activity : '',
      task.status === 'integrating' ? 'Pending Commit' : '',
      !problem ? connection : '',
      task.agent,
    ].filter(Boolean);
    const target = this.taskTargets.get(task.id);
    return {
      task,
      expanded: !!this.expanded[task.id],
      description: facts.slice(0, 2).join(' · '),
      tooltip: [task.title, task.body, task.worktree, task.workspaceError?.message, facts.join(' · '), sync?.status !== 'current' ? sync?.message : '']
        .filter(Boolean)
        .join('\n\n'),
      files: target ? this.files.get(target) : undefined,
      filesError: this.fileErrors.get(task.id),
      review: this.reviews.get(task.id),
    };
  }
  async getChildren(node?: Node): Promise<SidebarNode[]> {
    if (!this.agentReady) return [];
    if (this.repositoryState !== 'ready' || this.branchTransition || !this.data?.workflow) return [];
    const session = this.session;
    if (node?.session && node.session !== session) return [];
    if (node?.kind === 'task' && !this.tasks().some((task) => task.id === node.task.id)) return [];
    if (!node) return this.tasks().map((task) => ({ kind: 'task', task }));
    let target: string;
    let review: TaskReview | undefined;
    try {
      if (node.kind === 'task' && node.task.worktree) {
        review = await this.readReview(node.task.id);
        if (!review || session !== this.session) return [];
        target = review.targetKey;
        const previous = this.taskTargets.get(node.task.id);
        if (previous && previous !== target) this.files.delete(previous);
        this.taskTargets.set(node.task.id, target);
      } else if (node.kind === 'commit') target = formatTargetKey({ kind: 'commit', sha: node.sha });
      else return [];
      const response = await this.api('review.files', { key: target });
      if (session !== this.session) return [];
      this.files.set(target, response.files);
      if (node.kind === 'task') this.fileErrors.delete(node.task.id);
      return response.files.map((file) => ({ kind: 'file', file, target, ...(node.kind === 'task' ? { task: node.task, review } : {}) }));
    } catch (error) {
      if (session !== this.session) return [];
      this.log.write('error', 'review.files.failed', { diagnostic: acpErrorDiagnostic(error) });
      if (node.kind === 'task') this.fileErrors.set(node.task.id, error instanceof Error ? error.message : String(error));
      return [];
    }
  }
  private tasks() {
    return this.data?.workflow?.changes.filter((c) => c.developmentBranch === this.data?.workflow?.developmentBranch) ?? [];
  }
  private async readReview(changeId: string) {
    const session = this.session;
    for (let attempt = 0; attempt < 3; ++attempt) {
      try {
        const review = await this.api('task.review', { taskId: changeId });
        if (session !== this.session) return undefined;
        if (review) this.observedReviews.set(changeId, review);
        else this.observedReviews.delete(changeId);
        return review;
      } catch (error) {
        if (session !== this.session) return undefined;
        // A concurrent agent commit can invalidate an observation before it is displayed.
        // Retry only the read; pinned reviews and all delivery guards remain unchanged.
        if (!(error instanceof WardenError) || error.code !== 'review_changed' || attempt === 2) throw error;
      }
    }
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
    const session = this.session;
    if (node?.session) this.assertSession(node.session);
    const task = node?.kind === 'task' || node?.kind === 'file' || node?.kind === 'folder' ? node.task : undefined;
    if (task) return this.tasks().find((c) => c.id === task.id);
    const picked = await vscode.window.showQuickPick(
      this.tasks().map((task) => ({ label: task.title, task })),
      { placeHolder: 'Select a task' },
    );
    this.assertSession(session);
    return this.tasks().find((task) => task.id === picked?.task.id);
  }
  private async configure() {
    const session = this.session;
    const list = await this.api('workspaces.list', undefined);
    const branch = await vscode.window.showQuickPick(
      list.branches.map((b) => b.name),
      { placeHolder: 'Select the base branch checked out in the primary folder' },
    );
    if (branch) {
      this.assertSession(session);
      const current = await this.api('workspaces.list', undefined);
      const primary = current.worktrees.find((row) => row.isMain && !row.shared && !row.clone);
      if (primary?.branch !== branch || primary.detached || primary.busy)
        throw new Error('Check out this base branch in the primary folder and finish the current Git operation first.');
      await this.api('workflow.configure', { branch });
      await this.refresh(true);
      await this.api('preview.refresh', undefined);
    }
  }
  private async createTask() {
    if (this.taskInput) {
      this.taskInput.show();
      return;
    }
    if (!this.data?.workflow) await this.configure();
    await this.refresh(true);
    if (!this.backend || !this.branch) return;
    const session = this.session;
    const key = `warden.newTask:${this.backend.root}:${this.branch}`;
    const input = vscode.window.createInputBox();
    this.taskInput = input;
    input.title = `New Task · ${this.branch}`;
    input.prompt = 'Enter a task title. Enter to create, Escape to cancel.';
    input.placeholder = 'Task title';
    input.value = this.context.workspaceState.get<string>(key, '');
    input.ignoreFocusOut = true;
    const validate = (value: string) =>
      !value.trim() ? 'Enter a task title.' : value.trim().length > 200 ? 'Task titles cannot exceed 200 characters.' : undefined;
    const subscriptions: vscode.Disposable[] = [];
    let title: string | undefined;
    try {
      title = await new Promise<string | undefined>((resolve) => {
        subscriptions.push(
          input.onDidChangeValue((value) => {
            input.validationMessage = validate(value);
          }),
          input.onDidAccept(() => {
            input.validationMessage = validate(input.value);
            if (input.validationMessage) return;
            resolve(input.value.trim());
            input.hide();
          }),
          input.onDidHide(() => resolve(undefined)),
        );
        input.show();
      });
    } finally {
      await this.context.workspaceState.update(key, input.value);
      for (const subscription of subscriptions) subscription.dispose();
      input.dispose();
      if (this.taskInput === input) this.taskInput = undefined;
    }
    if (title === undefined) return;
    this.assertSession(session);
    const taskId = await this.handleAction({ type: 'task.create', title, body: '' }, session);
    if (taskId && session === this.session && !this.errors.has('task:new')) {
      await this.context.workspaceState.update(key, undefined);
      await this.sidebar.select(taskId);
    }
  }
  private async taskAction(node: Node | undefined, type: 'task.brief' | 'task.restore') {
    const session = this.session;
    const task = await this.pickTask(node);
    if (task) await this.handleAction({ type, taskId: task.id }, session);
  }
  private async moveTaskBy(node: Node | undefined, direction: -1 | 1) {
    const selected = node ?? this.sidebar.view.selection[0];
    if (!selected || (selected.kind !== 'task' && selected.kind !== 'file' && selected.kind !== 'folder')) return;
    const session = this.session;
    const task = await this.pickTask(selected);
    this.assertSession(session);
    if (!task) return;
    const tasks = this.tasks();
    const index = tasks.findIndex((row) => row.id === task.id);
    if (index + direction < 0 || index + direction >= tasks.length) return;
    await this.api('task.move', { taskId: task.id, before: tasks[direction < 0 ? index - 1 : index + 2]?.id ?? null });
  }
  private async rememberExpansion(node: Node, expanded: boolean) {
    if (node.kind !== 'task' || !this.backend || (node.session && node.session !== this.session)) return;
    this.expanded[node.task.id] = expanded;
    await this.context.workspaceState.update(`warden.expanded:${this.backend.root}`, this.expanded);
  }
  private async selectTask(node?: Node, action: 'review' | 'edit' | 'select' = 'review', refreshReview = false) {
    const session = this.session;
    let task = await this.pickTask(node);
    if (!task || session !== this.session) return;
    // Older plans receive their workspace on use, never from a background refresh.
    if (!task.worktree && task.status === 'planned' && action !== 'edit') task = await this.ensureWorkspace(task);
    this.selected = task.id;
    await this.branchViews.select(this.backend!.root, task.developmentBranch, task.id);
    if (session !== this.session) return;
    this.render();
    if (action === 'edit') await this.views.show('task');
    if (session !== this.session) return;
    if (action === 'review' && task.worktree) {
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
  private async ensureWorkspace(task: WorkflowTask) {
    if (task.worktree) return task;
    const session = this.session;
    const ready = await this.api('task.start', { taskId: task.id });
    this.assertSession(session);
    this.errors.delete(`task:${task.id}`);
    await this.refresh(true);
    this.assertSession(session);
    return ready;
  }
  private async showTaskOutput(node?: Node) {
    const task = await this.pickTask(node);
    if (!task?.worktree) return;
    const hook = task.workspaceHook;
    this.output.appendLine([task.title, hook?.command, `Exit code: ${hook?.exitCode ?? '—'}`, hook?.output ?? 'No output'].filter(Boolean).join('\n'));
    this.output.show(true);
  }
  private async showTaskHistory(node?: Node) {
    const session = this.session;
    const task = await this.pickTask(node);
    if (!task?.worktree) return;
    if (!task.deliveries?.length) {
      void vscode.window.showInformationMessage('This task has no commits on the base branch yet.');
      return;
    }
    const delivery = await vscode.window.showQuickPick(
      task.deliveries.map((delivery) => ({
        label: delivery.message.split('\n')[0]!,
        description: delivery.commit.slice(0, 8),
        detail: delivery.message,
        delivery,
      })),
      { title: `${task.title} · Commits to ${task.developmentBranch}` },
    );
    this.assertSession(session);
    if (!delivery) return;
    const files = (await this.getChildren({ kind: 'commit', sha: delivery.delivery.commit, message: delivery.delivery.message })).filter(
      (node) => node.kind === 'file',
    );
    const selected = await vscode.window.showQuickPick(
      files.map((node) => ({ label: node.file.path, node })),
      { placeHolder: 'Select a file to review' },
    );
    this.assertSession(session);
    if (selected) await this.openDiff(selected.node);
  }
  private async moveTask(node?: Node) {
    const session = this.session;
    const task = await this.pickTask(node);
    if (!task) return;
    const before = await vscode.window.showQuickPick([
      { label: 'Move to End', id: null as string | null },
      ...this.tasks()
        .filter((t) => t.id !== task.id)
        .map((t) => ({ label: `Move before “${t.title}”`, id: t.id })),
    ]);
    this.assertSession(session);
    if (before) await this.api('task.move', { taskId: task.id, before: before.id });
  }
  private async connect(node?: Node) {
    const selected = await this.pickTask(node);
    if (!selected) return;
    const task = await this.ensureWorkspace(selected);
    const current = await this.api('preview.get', undefined);
    await this.api('preview.connect', {
      connectedIds: current.connectedIds.includes(task.id) ? current.connectedIds.filter((id) => id !== task.id) : [...current.connectedIds, task.id],
    });
  }
  private async openDiff(node?: Node, selection?: vscode.Range) {
    if (node?.kind !== 'file') return;
    const session = this.session;
    if (node.task) {
      if (!this.tasks().some((task) => task.id === node.task!.id)) throw new Error('This task does not belong to the current base branch.');
      this.selected = node.task.id;
      this.selectedFiles[node.task.id] = node.file.path;
      await this.branchViews.select(this.backend!.root, node.task.developmentBranch, node.task.id);
      await this.context.workspaceState.update(`warden.files:${this.backend!.root}`, this.selectedFiles);
      this.assertSession(session);
    }
    const review = node.review;
    if (node.task && (!review || !sameReview(review, await this.readReview(node.task.id))))
      throw new Error('The review is out of date. Refresh the file list and reopen the diff.');
    const key = node.target;
    const latest = (await this.api('review.files', { key })).files.find((f) => f.path === node.file.path);
    this.assertSession(session);
    if (!latest) throw new Error('The file diff changed. Refresh and retry.');
    if (latest.binary) {
      if (review) await this.rememberReview(review);
      void vscode.window.showInformationMessage(
        `This file has binary changes. Review this version with an external tool: ${review?.sourceHead ?? review?.preparation?.head ?? node.target}`,
      );
      return;
    }
    const read = (side: 'old' | 'new') => this.api('review.file', { key, file: side === 'old' ? (latest.oldPath ?? latest.path) : latest.path, side });
    const [old, current] = await Promise.all([read('old'), read('new')]);
    const after = (await this.api('review.files', { key })).files.find((f) => f.path === latest.path);
    this.assertSession(session);
    if (after?.contentHash !== latest.contentHash) throw new Error('The file changed while reading. Reopen the diff.');
    if (review) {
      if (!sameReview(review, await this.readReview(review.changeId))) throw new Error('The review version changed while reading. Reopen the diff.');
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
      [node.task?.title ?? 'Commit', latest.path, fileModeChange(latest), version?.slice(0, 8)].filter(Boolean).join(' · '),
      { preview: true, selection },
    );
    this.render();
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
    if (!recovery && !sameReview(pinned, await this.readReview(task.id)))
      throw new Error('Reopen the task diff and review the full current changes before committing.');
    if (recovery || record) {
      await this.perform(() => this.deliver({ kind: 'task', task }), 'Recovering Commit…', `task:${task.id}`);
      return;
    }
    if (pinned?.preparation ? !pinned.preparation.canCommit : !pinned?.sourceHead || !pinned.developmentHead)
      throw new Error(pinned?.preparation?.message ?? 'The task workspace is unavailable. Resolve its Git operation, then reopen the diff.');
    const input = vscode.window.createInputBox();
    this.commitInput = input;
    input.title = `${task.title} · Commit to ${task.developmentBranch}`;
    input.prompt = 'Enter a commit message. Enter to commit, Escape to cancel.';
    input.placeholder = 'Commit message';
    input.value = this.messages[task.id] ?? task.title;
    input.ignoreFocusOut = true;
    const validate = (value: string) =>
      !value.trim() ? 'Enter a commit message.' : value.length > 10000 ? 'Commit messages cannot exceed 10,000 characters.' : undefined;
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
          throw new Error('The review changed while typing. Reopen the diff before committing.');
        await this.deliver({ kind: 'task', task }, message);
      },
      'Committing…',
      `task:${task.id}`,
    );
  }
  private async deliver(node?: Node, submittedMessage?: string) {
    const task = await this.pickTask(node);
    if (!task?.worktree) return;
    const current = await this.readReview(task.id);
    if (task.integration && !task.integration.prepared && !current?.preparation) {
      await this.api('task.prepare', {
        taskId: task.id,
        sourceHead: task.integration.source,
        sourceTree: task.integration.sourceTree,
        developmentHead: task.integration.parent,
      });
      this.reviews.delete(task.id);
      void vscode.window.showInformationMessage('Commit preparation was recovered. Reopen the diff to review the contents preserved in the primary folder.');
      return;
    }
    const review = this.reviews.get(task.id);
    if (!review || !sameReview(review, current))
      throw new Error('Reopen the task diff and review the full current changes before committing to the base branch.');
    const p = review.preparation;
    if (p?.canRecord && p.head) {
      await this.api('task.accept', { taskId: task.id, mode: 'record', commit: p.head });
      this.reviews.delete(task.id);
      return;
    }
    if (p ? !p.canCommit : !review.sourceHead || !review.developmentHead)
      throw new Error(p?.message ?? 'The task workspace is unavailable. Resolve its Git operation, then reopen the diff.');
    const message = submittedMessage ?? this.messages[task.id] ?? task.title;
    if (!message?.trim()) return;
    if (!sameReview(review, await this.readReview(task.id)))
      throw new Error('The review is out of date. Reopen the diff before committing to the base branch.');
    if (p) {
      await this.api('task.accept', { taskId: task.id, mode: 'commit', developmentHead: p.head!, indexFingerprint: p.indexFingerprint!, message });
    } else {
      await this.api('task.deliver', {
        taskId: task.id,
        sourceHead: review.sourceHead!,
        sourceTree: review.sourceTree,
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
  private previewSummary(preview = this.preview) {
    const names = preview?.connectedIds.map((id) => this.tasks().find((task) => task.id === id)?.title ?? id);
    return [
      `Preview: ${previewStatusLabels[preview?.syncStatus ?? preview?.status ?? 'disconnected']}`,
      `Base branch: ${this.branch ?? 'Not selected'}`,
      `Preview folder: ${preview?.worktree ?? 'Not initialized'}`,
      `Preview contents: Saved primary content${names?.length ? ` + ${names.join(' + ')}` : ''}`,
      preview?.updatedAt ? `Last successful sync: ${new Date(preview.updatedAt).toLocaleString('en-US')}` : '',
      preview?.message,
      preview?.conflicts?.length ? `Conflicting paths:\n${preview.conflicts.join('\n')}` : '',
      preview?.setup ? `Preview setup: ${scriptStatusLabels[preview.setup.status]} · Exit code ${preview.setup.exitCode ?? '—'}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  private async showPreviewOutput() {
    if (!this.data?.workflow) throw new Error('Select a base branch first.');
    const preview = await this.api('preview.get', undefined);
    this.output.appendLine(this.previewSummary(preview));
    if (preview.setup?.output) this.output.appendLine(preview.setup.output);
    this.output.show(true);
  }
  private async ensurePreview() {
    if (!this.data?.workflow) throw new Error('Select a base branch first.');
    let preview = await this.api('preview.get', undefined);
    if (!preview.worktree) preview = await this.api('preview.refresh', undefined);
    if (!preview.worktree) throw new Error(preview.message ?? 'Select a base branch and initialize the preview first.');
    return preview;
  }
  private async previewTerminal() {
    const session = this.session;
    const preview = await this.ensurePreview();
    this.assertSession(session);
    const repository = this.backend!.root;
    const existing = vscode.window.terminals.find((terminal) => {
      const options = terminal.creationOptions;
      if (terminal.exitStatus || !('cwd' in options)) return false;
      // Shell integration can tell us the user moved away from the preview directory.
      const cwd = terminal.shellIntegration?.cwd?.fsPath ?? (typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath);
      return (
        cwd !== undefined &&
        vscode.Uri.file(cwd).fsPath === vscode.Uri.file(preview.worktree!).fsPath &&
        options.env?.WARDEN_REPO === repository &&
        options.env?.WARDEN_PREVIEW === preview.worktree
      );
    });
    const terminal =
      existing ??
      vscode.window.createTerminal({ name: 'Warden · Preview', cwd: preview.worktree, env: { WARDEN_PREVIEW: preview.worktree!, WARDEN_REPO: repository } });
    terminal.show();
  }
  private async previewPath() {
    const preview = await this.ensurePreview();
    await vscode.env.clipboard.writeText(preview.worktree!);
    return preview.worktree;
  }
  private async runPreview() {
    const preview = await this.ensurePreview();
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.backend!.root));
    const command = this.previewCommand();
    if (!command?.trim()) {
      await this.previewTerminal();
      return;
    }
    const task = new vscode.Task(
      { type: 'warden' },
      folder ?? vscode.TaskScope.Workspace,
      'Run Preview',
      'Warden',
      new vscode.ShellExecution(command, { cwd: preview.worktree }),
      [],
    );
    await vscode.tasks.executeTask(task);
  }
  private async setup() {
    const result = await this.api('preview.setup', undefined);
    this.output.appendLine(result.setup?.output ?? 'No preview setup script configured');
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
    this.invalidateChecks();
    await this.refresh(true);
    while (this.checkReading) await this.checkReading;
  }
  private async copyWorkspace(node?: Node) {
    const task = await this.pickTask(node);
    if (task?.worktree) await vscode.env.clipboard.writeText(task.worktree);
  }
  private async openWorkspace(node?: Node) {
    const selected = await this.pickTask(node);
    if (!selected) return;
    const task = await this.ensureWorkspace(selected);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.worktree), { forceNewWindow: true });
  }
  private async openConversation(node?: Node) {
    const selected = await this.pickTask(node);
    if (!selected || !this.backend) return;
    const task = await this.ensureWorkspace(selected);
    await this.conversations.show(this.backend.root, task.id);
  }
  private async reviewConversation(binding: AcpBinding, reference?: string) {
    const file = reference === undefined ? undefined : await readWorkspaceReference(binding.workspace, reference);
    await this.perform(
      async () => {
        if (this.backend?.root !== binding.repository) await this.open(binding.repository);
        await this.refresh();
        const task = this.tasks().find((row) => row.id === binding.taskId && row.worktree === binding.workspace);
        if (!task) throw new Error('This task does not belong to the current base branch. Switch back to its base branch first.');
        if (file) {
          const line = (file.line ?? 1) - 1;
          const column = (file.column ?? 1) - 1;
          const selection = new vscode.Range(line, column, line, column);
          const changed = (await this.getChildren({ kind: 'task', task })).find((node) => node.kind === 'file' && node.file.path === file.path);
          if (changed) await this.openDiff(changed, selection);
          else {
            const uri = await this.documents.add(path.basename(file.path), file.content, binding.repository, file.path);
            await vscode.window.showTextDocument(uri, { preview: true, selection });
          }
        } else await this.selectTask({ kind: 'task', task });
      },
      'Opening Task Review…',
      `task:${binding.taskId}`,
    );
  }
  private async sendSelectionToAgent() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('Select the text to reference first.');
    const text = editor.document.getText(editor.selection);
    if (text.length > 80_000) throw new Error('The selection is too long. Select less text and retry.');
    const uri = editor.document.uri;
    const source = uri.scheme === 'warden-review' ? await this.documents.snapshot(uri) : undefined;
    const origin = source
      ? `Review snapshot (read-only): ${source.repository} / ${source.path}
Snapshot: ${uri.toString()}`
      : `File: ${uri.toString()}${editor.document.isDirty ? ' (includes unsaved content; for reference only)' : ''}`;
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + (editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line ? 0 : 1);
    const selected = await this.pickTask();
    if (!selected || !this.backend) return;
    const task = await this.ensureWorkspace(selected);
    await this.conversations.append(
      this.backend.root,
      task.id,
      `${origin}
Lines: ${start}–${end}
The following content is provided only as context:

${text}`,
    );
  }
  private async importNotes() {
    const selected = await vscode.window.showQuickPick(
      (this.data?.legacyTodos ?? []).map((todo) => ({ label: todo.title, description: todo.branch, todo })),
      { canPickMany: true, placeHolder: 'Select legacy notes to import as tasks' },
    );
    for (const item of selected ?? []) await this.api('task.import', { taskId: item.todo.id });
  }

  private model(surface: Surface): WorkbenchModel {
    const task = this.tasks().find((row) => row.id === this.selected);
    const review = task ? this.reviews.get(task.id) : undefined;
    if (!this.agentReady)
      return {
        session: this.session,
        repository: '',
        repositoryState: this.repositoryState,
        surface,
        agentConfiguration: this.conversations.configuration(),
        agentReadiness: this.agentSetup.readiness.snapshot(),
        hasPreviewCommand: false,
        reviewCurrent: false,
        message: '',
        errors: [...this.errors.values()].filter((error) => error.scope === 'agent'),
      };
    return {
      session: this.session,
      repository: this.repositoryState === 'ready' ? this.backend!.root : '',
      repositoryState: this.repositoryState,
      agentConfiguration: this.conversations.configuration(),
      agentReadiness: this.agentSetup.readiness.snapshot(),
      surface,
      workflow: this.repositoryState !== 'ready' || this.branchTransition ? undefined : this.data,
      task,
      workspaces: this.tasks().map((task) => this.workspaceRow(task)),
      preview: this.preview,
      hasPreviewCommand: !!this.previewCommand()?.trim(),
      checks: this.checks,
      checkingRebase: this.checkingRebase,
      rebaseResult: this.rebaseResult,
      rebaseSelection: this.rebaseSelection,
      review,
      reviewCurrent: !!task && sameReview(review, this.observedReviews.get(task.id)),
      message: task ? (this.messages[task.id] ?? task.title) : '',
      busy: this.branchTransition && this.data?.workflow ? 'Switching Base Branch…' : this.busy,
      errors: [...this.errors.values()],
    };
  }
  private async saveScript(binding: ScriptBinding, value: string): Promise<WorkspaceConfig> {
    const result = await this.perform(
      async () => {
        this.assertSession(binding.session);
        if (this.backend?.root !== binding.repository) throw new Error('Reopen the script from its original repository.');
        const current = (await this.api('workflow.get', undefined)).workspaceConfig ?? { hooks: {} };
        this.assertSession(binding.session);
        if (
          scriptValue(current, binding.kind) !== scriptValue(binding.config, binding.kind) ||
          (binding.kind === 'workspace' && JSON.stringify(current.hooks) !== JSON.stringify(binding.config.hooks))
        )
          throw new Error('This script changed since it was opened. Copy your draft, revert the editor, then reopen it from Settings.');
        const config: WorkspaceConfig = { ...current, hooks: { ...current.hooks } };
        if (binding.kind === 'preview') config.previewSetup = value;
        else if (binding.kind === 'reuse') config.hooks.reuse = value;
        else {
          config.hooks.create = value;
          // Preserve a distinct legacy reuse script; its own Settings row edits it explicitly.
          if (!current.hooks.reuse || current.hooks.reuse === current.hooks.create) config.hooks.reuse = value;
        }
        return this.api('config.save', { ...config, expected: current });
      },
      'Saving script…',
      'settings',
    );
    if (!result) throw vscode.FileSystemError.Unavailable(this.errors.get('settings')?.message ?? 'The script was not saved. Reconnect and reopen Settings.');
    return result;
  }
  private assertSession(session: string) {
    if (!this.agentReady) throw new Error('ACP is unavailable. Open Warden Settings to configure or reconnect the agent.');
    if (session !== this.session || this.initializing || this.switching || this.branchTransition)
      throw new Error('The repository or base branch changed. Retry from the current view.');
  }
  private async handleAction(action: WorkbenchAction, session: string) {
    if (action.type === 'settings.agents') {
      await this.agentAction(() => this.agentSetup.configure());
      return;
    }
    if (action.type === 'setup.agents') {
      await vscode.commands.executeCommand('warden.configureAgents');
      return;
    }
    if (action.type === 'setup.checkAgent' || action.type === 'setup.cancelAgentCheck') {
      await vscode.commands.executeCommand(action.type === 'setup.checkAgent' ? 'warden.checkAgent' : 'warden.cancelAgentCheck');
      return;
    }
    this.assertSession(session);
    if (action.type === 'setup.repository' || action.type === 'setup.branch') {
      await this.perform(() => (action.type === 'setup.repository' ? this.selectRepository() : this.configure()), 'Selecting…');
      return;
    }
    if (!this.backend) throw new Error('Select a repository first.');
    const taskId = 'taskId' in action ? action.taskId : undefined;
    const task = taskId ? this.tasks().find((row) => row.id === taskId) : undefined;
    if (taskId && !task) throw new Error('This task does not belong to the current base branch.');
    const node: Node | undefined = task ? { kind: 'task', task } : undefined;
    const scope = action.type.startsWith('task.') ? `task:${taskId ?? 'new'}` : action.type.split('.')[0]!;
    // Retained for old clients; native input owns cancellation before submission.
    if (action.type === 'task.cancelCreate') return;
    // Draft edits do not queue behind Git operations and cannot change their pinned inputs.
    if (action.type === 'task.message') {
      this.messages[action.taskId] = action.message;
      await this.context.workspaceState.update(`warden.messages:${this.backend.root}`, this.messages);
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
      'rebase.check',
    ];
    return this.perform(
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
            // Older clients keep their navigation action, but preview no longer has an editor panel.
            else if (action.surface === 'preview') await this.showPreviewOutput();
            else await this.views.show(action.surface);
            break;
          case 'task.select':
            await this.selectTask(node);
            break;
          case 'task.edit':
            await this.selectTask(node, 'edit');
            break;
          case 'task.history':
            await this.showTaskHistory(node);
            break;
          case 'task.output':
            await this.showTaskOutput(node);
            break;
          case 'task.options':
            await this.selectTask(node, 'select');
            break;
          case 'task.toggle':
            await this.rememberExpansion(node!, action.expanded);
            break;
          case 'task.file': {
            const file = (await this.getChildren(node)).find((entry) => entry.kind === 'file' && entry.file.path === action.path);
            if (!file) throw new Error('The file diff changed. Refresh the list.');
            await this.openDiff(file);
            break;
          }
          case 'task.move':
            if (action.before !== null && !this.tasks().some((row) => row.id === action.before))
              throw new Error('The target task does not belong to the current base branch.');
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
            if (created.workspaceError) this.report(new WardenError(409, created.workspaceError.message, created.workspaceError.code), `task:${created.id}`);
            return created.id;
          }
          case 'task.update':
            await this.api('task.update', { taskId: action.taskId, title: action.title, body: action.body });
            break;
          case 'task.restore':
            await this.api('task.update', { taskId: action.taskId, status: 'planned' });
            await this.api('task.start', { taskId: action.taskId });
            break;
          case 'task.start':
            await this.api('task.start', { taskId: action.taskId, kind: action.kind, agent: action.agent });
            break;
          case 'task.review':
            await this.selectTask(node, 'review', true);
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
                task!.acceptance && `Acceptance criteria: ${task!.acceptance}`,
                task!.agent && `Executor: ${task!.agent}`,
                task!.worktree && `Workspace: ${task!.worktree}`,
                `Base branch: ${task!.developmentBranch}`,
                'Edit and commit code in the task workspace. The user validates it in the separate preview folder, reviews it in Warden, and commits it to the base branch.',
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
            void vscode.window.showInformationMessage('Script configuration saved');
            break;
          case 'rebase.check':
            await this.refreshChecks();
            break;
          case 'rebase.run': {
            const result = await this.api('rebase.run', { items: action.items });
            if (session === this.session) this.rebaseResult = result;
            break;
          }
        }
      },
      navigation.includes(action.type) ? undefined : 'Working…',
      scope,
    );
  }

  async close() {
    this.log.write('info', 'extension.close.start');
    this.closing = true;
    this.invalidateChecks();
    this.commitInput?.hide();
    this.taskInput?.hide();
    const closed = await Promise.allSettled([this.agentSetup.close(), this.conversations.close()]);
    for (const result of closed)
      if (result.status === 'rejected') this.log.write('error', 'extension.agent.cleanup.failed', { diagnostic: acpErrorDiagnostic(result.reason) });
    await Promise.allSettled([this.active, ...this.navigation, this.reading, this.checkReading, this.contextUpdate]);
    try {
      await this.views.flush();
    } finally {
      await this.backend?.close();
      this.log.write('info', 'extension.close.end');
    }
  }
}
