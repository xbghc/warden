import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Engine } from '@warden/engine';
import { DiagnosticLog, diagnosticError, parseAcpAction } from '@warden/shared';
import type { AcpAction, AcpBinding, AcpConfiguration, AcpModel, AcpStatus, AcpViewState } from '@warden/shared';
import type { AcpProfile, AgentProcessInfo } from './contracts.js';
import { resolveAcpBinding, validateAcpBinding } from './binding.js';
import { autoApproveRepositoryReads, readAcpProfiles } from './setup.js';
import { AcpSession } from './session.js';
import { AcpSessionStorage } from './storage.js';
import { AcpModelPreferences } from './model-preferences.js';
import { AcpDraft } from './draft.js';
import { acpErrorMessage } from './diagnostics.js';

interface ChatSurface {
  webview: vscode.Webview;
  location: 'sidebar' | 'editor';
  ready: boolean;
  capture?: { id: string; finish(error?: Error): void };
}

interface Conversation {
  binding: AcpBinding;
  engine: Engine;
  session: AcpSession;
  panelId: string;
  panel?: vscode.WebviewPanel;
  surface?: ChatSurface;
  viewState?: AcpViewState;
  draft: AcpDraft;
  draftKey: string;
  draftSave: Promise<void>;
  connecting?: Promise<void>;
  sending: boolean;
  submittedDraft?: AcpModel['submittedDraft'];
  error?: string;
  renderTimer?: ReturnType<typeof setTimeout>;
}

export interface TaskAgentProcess extends AgentProcessInfo {
  binding: AcpBinding;
  status: AcpStatus;
}

/** Conversation routing never depends on the workbench's currently selected repository. */
export class AcpConversations {
  private readonly entries = new Map<string, Conversation>();
  private readonly opening = new Map<string, Promise<Conversation>>();
  private readonly engines = new Map<string, Promise<Engine>>();
  private readonly deleting = new Set<string>();
  private readonly rebasing = new Map<string, symbol>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private closed = false;
  private sidebar?: vscode.WebviewView;
  private sidebarWaiter?: { resolve(view: vscode.WebviewView): void; reject(error: Error): void };
  private sidebarEntry?: Conversation;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly review: (binding: AcpBinding, reference: string) => Promise<void>,
    private readonly changed: () => void,
    private readonly report: (error: unknown) => void,
    private readonly configureAgents: () => Promise<void>,
    private readonly connectionFailed: (profile: AcpProfile, message: string) => void,
    private readonly defaultProfileId: () => string | undefined,
    private readonly log = new DiagnosticLog(),
  ) {
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'warden.taskChat',
        {
          resolveWebviewView: (view) => this.resolveSidebar(view),
        },
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('warden.acpAgents')) return;
        for (const entry of this.entries.values()) this.render(entry);
        this.changed();
      }),
    );
  }

  private key(repository: string, taskId: string) {
    return JSON.stringify([repository, taskId]);
  }
  private profiles(): AcpProfile[] {
    return readAcpProfiles();
  }
  private profile(id: string) {
    const profile = this.profiles().find((row) => row.id === id);
    if (!profile) throw new Error('This agent profile no longer exists. Configure warden.acpAgents in User settings.');
    return profile;
  }
  private conversationProfile(entry: Conversation, requestedId: string) {
    const id = entry.session.snapshot().record.profileId ?? this.defaultProfileId();
    if (!id || id !== requestedId) throw new Error('The agent changed. Reconnect in Warden Settings and try again.');
    return this.profile(id);
  }
  refresh() {
    for (const entry of this.entries.values()) this.render(entry);
  }
  configuration(): AcpConfiguration {
    try {
      const count = this.profiles().length;
      return count ? { status: 'configured', count } : { status: 'missing' };
    } catch (error) {
      return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
    }
  }
  private engine(repository: string) {
    let opening = this.engines.get(repository);
    if (!opening) {
      opening = Engine.open(repository, undefined, this.log).then(async (engine) => {
        if (this.closed) {
          await engine.close();
          throw new Error('The Warden session is closed.');
        }
        // Deletion notifications must not let a retained chat engine own preview synchronization.
        await engine.start(
          async () => {
            const state = await engine.store.load();
            for (const task of state.workflow?.deletedTasks ?? []) await this.forgetTask(repository, task.id);
          },
          this.report,
          'state',
        );
        return engine;
      });
      this.engines.set(repository, opening);
      void opening.catch(() => this.engines.delete(repository));
    }
    return opening;
  }
  private async create(repository: string, taskId: string) {
    const engine = await this.engine(repository);
    const binding = await resolveAcpBinding(engine, taskId);
    const draftKey = `warden.acpDraft:${createHash('sha256')
      .update(JSON.stringify([repository, taskId, binding.identity]))
      .digest('hex')}`;
    const entry = {
      binding,
      engine,
      panelId: randomUUID(),
      draft: new AcpDraft(this.context.workspaceState.get<string>(draftKey, '')),
      draftKey,
      viewState: this.context.workspaceState.get<AcpViewState>(`${draftKey}:view`),
      draftSave: Promise.resolve(),
      sending: false,
    } as Conversation;
    entry.session = new AcpSession({
      binding,
      modelPreferences: new AcpModelPreferences(this.context.globalState),
      storage: new AcpSessionStorage(
        path.join(path.dirname(engine.store.file), 'acp'),
        binding,
        () => validateAcpBinding(engine, binding),
        async () => {
          const task = (await engine.store.load()).workflow?.changes.find((row) => row.id === binding.taskId);
          if (!task || task.deletion) throw new Error('This task was deleted or is being deleted.');
        },
      ),
      validate: async () => {
        if (!vscode.workspace.isTrusted || this.closed) throw new Error('Agent actions are unavailable for this workspace.');
        await validateAcpBinding(engine, binding);
      },
      readRoots: async () => {
        if (!autoApproveRepositoryReads()) return [];
        const roots = await engine.execute('repository.readRoots', undefined);
        return autoApproveRepositoryReads() ? roots : [];
      },
      changed: () => {
        this.changed();
        this.scheduleRender(entry);
      },
      connectionFailed: this.connectionFailed,
      log: this.log,
      report: (diagnostic) => console.error(diagnostic),
    });
    await entry.session.initialize();
    if (this.closed) {
      await entry.session.close();
      throw new Error('The Warden session is closed.');
    }
    this.entries.set(this.key(repository, taskId), entry);
    this.log.write('debug', 'acp.conversation.opened', { task: taskId });
    return entry;
  }

  private async ensure(repository: string, taskId: string) {
    if (this.closed || !vscode.workspace.isTrusted) throw new Error('Open and trust a workspace first.');
    const key = this.key(repository, taskId);
    if (this.deleting.has(key)) throw new Error('This task is being deleted.');
    if (this.rebasing.has(key)) throw new Error('This task is being rebased automatically. Try again when it finishes.');
    let opening = this.opening.get(key);
    if (!opening) {
      opening = (async () => {
        const previous = this.entries.get(key);
        if (previous) {
          let binding: AcpBinding;
          try {
            binding = await resolveAcpBinding(previous.engine, taskId);
          } catch (error) {
            // A missing or busy checkout must not hide an existing connection's stop controls.
            previous.error = error instanceof Error ? error.message : String(error);
            return previous;
          }
          if (binding.identity === previous.binding.identity) return previous;
          // Only a live process or attempt can still act in the old workspace. An error status
          // after a crash or failed connect has nothing left to end, so it is replaced too.
          if (previous.connecting || previous.session.process() || ['connecting', 'resetting'].includes(previous.session.snapshot().status)) {
            previous.error =
              'The task workspace was replaced. End the original agent process in Settings › Agent Processes, then reopen the task conversation.';
            return previous;
          }
          // Old transcripts remain under their original allocation identity.
          await this.release(previous);
          await previous.session.close();
          await previous.draftSave;
          clearTimeout(previous.renderTimer);
          this.entries.delete(key);
        }
        return this.create(repository, taskId);
      })();
      this.opening.set(key, opening);
    }
    let entry: Conversation;
    try {
      entry = await opening;
    } finally {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    }
    if (this.closed) throw new Error('The Warden session is closed.');
    return entry;
  }

  /** Live task agent processes in this window, across every repository with an open conversation. */
  processes(): TaskAgentProcess[] {
    return [...this.entries.values()].flatMap((entry) => {
      const process = entry.session.process();
      return process ? [{ ...process, binding: entry.binding, status: entry.session.currentStatus() }] : [];
    });
  }

  async endProcess(repository: string, taskId: string, pid: number) {
    const entry = this.entries.get(this.key(repository, taskId));
    if (!entry || this.closed || entry.session.process()?.pid !== pid) return;
    entry.error = undefined;
    await entry.session.disconnect();
    this.render(entry);
    this.changed();
  }

  /**
   * Whether the task's agent may be writing: a turn, permission wait, cancellation, session reset
   * or connection in progress. Automatic rebase skips such tasks; an idle connection does not count.
   */
  isBusy(repository: string, taskId: string) {
    const key = this.key(repository, taskId);
    const entry = this.entries.get(key);
    if (this.deleting.has(key) || this.rebasing.has(key) || this.opening.has(key) || entry?.connecting) return true;
    return !!entry && (entry.sending || entry.session.isBusy());
  }

  /** Keep local actions from starting while the engine queues or runs an automatic rebase. */
  reserveRebase(repository: string, taskIds: string[]) {
    const reservations: { key: string; token: symbol; release?: () => void }[] = [];
    const items: { taskId: string; connectionToken?: string }[] = [];
    if (!this.closed)
      for (const taskId of taskIds) {
        const key = this.key(repository, taskId);
        if (this.isBusy(repository, taskId)) continue;
        const entry = this.entries.get(key);
        const reservation = entry?.session.reserveIdle();
        if (entry && !reservation) continue;
        const token = Symbol('automatic rebase');
        this.rebasing.set(key, token);
        reservations.push({ key, token, release: reservation?.release });
        items.push({ taskId, ...(reservation?.connectionToken ? { connectionToken: reservation.connectionToken } : {}) });
      }
    return {
      items,
      release: () => {
        for (const reservation of reservations) {
          reservation.release?.();
          if (this.rebasing.get(reservation.key) === reservation.token) this.rebasing.delete(reservation.key);
        }
      },
    };
  }

  /** Titles are not part of a binding's identity, so a rename updates live conversations in place. */
  retitle(repository: string, taskId: string, title: string) {
    const entry = this.entries.get(this.key(repository, taskId));
    if (!entry || entry.binding.title === title) return;
    entry.binding = { ...entry.binding, title };
    entry.session.retitle(title);
    if (entry.panel) entry.panel.title = `${title} · Agent`;
  }

  hasConnection(repository: string, taskId: string) {
    const entry = this.entries.get(this.key(repository, taskId));
    return !!entry && (!!entry.connecting || entry.session.snapshot().status !== 'disconnected');
  }

  async prepareDeletion(repository: string, taskId: string) {
    const key = this.key(repository, taskId);
    if (this.deleting.has(key)) throw new Error('This task is already being deleted.');
    this.deleting.add(key);
    try {
      await this.opening.get(key);
      const entry = this.entries.get(key);
      if (entry) {
        await this.release(entry);
        await entry.session.disconnect();
        await entry.connecting?.catch(() => undefined);
        await entry.draftSave;
      }
    } catch (error) {
      this.deleting.delete(key);
      throw error;
    }
    return () => this.deleting.delete(key);
  }

  async forgetTask(repository: string, taskId: string) {
    const key = this.key(repository, taskId);
    const entry = this.entries.get(key);
    if (!entry) return;
    const panel = entry.panel;
    this.detach(entry);
    panel?.dispose();
    clearTimeout(entry.renderTimer);
    await entry.session.close();
    await entry.draftSave;
    await this.context.workspaceState.update(entry.draftKey, undefined);
    await this.context.workspaceState.update(`${entry.draftKey}:view`, undefined);
    this.entries.delete(key);
    this.changed();
  }

  show(repository: string, taskId: string, location: ChatSurface['location'] = 'sidebar') {
    // Serialize only presentation changes; background turns and permission answers stay independent.
    const opening = this.transition.then(async () => {
      const entry = await this.ensure(repository, taskId);
      if (entry.surface?.location === location) {
        if (location === 'sidebar') this.sidebar?.show(false);
        else entry.panel?.reveal(vscode.ViewColumn.Beside);
        this.render(entry);
        this.start(entry);
        return;
      }
      if (location === 'sidebar') {
        const view = this.sidebar ?? (await this.openSidebar());
        if (this.sidebarEntry) await this.release(this.sidebarEntry);
        await this.release(entry);
        if (this.closed) return;
        this.sidebarEntry = entry;
        this.mount(entry, view.webview, location);
        view.show(false);
      } else {
        await this.release(entry);
        if (this.closed) return;
        const panel = vscode.window.createWebviewPanel('warden.agent', `${entry.binding.title} · Agent`, vscode.ViewColumn.Beside, {
          enableScripts: true,
          retainContextWhenHidden: true,
        });
        entry.panel = panel;
        const surface = this.mount(entry, panel.webview, location);
        let visible = panel.visible;
        const visibility = panel.onDidChangeViewState(() => {
          const opened = panel.visible && !visible;
          visible = panel.visible;
          if (opened && entry.surface === surface && !surface.capture) this.start(entry);
        });
        const listener = panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(entry, surface, message));
        const disposal = panel.onDidDispose(() => {
          if (entry.panel === panel) this.detach(entry);
          visibility.dispose();
          listener.dispose();
          disposal.dispose();
        });
        this.initializeWebview(panel.webview);
      }
      void vscode.commands.executeCommand('setContext', 'warden.chatInSidebar', !!this.sidebarEntry);
      this.start(entry);
    });
    this.transition = opening.catch(() => {});
    return opening;
  }

  private async connect(entry: Conversation, requestedId?: string) {
    if (this.deleting.has(this.key(entry.binding.repository, entry.binding.taskId))) throw new Error('This task is being deleted.');
    if (this.rebasing.has(this.key(entry.binding.repository, entry.binding.taskId)))
      throw new Error('This task is being rebased automatically. Try again when it finishes.');
    const snapshot = entry.session.snapshot();
    const profileId = requestedId ?? snapshot.record.profileId ?? this.defaultProfileId();
    if (!profileId) throw new Error('Connect an agent in Warden Settings first.');
    const profile = this.conversationProfile(entry, profileId);
    if (entry.connecting) {
      this.log.write('debug', 'acp.connection.reused', { task: entry.binding.taskId, pending: true });
      await entry.connecting;
      this.conversationProfile(entry, profileId);
      return;
    }
    if (snapshot.status === 'connected') {
      this.log.write('debug', 'acp.connection.reused', { task: entry.binding.taskId, pending: false });
      return;
    }
    const connecting = (async () => {
      if (snapshot.status === 'error') await entry.session.disconnect();
      await entry.session.connect(profile, { resume: !!snapshot.record.sessionId });
    })();
    entry.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (entry.connecting === connecting) entry.connecting = undefined;
    }
  }

  private start(entry: Conversation) {
    if (this.closed || entry.connecting || !['disconnected', 'error'].includes(entry.session.snapshot().status)) return;
    entry.error = undefined;
    // Opening a chat prepares its session without blocking navigation or sending the draft.
    void this.connect(entry)
      .catch((error: unknown) => {
        this.log.write('error', 'acp.conversation.prepare.failed', { task: entry.binding.taskId, ...diagnosticError(error) });
        entry.error = acpErrorMessage(error);
      })
      .finally(() => {
        this.changed();
        this.render(entry);
      });
  }

  async expand() {
    const entry = this.sidebarEntry;
    if (entry) await this.show(entry.binding.repository, entry.binding.taskId, 'editor');
  }

  private openSidebar() {
    return new Promise<vscode.WebviewView>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error, view?: vscode.WebviewView) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.sidebarWaiter = undefined;
        if (error) reject(error);
        else if (view) resolve(view);
      };
      const timer = setTimeout(() => finish(new Error('Task Chat is unavailable. Reopen the view and try again.')), 10_000);
      this.sidebarWaiter = { resolve: (view) => finish(undefined, view), reject: (error) => finish(error) };
      // The focus command can return before VS Code resolves the contributed webview.
      void vscode.commands.executeCommand('warden.taskChat.focus').then(undefined, (error: Error) => finish(error));
    });
  }

  private resolveSidebar(view: vscode.WebviewView) {
    this.sidebar = view;
    this.initializeWebview(view.webview);
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      const entry = this.sidebarEntry;
      if (entry?.surface) void this.receive(entry, entry.surface, message);
      else this.renderEmpty();
    });
    const visibility = view.onDidChangeVisibility(() => {
      const entry = this.sidebarEntry;
      if (view.visible && entry && !entry.surface?.capture) this.start(entry);
    });
    const disposal = view.onDidDispose(() => {
      if (this.sidebar === view) {
        if (this.sidebarEntry) this.detach(this.sidebarEntry);
        this.sidebar = undefined;
      }
      visibility.dispose();
      listener.dispose();
      disposal.dispose();
    });
    this.sidebarWaiter?.resolve(view);
  }

  private initializeWebview(webview: vscode.Webview) {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Task Chat</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private mount(entry: Conversation, webview: vscode.Webview, location: ChatSurface['location']) {
    this.log.write('debug', 'acp.view.mounted', { task: entry.binding.taskId, location });
    entry.panelId = randomUUID();
    const draft = entry.draft.snapshot();
    const submitted = entry.submittedDraft?.version === draft.draftVersion && entry.submittedDraft?.revision === draft.draftRevision;
    entry.draft.resetPanel();
    entry.submittedDraft = submitted ? { version: draft.draftVersion, revision: 0 } : undefined;
    entry.surface = { webview, location, ready: false };
    this.render(entry);
    return entry.surface;
  }

  private async receive(entry: Conversation, surface: ChatSurface, message: unknown) {
    if (entry.surface !== surface || this.closed) {
      this.log.write('trace', 'acp.view.message.ignored', { reason: 'inactive_surface', task: entry.binding.taskId });
      return;
    }
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid conversation view message.');
      const envelope = message as Record<string, unknown>;
      if (envelope.type === 'ready') {
        this.render(entry);
        return;
      }
      // A switched-out view can still deliver queued messages. Never route them to its replacement.
      if (envelope.type !== 'acp-action' || envelope.panelId !== entry.panelId) return;
      const action = parseAcpAction(envelope.action);
      if (!['draft', 'view-state', 'view-ready'].includes(action.type))
        this.log.write('debug', 'acp.view.action', { task: entry.binding.taskId, action: action.type });
      if (surface.capture && !['draft', 'view-state', 'view-ready'].includes(action.type)) return;
      await this.handle(entry, action);
    } catch (error) {
      this.log.write('error', 'acp.view.action.failed', { task: entry.binding.taskId, ...diagnosticError(error) });
      entry.error = acpErrorMessage(error);
      surface.capture?.finish(new Error(entry.error));
      this.changed();
      this.render(entry);
    }
  }

  private async release(entry: Conversation) {
    const surface = entry.surface;
    if (!surface) return;
    if (surface.ready) {
      // Wait for local edits and reading position before invalidating this view's routing token.
      await new Promise<void>((resolve, reject) => {
        const id = randomUUID();
        let finished = false;
        const timer = setTimeout(() => finish(new Error('Task Chat did not save its view. Try switching again.')), 3000);
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          surface.capture = undefined;
          if (error) {
            void surface.webview.postMessage({ type: 'acp-resume', panelId: entry.panelId });
            reject(error);
          } else resolve();
        };
        surface.capture = { id, finish };
        if (surface.location === 'sidebar' && !this.sidebar?.visible) this.sidebar?.show(true);
        else if (entry.panel && !entry.panel.visible) entry.panel.reveal(entry.panel.viewColumn, true);
        void surface.webview.postMessage({ type: 'acp-capture', panelId: entry.panelId, requestId: id }).then(
          (delivered) => {
            if (!delivered) finish(new Error('Task Chat is not ready. Reopen it before switching.'));
          },
          (error: Error) => finish(error),
        );
      });
    }
    const panel = entry.panel;
    this.detach(entry);
    panel?.dispose();
  }

  private detach(entry: Conversation) {
    entry.surface?.capture?.finish();
    entry.surface = undefined;
    entry.panel = undefined;
    if (this.sidebarEntry === entry) {
      this.sidebarEntry = undefined;
      this.renderEmpty();
      void vscode.commands.executeCommand('setContext', 'warden.chatInSidebar', false);
    }
  }

  private renderEmpty() {
    void this.sidebar?.webview.postMessage({ type: 'acp-empty' });
  }

  private scheduleRender(entry: Conversation) {
    if (entry.renderTimer || this.closed) return;
    entry.renderTimer = setTimeout(() => {
      entry.renderTimer = undefined;
      this.render(entry);
    }, 40);
  }
  private render(entry: Conversation) {
    if (!entry.surface || this.closed) return;
    const snapshot = entry.session.snapshot();
    let profiles: AcpModel['profiles'] = [];
    let error = entry.error ?? snapshot.error;
    try {
      profiles = this.profiles().map(({ id, label }) => ({ id, label }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const model: AcpModel = {
      ...snapshot,
      error,
      panelId: entry.panelId,
      profiles,
      defaultProfileId: this.defaultProfileId(),
      sending: entry.sending,
      submittedDraft: entry.submittedDraft,
      ...entry.draft.snapshot(),
      presentation: entry.surface.location,
      viewState: entry.viewState,
    };
    void entry.surface.webview.postMessage({ type: 'acp-model', model });
  }
  private saveDraft(entry: Conversation) {
    const text = entry.draft.text;
    entry.draftSave = entry.draftSave.catch(() => {}).then(() => this.context.workspaceState.update(entry.draftKey, text));
    void entry.draftSave.catch(this.report);
  }

  private async handle(entry: Conversation, action: AcpAction) {
    if (!['draft', 'view-state', 'view-ready'].includes(action.type) && this.deleting.has(this.key(entry.binding.repository, entry.binding.taskId)))
      throw new Error('This task is being deleted.');
    if (
      ['send', 'connect', 'new', 'authenticate', 'set-config', 'set-mode'].includes(action.type) &&
      this.rebasing.has(this.key(entry.binding.repository, entry.binding.taskId))
    )
      throw new Error('This task is being rebased automatically. Try again when it finishes.');
    if (this.closed) return;
    if (action.type === 'view-ready') {
      if (entry.surface) entry.surface.ready = true;
      return;
    }
    if (action.type === 'view-state') {
      entry.viewState = { scrollTop: action.scrollTop, followOutput: action.followOutput, profileId: action.profileId };
      entry.draftSave = entry.draftSave.catch(() => {}).then(() => this.context.workspaceState.update(`${entry.draftKey}:view`, entry.viewState));
      void entry.draftSave.catch(this.report);
      if (action.requestId === entry.surface?.capture?.id) entry.surface?.capture?.finish();
      return;
    }
    if (action.type === 'open-sidebar') {
      await this.show(entry.binding.repository, entry.binding.taskId, 'sidebar');
      return;
    }
    if (action.type === 'draft') {
      entry.draft.update(action);
      this.saveDraft(entry);
      this.render(entry);
      return;
    }
    if (action.type === 'configure') {
      await this.configureAgents();
      return;
    }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace first.');
    entry.error = undefined;
    this.changed();
    const session = entry.session;
    switch (action.type) {
      case 'send': {
        if (entry.sending || !action.text.trim()) throw new Error('Wait for the current response or stop this turn first.');
        const submission = entry.draft.begin(action);
        entry.submittedDraft = { version: entry.draft.snapshot().draftVersion, revision: action.revision };
        entry.sending = true;
        this.saveDraft(entry);
        this.render(entry);
        try {
          await this.connect(entry, action.profileId);
          await session.send(submission.text);
          const record = session.snapshot().record;
          if (!record.interrupted && entry.draft.complete(submission.mutation)) this.saveDraft(entry);
        } finally {
          entry.sending = false;
          entry.submittedDraft = undefined;
        }
        break;
      }
      case 'connect':
        await this.connect(entry, action.profileId);
        break;
      case 'cancel':
        await session.cancel();
        break;
      case 'new':
        if (entry.sending || ['connecting', 'running', 'waiting_permission', 'cancelling', 'resetting'].includes(session.snapshot().status))
          throw new Error('Stop and disconnect the current session first.');
        await session.disconnect();
        await session.newConversation();
        await this.connect(entry);
        break;
      case 'permission':
        await validateAcpBinding(entry.engine, entry.binding);
        await session.respondPermission(action.requestId, action.optionId);
        break;
      case 'authenticate':
        await session.authenticate(action.methodId);
        break;
      case 'set-config':
        await session.setConfigOption(action.configId, action.value);
        break;
      case 'set-mode':
        await session.setMode(action.modeId);
        break;
      case 'open-file':
        await validateAcpBinding(entry.engine, entry.binding);
        await this.review(entry.binding, action.reference);
        break;
    }
    this.render(entry);
  }

  activity(repository: string, taskId: string) {
    const entry = this.entries.get(this.key(repository, taskId));
    const status = entry?.session.snapshot().status;
    return status === 'waiting_permission'
      ? 'Agent: Permission Required'
      : entry?.error || status === 'error'
        ? 'Agent: Session Error'
        : status === 'running'
          ? 'Agent: Responding'
          : status === 'connecting'
            ? 'Agent: Connecting'
            : status === 'cancelling'
              ? 'Agent: Stopping'
              : undefined;
  }

  async append(repository: string, taskId: string, excerpt: string) {
    await this.show(repository, taskId);
    const entry = this.entries.get(this.key(repository, taskId));
    if (!entry) return;
    entry.draft.append(excerpt);
    this.saveDraft(entry);
    this.render(entry);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.sidebarWaiter?.reject(new Error('The Warden session is closed.'));
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        clearTimeout(entry.renderTimer);
        const panel = entry.panel;
        this.detach(entry);
        panel?.dispose();
        await entry.session.close();
        await entry.draftSave;
      }),
    );
    await Promise.allSettled([...this.engines.values()].map(async (engine) => (await engine).close()));
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
