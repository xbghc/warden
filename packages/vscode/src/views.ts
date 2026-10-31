import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { parseWorkbenchAction } from '@warden/shared';
import type { Surface, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { TaskNoteDrafts } from './task-note-drafts.js';

const titles: Record<Surface, string> = { workspaces: 'Workbench', task: 'Task', preview: 'Preview', settings: 'Settings', rebase: 'Rebase' };

export class Views implements vscode.Disposable {
  private readonly panels = new Map<Surface, vscode.WebviewPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private taskModel?: WorkbenchModel;
  private readonly notes: TaskNoteDrafts;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: (surface: Surface) => WorkbenchModel,
    private readonly action: (action: WorkbenchAction, session: string) => Promise<unknown>,
    private readonly error: (error: unknown, surface: Surface, taskId?: string) => void,
  ) {
    this.notes = new TaskNoteDrafts(context.workspaceState);
  }
  async show(surface: Surface) {
    if (!Object.hasOwn(titles, surface)) throw new Error('Unknown view.');
    if (surface === 'workspaces') {
      await vscode.commands.executeCommand('warden.task.focus');
      return;
    }
    if (surface === 'task') {
      this.taskModel = this.model('task');
      const { repository, task } = this.taskModel;
      if (task) await this.notes.saved(repository, task.id, { title: task.title, body: task.body ?? '' });
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
        const taskId = surface === 'task' ? this.taskModel?.task?.id : undefined;
        try {
          await this.receive(surface, message, webview);
        } catch (error) {
          this.error(error, surface, taskId);
        }
      }),
    );
  }
  private async receive(surface: Surface, message: unknown, webview: vscode.Webview) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid view message.');
    const envelope = message as Record<string, unknown>;
    if (envelope.type === 'ready') {
      await webview.postMessage({ type: 'model', model: this.currentModel(surface) });
      return;
    }
    if (envelope.type !== 'action' || typeof envelope.session !== 'string') throw new Error('Unknown view message.');
    const action = parseWorkbenchAction(envelope.action);
    const binding = this.taskModel;
    if (surface === 'task' && action.type === 'task.draft') {
      if (!binding?.task || binding.session !== envelope.session || binding.task.id !== action.taskId)
        throw new Error('This editor can only modify its assigned task draft.');
      // Drafts still belong to the pinned task while a branch switch disables saving.
      const current = this.currentModel('task');
      const task = current.repository === binding.repository && current.task?.id === action.taskId ? current.task : binding.task;
      await this.notes.save(binding.repository, action.taskId, action, { title: task.title, body: task.body ?? '' });
      return;
    }
    if (envelope.session !== this.model(surface).session) throw new Error('The repository or base branch changed. Retry from the current view.');
    const prefix = action.type.split('.')[0];
    const setup = prefix === 'setup';
    if (!setup && prefix !== surface) throw new Error('This action is not available in this view.');
    if (surface === 'task' && !setup && ('taskId' in action ? action.taskId !== binding?.task?.id : true))
      throw new Error('This editor can only modify its assigned task.');
    await this.action(action, envelope.session);
    if (surface === 'task' && action.type === 'task.update' && binding) {
      const current = this.currentModel('task');
      const submitted = { title: action.title.trim(), body: action.body.trim() };
      if (
        current.repository === binding.repository &&
        current.task?.id === action.taskId &&
        current.task.title === submitted.title &&
        (current.task.body ?? '') === submitted.body
      ) {
        await this.notes.saved(binding.repository, action.taskId, submitted);
        this.render();
      }
    }
  }
  private currentModel(surface: Surface): WorkbenchModel {
    const model = this.model(surface);
    const pinned = this.taskModel;
    if (surface !== 'task' || !pinned) return model;
    const task = model.workspaces?.find((row) => row.task.id === pinned.task?.id)?.task;
    const taskDraft = pinned.task && this.notes.read(pinned.repository, pinned.task.id);
    if (model.session !== pinned.session || !task)
      return { ...pinned, taskDraft, busy: 'The repository or base branch changed. Switch back and reopen the task editor.' };
    return { ...model, task, taskDraft };
  }
  render() {
    for (const [surface, panel] of this.panels) void panel.webview.postMessage({ type: 'model', model: this.currentModel(surface) });
  }
  displaysError(scope: string): boolean {
    if (scope === 'repository' || scope === 'workspaces') return [...this.panels.values()].some((panel) => panel.visible);
    if (scope.startsWith('task:')) return !!this.panels.get('task')?.visible && scope === `task:${this.currentModel('task').task?.id}`;
    return [...this.panels].some(([surface, panel]) => surface === scope && panel.visible);
  }
  flush() {
    return this.notes.flush();
  }
  dispose() {
    for (const panel of this.panels.values()) panel.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
