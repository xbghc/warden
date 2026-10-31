import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { WorkbenchModel, WorkspaceConfig } from '@warden/shared';

export type ScriptKind = 'workspace' | 'reuse' | 'preview';
export const scriptLabels: Record<ScriptKind, string> = {
  workspace: 'Workspace Setup Script',
  reuse: 'Legacy Workspace Reuse Script',
  preview: 'Preview Setup Script',
};
export interface ScriptBinding {
  session: string;
  repository: string;
  kind: ScriptKind;
  config: WorkspaceConfig;
}
type ScriptFile = ScriptBinding & { uri: vscode.Uri; content: Uint8Array; ctime: number; mtime: number };

export function scriptValue(config: WorkspaceConfig, kind: ScriptKind): string {
  if (kind === 'preview') return config.previewSetup ?? '';
  if (kind === 'reuse') return config.hooks.reuse ?? '';
  return config.hooks.create ?? '';
}

/** Native text documents retain multiline drafts and save only to their original repository. */
export class ScriptSettings implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly files = new Map<string, ScriptFile>();
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly registration: vscode.Disposable;

  constructor(
    private readonly model: () => WorkbenchModel,
    private readonly save: (binding: ScriptBinding, value: string) => Promise<WorkspaceConfig>,
  ) {
    this.registration = vscode.workspace.registerFileSystemProvider('warden-script', this, { isCaseSensitive: true });
  }

  async open(kind: ScriptKind, session: string) {
    const model = this.model();
    if (model.session !== session || !model.repository || !model.workflow || model.busy)
      throw new Error('The repository or base branch changed. Reopen the script from Settings.');
    const config = model.workflow.workspaceConfig ?? { hooks: {} };
    let file = [...this.files.values()].find((file) => file.session === session && file.kind === kind);
    if (!file) {
      const now = Date.now();
      const uri = vscode.Uri.from({ scheme: 'warden-script', path: `/${randomUUID()}/${scriptLabels[kind]}.sh` });
      file = { uri, session, repository: model.repository, kind, config, content: Buffer.from(scriptValue(config, kind)), ctime: now, mtime: now };
      this.files.set(uri.toString(), file);
    } else {
      const uri = file.uri;
      if (!vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty)) {
        file.config = config;
        const content = Buffer.from(scriptValue(config, kind));
        if (!content.equals(Buffer.from(file.content))) {
          file.content = content;
          file.mtime = Math.max(Date.now(), file.mtime + 1);
          this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        }
      }
    }
    const document = await vscode.workspace.openTextDocument(file.uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private file(uri: vscode.Uri) {
    const file = this.files.get(uri.toString());
    if (!file) throw vscode.FileSystemError.FileNotFound(uri);
    return file;
  }
  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.file(uri);
    return { type: vscode.FileType.File, ctime: file.ctime, mtime: file.mtime, size: file.content.byteLength };
  }
  readFile(uri: vscode.Uri): Uint8Array {
    return this.file(uri).content;
  }
  async writeFile(uri: vscode.Uri, content: Uint8Array) {
    const file = this.file(uri);
    const value = Buffer.from(content).toString('utf8');
    const config = await this.save(file, value);
    file.config = config;
    file.content = Buffer.from(value);
    file.mtime = Math.max(Date.now(), file.mtime + 1);
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions('Open scripts from Warden Settings.');
  }
  delete(): never {
    throw vscode.FileSystemError.NoPermissions('Clear the script and save to remove its configuration.');
  }
  rename(): never {
    throw vscode.FileSystemError.NoPermissions('Setup scripts cannot be renamed.');
  }
  dispose() {
    this.registration.dispose();
    this.changed.dispose();
  }
}
