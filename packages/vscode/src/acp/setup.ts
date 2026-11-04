import * as vscode from 'vscode';
import { acpPresets, addAcpPreset, parseAcpProfiles, presetCommandError } from './profiles.js';
import type { AcpProfile } from './contracts.js';
import { AcpReadinessCheck } from './readiness.js';
import type { PerformanceLog } from '../performance.js';
import { DiagnosticLog, diagnosticError } from '@warden/shared';
import { acpErrorDiagnostic } from './diagnostics.js';

function profileValue() {
  const inspected = vscode.workspace.getConfiguration('warden').inspect<unknown>('acpAgents');
  return inspected?.globalValue === undefined ? inspected?.defaultValue : inspected.globalValue;
}

export function readAcpProfiles() {
  // Even a hand-edited workspace setting cannot supply an executable command.
  return parseAcpProfiles(profileValue());
}

export function autoApproveRepositoryReads() {
  const inspected = vscode.workspace.getConfiguration('warden').inspect<boolean>('acpAutoApproveReads');
  // Repository content cannot enable approvals that the User or Remote User profile disabled.
  return (inspected?.globalValue ?? inspected?.defaultValue) === true;
}

type Choice = vscode.QuickPickItem & { presetId?: string };

/** Presets become executable configuration only after the user confirms the command. */
export class AcpAgentSetup implements vscode.Disposable {
  private active?: Promise<void>;
  private picker?: vscode.QuickPick<Choice>;
  private input?: vscode.InputBox;
  private closed = false;
  readonly readiness: AcpReadinessCheck;
  private readonly configurationChanged: vscode.Disposable;
  private checking?: Promise<void>;
  private started = false;
  private revision = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private selection?: vscode.CancellationTokenSource;
  private readonly automatic = new Set<Promise<void>>();
  private preferredId?: string;
  private connectionPending = false;

  constructor(
    private readonly directory: () => string | undefined,
    private readonly changed: () => void,
    private readonly state: vscode.Memento,
    performance?: PerformanceLog,
    private readonly log = new DiagnosticLog(),
  ) {
    this.preferredId = state.get<string>('warden.acpProfile');
    this.readiness = new AcpReadinessCheck(
      () => {
        if (!this.closed) changed();
      },
      undefined,
      performance,
      log,
    );
    this.configurationChanged = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('warden.acpAgents')) this.scheduleConnection();
    });
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.scheduleConnection();
  }

  get connecting() {
    return this.connectionPending || this.readiness.snapshot().status === 'checking';
  }

  private scheduleConnection(preferredId?: string) {
    if (this.closed) return;
    if (preferredId) this.preferredId = preferredId;
    const revision = ++this.revision;
    this.log.write('debug', 'acp.connection.scheduled', { revision, started: this.started });
    clearTimeout(this.reconnectTimer);
    this.selection?.cancel();
    // Waiting for the coalesced startup attempt is still loading, not a request for setup.
    this.connectionPending = this.started;
    void this.readiness.reset().catch((error) => this.log.write('error', 'acp.reset.failed', diagnosticError(error)));
    if (!this.started) return;
    // A settings save can emit several changes. Retire the old connection immediately,
    // then start only the latest valid user configuration without opening a picker.
    this.reconnectTimer = setTimeout(() => {
      const pending = this.connectAutomatically(revision).finally(() => {
        if (this.closed || revision !== this.revision) return;
        this.connectionPending = false;
        this.changed();
      });
      this.automatic.add(pending);
      void pending.then(
        () => this.automatic.delete(pending),
        () => this.automatic.delete(pending),
      );
    }, 300);
  }

  private async connectAutomatically(revision: number) {
    if (this.closed || revision !== this.revision || !vscode.workspace.isTrusted) {
      this.log.write('debug', 'acp.connection.skipped', { revision, reason: this.closed ? 'closed' : revision !== this.revision ? 'replaced' : 'untrusted' });
      return;
    }
    let profiles: AcpProfile[];
    try {
      profiles = readAcpProfiles();
    } catch (error) {
      this.log.write('warn', 'acp.configuration.invalid', { ...diagnosticError(error), diagnostic: acpErrorDiagnostic(error) });
      return;
    }
    const profile = profiles.find((item) => item.id === this.preferredId) ?? profiles[0];
    const cwd = this.directory();
    if (!profile || !cwd) {
      this.log.write('info', 'acp.connection.skipped', { reason: !profile ? 'no_profile' : 'no_workspace' });
      return;
    }
    await this.readiness.check(profile, cwd);
    this.rememberConnection(revision);
  }

  private rememberConnection(revision: number) {
    const connected = this.readiness.snapshot();
    if (this.closed || revision !== this.revision || connected.status !== 'ready' || !connected.profile) return;
    this.preferredId = connected.profile.id;
    void this.state
      .update('warden.acpProfile', this.preferredId)
      .then(undefined, (error) => this.log.write('warn', 'acp.selection.save.failed', diagnosticError(error)));
  }

  check(profileId?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.checking) {
      clearTimeout(this.reconnectTimer);
      this.connectionPending = true;
      const revision = ++this.revision;
      this.selection = new vscode.CancellationTokenSource();
      this.checking = this.checkAgent(revision, profileId).finally(() => {
        this.selection?.dispose();
        this.selection = undefined;
        this.checking = undefined;
        if (revision === this.revision) this.connectionPending = false;
        if (!this.closed) this.changed();
      });
    }
    return this.checking;
  }

  private async checkAgent(revision: number, profileId?: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace first.');
    const profiles = readAcpProfiles();
    if (!profiles.length) {
      await this.configure();
      return;
    }
    const cwd = this.directory();
    if (!cwd) throw new Error('Open a workspace folder before checking the agent.');
    const state = this.readiness.snapshot();
    if (!profileId && state.status === 'authentication_required' && state.authMethods?.length) {
      const choice = await vscode.window.showQuickPick(
        [
          ...state.authMethods.map((method) => ({ label: method.name, description: method.description, methodId: method.id })),
          { label: 'I Have Signed In — Reconnect', description: 'Reconnect after signing in externally.', methodId: undefined },
        ],
        { title: 'Authenticate Agent' },
        this.selection?.token,
      );
      if (!choice || this.closed || revision !== this.revision) return;
      if (choice.methodId) {
        await this.readiness.authenticate(choice.methodId);
        this.rememberConnection(revision);
        return;
      }
    }
    const profile = profileId
      ? profiles.find((item) => item.id === profileId)
      : profiles.length === 1
        ? profiles[0]
        : (
            await vscode.window.showQuickPick(
              profiles.map((profile) => ({ label: profile.label, description: profile.id, profile })),
              { title: 'Connect ACP' },
              this.selection?.token,
            )
          )?.profile;
    if (!profile || this.closed || revision !== this.revision) return;
    // A picker can outlive a settings edit; never check an obsolete executable.
    const current = readAcpProfiles().find((item) => item.id === profile.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(profile)) throw new Error('Agent settings changed. Check the current profile again.');
    await this.readiness.check(current, cwd);
    this.rememberConnection(revision);
  }

  disconnect() {
    this.log.write('info', 'acp.disconnect.requested');
    ++this.revision;
    clearTimeout(this.reconnectTimer);
    this.connectionPending = false;
    this.selection?.cancel();
    return this.readiness.reset();
  }

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
    const previousId = this.preferredId;
    this.preferredId = preset.id;
    try {
      await vscode.workspace.getConfiguration('warden').update('acpAgents', next, vscode.ConfigurationTarget.Global);
    } catch (error) {
      this.preferredId = previousId;
      throw error;
    }
    this.scheduleConnection(preset.id);
  }

  dispose() {
    this.closed = true;
    ++this.revision;
    clearTimeout(this.reconnectTimer);
    this.selection?.cancel();
    this.configurationChanged.dispose();
    this.picker?.hide();
    this.input?.hide();
    void this.readiness.close().catch((error) => this.log.write('error', 'acp.close.failed', diagnosticError(error)));
  }

  async close() {
    this.dispose();
    await this.readiness.close();
    await Promise.allSettled([...this.automatic, this.checking, this.active]);
  }
}
