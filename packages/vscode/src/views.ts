import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { parseWorkbenchAction } from '@warden/shared';
import type { Surface, WorkbenchAction, WorkbenchModel } from '@warden/shared';

const titles: Record<Surface, string> = { workspaces: 'Workbench', settings: 'Settings', rebase: 'Rebase' };

export class Views implements vscode.Disposable {
  private readonly panels = new Map<Surface, vscode.WebviewPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: (surface: Surface) => WorkbenchModel,
    private readonly action: (action: WorkbenchAction, session: string) => Promise<unknown>,
    private readonly error: (error: unknown, surface: Surface) => void,
  ) {}
  async show(surface: Surface) {
    if (!Object.hasOwn(titles, surface)) throw new Error('Unknown view.');
    if (surface === 'workspaces' || surface === 'settings') {
      await vscode.commands.executeCommand(surface === 'settings' ? 'warden.configureAgents' : 'warden.task.focus');
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
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>${titles[surface]}</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.subscriptions.push(
      webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          await this.receive(surface, message, webview);
        } catch (error) {
          this.error(error, surface);
        }
      }),
    );
  }
  private async receive(surface: Surface, message: unknown, webview: vscode.Webview) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid view message.');
    const envelope = message as Record<string, unknown>;
    if (envelope.type === 'ready') {
      await webview.postMessage({ type: 'model', model: this.model(surface) });
      return;
    }
    if (envelope.type !== 'action' || typeof envelope.session !== 'string') throw new Error('Unknown view message.');
    const action = parseWorkbenchAction(envelope.action);
    if (envelope.session !== this.model(surface).session) throw new Error('The repository or base branch changed. Retry from the current view.');
    const prefix = action.type.split('.')[0];
    const setup = prefix === 'setup';
    if (!setup && prefix !== surface) throw new Error('This action is not available in this view.');
    await this.action(action, envelope.session);
  }
  render() {
    for (const [surface, panel] of this.panels) void panel.webview.postMessage({ type: 'model', model: this.model(surface) });
  }
  displaysError(scope: string): boolean {
    if (scope === 'repository' || scope === 'workspaces') return [...this.panels.values()].some((panel) => panel.visible);
    return [...this.panels].some(([surface, panel]) => surface === scope && panel.visible);
  }
  dispose() {
    for (const panel of this.panels.values()) panel.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
