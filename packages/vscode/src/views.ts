import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { parseWorkbenchAction } from '@warden/shared';
import type { Surface, WorkbenchAction, WorkbenchModel } from '@warden/shared';

const titles: Record<Surface, string> = { task: '当前任务', preview: '预览', history: '提交历史', settings: '设置', rebase: '同步工作区' };

export class Views implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly panels = new Map<Surface, vscode.WebviewPanel>();
  private task?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: (surface: Surface) => WorkbenchModel,
    private readonly action: (action: WorkbenchAction, session: string) => Promise<void>,
    private readonly error: (error: unknown, surface: Surface) => void,
  ) {}
  resolveWebviewView(view: vscode.WebviewView) {
    this.task = view;
    this.configure(view.webview, 'task');
    this.subscriptions.push(
      view.onDidDispose(() => {
        if (this.task === view) this.task = undefined;
      }),
    );
  }
  async show(surface: Surface) {
    if (surface === 'task') {
      await vscode.commands.executeCommand('warden.task.focus');
      return;
    }
    const existing = this.panels.get(surface);
    if (existing) {
      existing.reveal();
      this.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(`warden.${surface}`, `Warden · ${titles[surface]}`, vscode.ViewColumn.Active, { enableScripts: true });
    this.panels.set(surface, panel);
    this.configure(panel.webview, surface);
    this.subscriptions.push(panel.onDidDispose(() => this.panels.delete(surface)));
  }
  private configure(webview: vscode.Webview, surface: Surface) {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
    webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>${titles[surface]}</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.subscriptions.push(
      webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('界面消息格式错误');
          const envelope = message as Record<string, unknown>;
          if (envelope.type === 'ready') {
            await webview.postMessage({ type: 'model', model: this.model(surface) });
            return;
          }
          if (envelope.type !== 'action' || typeof envelope.session !== 'string') throw new Error('未知界面消息');
          if (envelope.session !== this.model(surface).session) throw new Error('仓库已切换，请使用当前界面重试');
          const action = parseWorkbenchAction(envelope.action);
          const prefix = action.type.split('.')[0];
          if (prefix !== 'setup' && prefix !== surface) throw new Error('此界面不能执行该操作');
          await this.action(action, envelope.session);
        } catch (error) {
          this.error(error, surface);
        }
      }),
    );
  }
  render() {
    if (this.task) void this.task.webview.postMessage({ type: 'model', model: this.model('task') });
    for (const [surface, panel] of this.panels) void panel.webview.postMessage({ type: 'model', model: this.model(surface) });
  }
  dispose() {
    for (const panel of this.panels.values()) panel.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
