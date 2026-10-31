import * as vscode from 'vscode';
import { Workbench } from './workbench.js';
let workbench: Workbench | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const started = performance.now();
  if (!vscode.workspace.isTrusted) return;
  workbench = new Workbench(context, started);
  await workbench.initialize();
  return workbench;
}
export async function deactivate() {
  await workbench?.close();
  workbench = undefined;
}
