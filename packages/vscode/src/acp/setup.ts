import * as vscode from 'vscode';
import { acpPresets, addAcpPreset, parseAcpProfiles, presetCommandError } from './profiles.js';
import type { AcpProfile } from './contracts.js';

function profileValue() {
  const inspected = vscode.workspace.getConfiguration('warden').inspect<unknown>('acpAgents');
  return inspected?.globalValue === undefined ? inspected?.defaultValue : inspected.globalValue;
}

export function readAcpProfiles() {
  // Even a hand-edited workspace setting cannot supply an executable command.
  return parseAcpProfiles(profileValue());
}

type Choice = vscode.QuickPickItem & { presetId?: string };

/** Presets become executable configuration only after the user confirms the command. */
export class AcpAgentSetup implements vscode.Disposable {
  private active?: Promise<void>;
  private picker?: vscode.QuickPick<Choice>;
  private input?: vscode.InputBox;
  private closed = false;

  configure(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.active)
      this.active = this.run().finally(() => {
        this.active = undefined;
      });
    return this.active;
  }

  private async settings() {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'warden.acpAgents');
  }

  private async run() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace first.');
    let profiles: AcpProfile[];
    try {
      profiles = readAcpProfiles();
    } catch {
      await this.settings();
      return;
    }
    const picker = vscode.window.createQuickPick<Choice>();
    this.picker = picker;
    picker.title = 'Configure Agent';
    picker.placeholder = 'Add a preset or edit your agent settings';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = [
      ...acpPresets.map((preset) => ({
        label: preset.label,
        presetId: preset.id,
        description: profiles.some((profile) => profile.id === preset.id) ? 'Configured · Edit Settings' : [preset.command, ...preset.args].join(' '),
        detail: preset.detail,
      })),
      { label: 'Custom Agent / Edit Settings', detail: 'Edit executable paths, arguments and environment variables in User or Remote User settings.' },
    ];
    const subscriptions: vscode.Disposable[] = [];
    let choice: Choice | undefined;
    try {
      choice = await new Promise<Choice | undefined>((resolve) => {
        subscriptions.push(
          picker.onDidAccept(() => {
            if (!picker.selectedItems.length) return;
            resolve(picker.selectedItems[0]);
            picker.hide();
          }),
          picker.onDidHide(() => resolve(undefined)),
        );
        picker.show();
      });
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      picker.dispose();
      this.picker = undefined;
    }
    if (!choice || this.closed) return;
    const preset = acpPresets.find((preset) => preset.id === choice.presetId);
    if (!preset || readAcpProfiles().some((profile) => profile.id === preset.id)) {
      await this.settings();
      return;
    }

    const input = vscode.window.createInputBox();
    this.input = input;
    input.title = `Add ${preset.label} Agent`;
    input.prompt = `Executable on the workspace host${process.platform === 'win32' ? ' (.exe)' : ''}. Arguments: ${JSON.stringify(preset.args)}. Enter to save, Escape to cancel.`;
    input.value = process.platform === 'win32' ? `${preset.command}.exe` : preset.command;
    input.placeholder = 'Executable name or absolute path';
    input.ignoreFocusOut = true;
    const listeners: vscode.Disposable[] = [];
    let command: string | undefined;
    try {
      command = await new Promise<string | undefined>((resolve) => {
        listeners.push(
          input.onDidChangeValue((value) => {
            input.validationMessage = presetCommandError(value);
          }),
          input.onDidAccept(() => {
            input.validationMessage = presetCommandError(input.value);
            if (input.validationMessage) return;
            resolve(input.value);
            input.hide();
          }),
          input.onDidHide(() => resolve(undefined)),
        );
        input.show();
      });
    } finally {
      for (const listener of listeners) listener.dispose();
      input.dispose();
      this.input = undefined;
    }
    if (command === undefined || this.closed) return;
    // Settings may change in another editor while the command input is open.
    const current = profileValue();
    const next = addAcpPreset(current, preset.id, command);
    if (next === current) {
      await this.settings();
      return;
    }
    await vscode.workspace.getConfiguration('warden').update('acpAgents', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`${preset.label} profile added. Connect from Task Chat when the agent is installed and authenticated.`);
  }

  dispose() {
    this.closed = true;
    this.picker?.hide();
    this.input?.hide();
  }
}
