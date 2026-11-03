const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.checkSettingsRefresh = async (Settings, context, fixture, eventually) => {
  const contributions = context.extension.packageJSON.contributes;
  for (const item of contributions.menus['view/item/context']) {
    const command = contributions.commands.find((row) => row.command === item.command);
    assert.equal(command.enablement, undefined, 'tree item commands use row eligibility and execution guards instead of global preconditions');
    for (const key of ['warden.agentReady', 'warden.hasDevelopmentBranch', 'warden.hasPreviewSetup'])
      assert(!item.when.includes(key), 'global context changes must not rerender removed tree rows');
    const palette = contributions.menus.commandPalette.find((row) => row.command === item.command);
    assert(palette.when === 'false' || palette.when.includes('warden.agentReady'), 'palette entry points retain the agent gate');
  }
  const model = (session, ready = true) => ({
    session,
    repository: fixture.root,
    repositoryState: 'ready',
    agentConfiguration: { status: 'configured', count: 1 },
    agentReadiness: { status: ready ? 'ready' : 'unchecked' },
    workflow: { workflow: { developmentBranch: session }, workspaceConfig: { hooks: {}, previewSetup: 'echo ready' } },
    errors: [],
  });
  let current = model('settings-original');
  const settings = new Settings(() => current, context.extensionUri);
  const getChildren = settings.getChildren.bind(settings);
  let held;
  let waiting = false;
  let release;
  settings.getChildren = async (node) => {
    if (node && current.session === 'settings-next' && held) {
      waiting = true;
      await held;
    }
    return getChildren(node);
  };
  const scripts = async () => (await settings.getChildren()).find((node) => node.id === 'scripts');
  try {
    await vscode.commands.executeCommand('setContext', 'warden.agentReady', true);
    await vscode.commands.executeCommand('setContext', 'warden.hasDevelopmentBranch', true);
    await settings.show();
    await eventually(() => settings.view.visible);
    const original = await scripts();
    await settings.view.reveal(original, { expand: true });

    held = new Promise((resolve) => {
      release = resolve;
    });
    current = model('settings-next');
    settings.refresh();
    await eventually(() => waiting);
    await vscode.commands.executeCommand('setContext', 'warden.hasPreviewSetup', true);
    await vscode.commands.executeCommand('setContext', 'warden.hasPreviewSetup', false);
    await vscode.commands.executeCommand('setContext', 'warden.agentReady', false);
    await vscode.commands.executeCommand('setContext', 'warden.agentReady', true);
    release();
    held = undefined;
    await settings.view.reveal(await scripts(), { expand: true });
    assert.deepEqual(await settings.getChildren(original), [], 'old script rows cannot move to the new repository session');

    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await eventually(() => !settings.view.visible);
    current = model('settings-hidden');
    settings.refresh();
    assert.equal(settings.view.visible, false, 'refreshing scripts never opens a hidden Settings view');
    await Promise.all([settings.show(), settings.show()]);
    await eventually(() => settings.view.visible && settings.view.selection[0]?.id === 'acp');

    current = model('settings-hidden', false);
    settings.refresh();
    await vscode.commands.executeCommand('setContext', 'warden.agentReady', false);
    assert.equal(await scripts(), undefined);
    current = model('settings-reconnected');
    settings.refresh();
    await vscode.commands.executeCommand('setContext', 'warden.agentReady', true);
    await settings.view.reveal(await scripts(), { expand: true });
    console.log('Native Settings replacement passed with held child reads, row-based menus, hidden views and concurrent opens');
  } finally {
    release?.();
    settings.dispose();
  }
};
