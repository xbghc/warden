import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Engine } from '@warden/engine';
import { parseAcpAction } from '@warden/shared';
import type { AcpAction, AcpBinding, AcpModel, WorkflowTask } from '@warden/shared';
import type { AcpProfile } from './contracts.js';
import { resolveAcpBinding, validateAcpBinding } from './binding.js';
import { parseAcpProfiles } from './profiles.js';
import { AcpSession } from './session.js';
import { AcpSessionStorage } from './storage.js';
import { AcpDraft } from './draft.js';

interface Conversation {
  binding: AcpBinding;
  engine: Engine;
  session: AcpSession;
  panelId: string;
  panel?: vscode.WebviewPanel;
  draft: AcpDraft;
  draftKey: string;
  draftSave: Promise<void>;
  sending: boolean;
  error?: string;
  renderTimer?: ReturnType<typeof setTimeout>;
}

/** Conversation routing never depends on the workbench's currently selected repository. */
export class AcpConversations {
  private readonly entries = new Map<string, Conversation>();
  private readonly opening = new Map<string, Promise<Conversation>>();
  private readonly engines = new Map<string, Promise<Engine>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private closed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly review: (binding: AcpBinding) => Promise<void>,
    private readonly changed: () => void,
    private readonly report: (error: unknown) => void,
  ) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('warden.acpAgents')) for (const entry of this.entries.values()) this.render(entry);
      }),
    );
  }

  private key(repository: string, taskId: string) {
    return JSON.stringify([repository, taskId]);
  }
  private profiles(): AcpProfile[] {
    // Even a hand-edited workspace setting cannot supply an executable command.
    const inspected = vscode.workspace.getConfiguration('warden').inspect<unknown>('acpAgents');
    return parseAcpProfiles(inspected?.globalValue ?? inspected?.defaultValue);
  }
  private profile(id: string) {
    const profile = this.profiles().find((row) => row.id === id);
    if (!profile) throw new Error('此 Agent 配置已不存在，请在用户设置中配置 warden.acpAgents');
    return profile;
  }
  private engine(repository: string) {
    let opening = this.engines.get(repository);
    if (!opening) {
      opening = Engine.open(repository).then(async (engine) => {
        if (this.closed) {
          await engine.close();
          throw new Error('Warden 会话已关闭');
        }
        await engine.start(async () => {}, this.report);
        return engine;
      });
      this.engines.set(repository, opening);
      void opening.catch(() => this.engines.delete(repository));
    }
    return opening;
  }
  private brief(task: WorkflowTask) {
    return [
      `# ${task.title}`,
      task.body,
      task.acceptance && `验收说明：${task.acceptance}`,
      `任务工作区：${task.worktree}`,
      `主开发分支：${task.developmentBranch}`,
      '在此任务工作区修改和提交代码。主目录由用户编辑，独立预览目录由 Warden 生成。用户会完整审阅后交付。',
    ]
      .filter(Boolean)
      .join('\n\n');
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
      draftSave: Promise.resolve(),
      sending: false,
    } as Conversation;
    entry.session = new AcpSession({
      binding,
      storage: new AcpSessionStorage(path.join(path.dirname(engine.store.file), 'acp'), binding),
      validate: async () => {
        if (!vscode.workspace.isTrusted || this.closed) throw new Error('当前工作区不可执行 Agent 操作');
        await validateAcpBinding(engine, binding);
      },
      changed: () => {
        this.changed();
        this.scheduleRender(entry);
      },
    });
    await entry.session.initialize();
    if (this.closed) {
      await entry.session.close();
      throw new Error('Warden 会话已关闭');
    }
    if (!entry.draft.text && !entry.session.snapshot().record.messages.length) {
      const task = (await engine.execute('workflow.get', undefined)).workflow?.changes.find((row) => row.id === taskId);
      if (task) entry.draft = new AcpDraft(this.brief(task));
    }
    this.entries.set(this.key(repository, taskId), entry);
    return entry;
  }

  async show(repository: string, taskId: string) {
    if (this.closed || !vscode.workspace.isTrusted) throw new Error('请先信任并打开工作区');
    const key = this.key(repository, taskId);
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
          if (previous.session.snapshot().status !== 'disconnected') {
            previous.error = '任务工作区已被替换，请先断开原会话，再重新打开任务对话';
            return previous;
          }
          // Old transcripts remain under their original allocation identity.
          await previous.session.close();
          await previous.draftSave;
          clearTimeout(previous.renderTimer);
          previous.panel?.dispose();
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
    if (this.closed) throw new Error('Warden 会话已关闭');
    if (entry.panel) {
      entry.panel.reveal(vscode.ViewColumn.Beside);
      this.render(entry);
      return;
    }
    entry.panelId = randomUUID();
    entry.draft.resetPanel();
    const panel = vscode.window.createWebviewPanel('warden.agent', `${entry.binding.title} · Agent`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    entry.panel = panel;
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const nonce = randomBytes(24).toString('base64');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
    panel.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Agent 对话</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const current = entry;
    const panelId = entry.panelId;
    const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (current.panel !== panel || current.panelId !== panelId || this.closed) return;
      try {
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('对话界面消息格式错误');
        const envelope = message as Record<string, unknown>;
        if (envelope.type === 'ready') {
          this.render(current);
          return;
        }
        if (envelope.type !== 'acp-action' || envelope.panelId !== panelId) throw new Error('对话界面已变化，请重新打开');
        await this.handle(current, parseAcpAction(envelope.action));
      } catch (error) {
        current.error = error instanceof Error ? error.message : String(error);
        this.render(current);
      }
    });
    const disposal = panel.onDidDispose(() => {
      if (current.panel === panel) current.panel = undefined;
      listener.dispose();
      disposal.dispose();
    });
    this.render(entry);
  }

  private scheduleRender(entry: Conversation) {
    if (entry.renderTimer || this.closed) return;
    entry.renderTimer = setTimeout(() => {
      entry.renderTimer = undefined;
      this.render(entry);
    }, 40);
  }
  private render(entry: Conversation) {
    if (!entry.panel || this.closed) return;
    const snapshot = entry.session.snapshot();
    let profiles: AcpModel['profiles'] = [];
    let error = entry.error ?? snapshot.error;
    try {
      profiles = this.profiles().map(({ id, label }) => ({ id, label }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const model: AcpModel = { ...snapshot, error, panelId: entry.panelId, profiles, sending: entry.sending, ...entry.draft.snapshot() };
    void entry.panel.webview.postMessage({ type: 'acp-model', model });
  }
  private saveDraft(entry: Conversation) {
    const text = entry.draft.text;
    entry.draftSave = entry.draftSave.catch(() => {}).then(() => this.context.workspaceState.update(entry.draftKey, text));
    void entry.draftSave.catch(this.report);
  }

  private async handle(entry: Conversation, action: AcpAction) {
    if (this.closed) return;
    if (action.type === 'draft') {
      entry.draft.update(action);
      this.saveDraft(entry);
      this.render(entry);
      return;
    }
    if (action.type === 'configure') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'warden.acpAgents');
      return;
    }
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区');
    entry.error = undefined;
    const session = entry.session;
    switch (action.type) {
      case 'send': {
        if (entry.sending || !action.text.trim()) throw new Error('请等待当前消息结束，或先停止本轮');
        const submission = entry.draft.begin(action);
        entry.sending = true;
        this.saveDraft(entry);
        this.render(entry);
        try {
          const current = session.snapshot();
          if (current.status !== 'connected') {
            if (current.record.sessionId) throw new Error('请先继续原会话，或明确新建会话');
            await session.connect(this.profile(action.profileId), { resume: false });
          } else if (current.record.profileId !== action.profileId) throw new Error('更换 Agent 前请断开并新建会话');
          await session.send(submission.text);
          const record = session.snapshot().record;
          if (!record.interrupted && entry.draft.complete(submission.mutation)) this.saveDraft(entry);
        } finally {
          entry.sending = false;
        }
        break;
      }
      case 'connect':
        await session.connect(this.profile(action.profileId), { resume: action.resume });
        break;
      case 'cancel':
        await session.cancel();
        break;
      case 'disconnect':
        await session.disconnect();
        break;
      case 'new':
        if (entry.sending || ['connecting', 'running', 'waiting_permission', 'cancelling'].includes(session.snapshot().status))
          throw new Error('请先停止并断开当前会话');
        await session.disconnect();
        await session.newConversation();
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
      case 'review':
        await validateAcpBinding(entry.engine, entry.binding);
        await this.review(entry.binding);
        break;
    }
    this.render(entry);
  }

  activity(repository: string, taskId: string) {
    const status = this.entries.get(this.key(repository, taskId))?.session.snapshot().status;
    return status === 'waiting_permission'
      ? 'Agent 等待授权'
      : status === 'running'
        ? 'Agent 响应中'
        : status === 'connecting'
          ? 'Agent 连接中'
          : status === 'cancelling'
            ? 'Agent 正在停止'
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
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        clearTimeout(entry.renderTimer);
        entry.panel?.dispose();
        await entry.session.close();
        await entry.draftSave;
      }),
    );
    await Promise.allSettled([...this.engines.values()].map(async (engine) => (await engine).close()));
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
