import * as vscode from 'vscode';
import type { AgentReadiness, WorkbenchModel } from '@warden/shared';
import { scriptLabels, scriptValue } from './script-settings.js';
import type { ScriptKind } from './script-settings.js';

export class SettingsNode extends vscode.TreeItem {
  readonly kind = 'setting';
  session?: string;
  children?: SettingsNode[];
  parent?: SettingsNode;
}

const connectionLabels: Record<AgentReadiness['status'], string> = {
  unchecked: 'Disconnected',
  checking: 'Connecting…',
  authentication_required: 'Authentication Required',
  ready: 'Connected',
  error: 'Connection Failed',
};

/** The view container supplies stacking, resizing, collapse and keyboard navigation. */
export class Settings implements vscode.TreeDataProvider<SettingsNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SettingsNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<SettingsNode>;
  private readonly agent = this.row('acp', 'ACP', 'plug');
  private signature?: string;
  private showing?: Promise<void>;

  constructor(
    private readonly model: () => WorkbenchModel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.view = vscode.window.createTreeView('warden.settings', { treeDataProvider: this });
  }

  refresh() {
    const model = this.model();
    const problem =
      model.agentConfiguration.status === 'invalid'
        ? model.agentConfiguration.message
        : ['error', 'authentication_required'].includes(model.agentReadiness.status)
          ? model.agentReadiness.message
          : undefined;
    this.view.message =
      [problem, ...model.errors.filter((error) => ['agent', 'settings', 'repository'].includes(error.scope)).map((error) => error.message)]
        .filter(Boolean)
        .join('\n') || undefined;
    const signature = JSON.stringify({
      session: model.session,
      repository: model.repository,
      repositoryState: model.repositoryState,
      configuration: model.agentConfiguration,
      readiness: model.agentReadiness,
      config: model.workflow?.workspaceConfig,
      hasPreviewCommand: model.hasPreviewCommand,
      busy: model.busy,
    });
    if (this.signature === signature) return;
    this.signature = signature;
    this.changed.fire(undefined);
  }

  async show() {
    // Focusing the view alone leaves a previously collapsed ACP section closed.
    // Reveal the provider's existing element so VS Code need not resolve a new root.
    this.showing ??= Promise.resolve().then(() => this.view.reveal(this.agent, { select: true, focus: true, expand: true }));
    const opening = this.showing;
    try {
      await opening;
    } finally {
      if (this.showing === opening) this.showing = undefined;
    }
  }
  getTreeItem(node: SettingsNode) {
    // Menu updates can render a retained row after navigation. Keep its original
    // session identity instead of reusing a replacement repository's tree handle.
    return node.session ? { ...node, id: `${node.session}:${node.id}` } : node;
  }
  getParent(node: SettingsNode) {
    return node.parent;
  }
  getChildren(node?: SettingsNode): SettingsNode[] {
    const model = this.model();
    if (node?.session && (node.session !== model.session || model.repositoryState !== 'ready' || model.agentReadiness.status !== 'ready' || !model.workflow))
      return [];
    if (node)
      return (node.children ?? []).map((child) => {
        child.parent = node;
        return child;
      });
    const { agentConfiguration: configuration, agentReadiness: readiness } = model;
    const configured = configuration.status === 'configured';
    const status = configured ? connectionLabels[readiness.status] : configuration.status === 'invalid' ? 'Invalid Configuration' : 'Not Configured';
    const agent = this.agent;
    agent.description = status;
    agent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    agent.children = [];
    const connection = this.row(
      'connection',
      readiness.profile?.label ?? 'Connection',
      readiness.status === 'checking'
        ? 'loading~spin'
        : readiness.status === 'error' || configuration.status === 'invalid'
          ? 'warning'
          : readiness.status === 'ready'
            ? 'pass'
            : 'debug-disconnect',
    );
    connection.tooltip = configuration.status === 'invalid' ? configuration.message : (readiness.message ?? 'Configure an agent on the workspace host.');
    if (readiness.profile) agent.children.push(connection);
    if (configured) {
      const checking = readiness.status === 'checking';
      const label = checking
        ? 'Cancel Connection'
        : readiness.status === 'authentication_required' && readiness.authMethods?.length
          ? 'Authenticate Agent'
          : readiness.status === 'ready'
            ? 'Reconnect ACP'
            : 'Connect ACP';
      agent.children.push(this.row('connect', label, checking ? 'debug-stop' : 'debug-restart', checking ? 'warden.cancelAgentCheck' : 'warden.checkAgent'));
      if (readiness.status === 'ready' || readiness.status === 'authentication_required')
        agent.children.push(this.row('disconnect', 'Disconnect ACP', 'debug-disconnect', 'warden.cancelAgentCheck'));
    }
    agent.children.push(
      this.row('preset', configuration.status === 'invalid' ? 'Fix Agent Configuration' : 'Choose Agent Preset', 'list-selection', 'warden.chooseAgentPreset'),
      this.row('profiles', 'Agent Profiles', 'settings-gear', 'workbench.action.openSettings', ['warden.acpAgents']),
      this.row('example', 'Custom Agent Example', 'file-code', 'vscode.open', [vscode.Uri.joinPath(this.extensionUri, 'examples', 'acp-agents.jsonc')]),
    );
    const help = this.row('guide', 'ACP Setup Guide', 'book');
    help.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    help.children = [
      this.row('codex-guide', 'Codex ACP Adapter', 'link-external', 'vscode.open', [vscode.Uri.parse('https://github.com/agentclientprotocol/codex-acp')]),
      this.row('opencode-guide', 'OpenCode ACP Guide', 'link-external', 'vscode.open', [vscode.Uri.parse('https://docs.opencode.ai/docs/acp/')]),
    ];
    help.tooltip =
      'Install and authenticate on the workspace host, then choose a preset. Use User or Remote User settings for custom agents, arguments and environment variables. On Windows, use a native .exe or configure an explicit launcher.';
    agent.children.push(help);
    const roots = [agent];
    if (!configured || readiness.status !== 'ready' || !model.repository || !model.workflow) return roots;
    const scripts = this.row('scripts', 'Scripts', 'terminal');
    scripts.session = model.session;
    scripts.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    scripts.tooltip = model.repository;
    const config = model.workflow.workspaceConfig ?? { hooks: {} };
    const kinds: ScriptKind[] = ['workspace', ...(config.hooks.reuse && config.hooks.reuse !== config.hooks.create ? ['reuse' as const] : []), 'preview'];
    scripts.children = kinds.map((kind) => {
      const item = this.row(`script:${kind}`, scriptLabels[kind], 'file-code', 'warden.editSetupScript', [kind, model.session]);
      item.session = model.session;
      // Row eligibility avoids global menu updates rerendering removed tree items during navigation.
      if (kind === 'preview' && scriptValue(config, kind).trim()) item.contextValue = 'wardenPreviewSetup';
      item.description = scriptValue(config, kind).trim() ? 'Configured' : 'Not Set';
      item.tooltip = `${scriptLabels[kind]}\n${model.repository}\nOpen in the text editor. Save to update configuration. ${kind === 'preview' ? 'Runs on preview initialization, updates and configuration changes.' : 'Runs when a task workspace is allocated.'}`;
      return item;
    });
    scripts.children.push(this.row('preview-command', 'Preview Command', 'terminal', 'workbench.action.openSettings', ['warden.previewCommand']));
    for (const child of scripts.children) child.session = model.session;
    roots.push(scripts);
    return roots;
  }

  private row(id: string, label: string, icon: string, command?: string, args?: unknown[]): SettingsNode {
    const node = new SettingsNode(label);
    node.id = id;
    node.iconPath = new vscode.ThemeIcon(icon);
    if (command) node.command = { command, title: label, arguments: args };
    return node;
  }
  dispose() {
    this.view.dispose();
    this.changed.dispose();
  }
}
