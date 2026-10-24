import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

interface Snapshot {
  content: string;
  repository: string;
  path: string;
}

/** Immutable snapshots survive editor reloads without reading a newer working copy. */
export class Documents implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, Snapshot>();
  constructor(private readonly context: vscode.ExtensionContext) {}
  private directory() {
    return vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, 'reviews');
  }
  private key(uri: vscode.Uri) {
    const key = uri.path.split('/')[1];
    if (uri.scheme !== 'warden-review' || !key || !/^[a-f0-9-]{36}$/.test(key)) throw new Error('无效的审阅快照');
    return key;
  }
  async snapshot(uri: vscode.Uri): Promise<Snapshot> {
    const key = this.key(uri);
    const cached = this.contents.get(key);
    if (cached) return cached;
    try {
      const data = JSON.parse(
        Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.directory(), `${key}.json`))).toString('utf8'),
      ) as Snapshot;
      if (typeof data.content !== 'string' || typeof data.path !== 'string' || typeof data.repository !== 'string') throw new Error('invalid snapshot');
      this.contents.set(key, data);
      return data;
    } catch {
      throw new Error('此审阅快照已不可用，请重新打开任务差异');
    }
  }
  async provideTextDocumentContent(uri: vscode.Uri) {
    return (await this.snapshot(uri)).content;
  }
  async add(name: string, content: string, repository: string, relativePath: string) {
    const key = randomUUID();
    const snapshot = { content, repository, path: relativePath };
    await vscode.workspace.fs.createDirectory(this.directory());
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.directory(), `${key}.json`), Buffer.from(JSON.stringify(snapshot)));
    this.contents.set(key, snapshot);
    return vscode.Uri.from({ scheme: 'warden-review', path: `/${key}/${name}` });
  }
  remove(uri: vscode.Uri) {
    if (uri.scheme === 'warden-review') this.contents.delete(this.key(uri));
  }
  async copyLocation() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'warden-review') return;
    const snapshot = await this.snapshot(editor.document.uri);
    const selection = editor.selection;
    const start = selection.start.line + 1;
    const end = selection.end.line + (selection.end.character === 0 && selection.end.line > selection.start.line ? 0 : 1);
    await vscode.env.clipboard.writeText(`${snapshot.path}:${start}${end > start ? `-${end}` : ''}`);
  }
}
