const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

const healthyProfile = (fixture, mode = 'normal') => ({
  id: 'setup-fixture',
  label: 'Setup fixture',
  command: fixture.node,
  args: [fixture.agent, `${fixture.journal}.check`, mode],
});
exports.verifyAgent = async (workbench, fixture) => {
  await vscode.workspace.getConfiguration('warden').update('acpAgents', [healthyProfile(fixture)], vscode.ConfigurationTarget.Global);
  await workbench.agentSetup.check();
  assert.equal(workbench.agentSetup.readiness.snapshot().status, 'ready');
};

exports.checkAgentSetup = async (workbench, extension, fixture, eventually) => {
  const configuration = vscode.workspace.getConfiguration('warden');
  const previous = configuration.inspect('acpAgents').globalValue;
  const hasBranch = !!workbench.data.workflow;
  if (hasBranch && !workbench.tasks().length) {
    await workbench.backend.execute('task.create', { title: 'Saved task behind the agent gate' });
    await workbench.refresh(true);
  }
  const taskIds = workbench.tasks().map((task) => task.id);
  const gate = async (kinds) => {
    assert.deepEqual(
      (await workbench.sidebar.getChildren()).map((node) => node.kind),
      kinds,
    );
    assert.equal(workbench.sidebar.view.description, undefined, 'base branch is hidden while the agent is unavailable');
    for (const surface of ['workspaces', 'task', 'rebase', 'settings']) {
      const model = workbench.views.currentModel(surface);
      assert.equal(model.repository, '');
      for (const field of ['workflow', 'task', 'workspaces', 'preview', 'review', 'checks']) assert.equal(model[field], undefined, `${surface} hides ${field}`);
    }
    assert.deepEqual(await workbench.getChildren(), [], 'task navigation stays hidden while the agent is unavailable');
    for (const action of [{ type: 'setup.branch' }, { type: 'task.create', title: 'Blocked task', body: '' }, { type: 'preview.refresh' }]) {
      await assert.rejects(workbench.handleAction(action, workbench.session), /ACP is unavailable/);
    }
    await vscode.commands.executeCommand('warden.createTask');
    assert.equal(workbench.taskInput, undefined, 'direct commands cannot bypass the gate');
    assert.deepEqual(
      workbench.tasks().map((task) => task.id),
      taskIds,
      'gating preserves existing tasks',
    );
  };
  const screenshot = async (name) => {
    const directory = process.env.WARDEN_VSCODE_AGENT_SETUP_SCREENSHOTS;
    if (!directory || process.platform !== 'linux') return;
    await fs.mkdir(directory, { recursive: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('warden.task.focus');
    await new Promise((resolve) => setTimeout(resolve, 500));
    execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', `${directory}/${name}.png`]);
  };
  try {
    const welcome = extension.packageJSON.contributes.viewsWelcome;
    const setupWelcome = welcome.filter((item) => item.contents.includes('command:warden.configureAgents'));
    assert.equal(setupWelcome.length, 1, 'there is one native ACP configuration button');
    assert.equal(setupWelcome[0].contents, '[Configure ACP](command:warden.configureAgents)');
    assert.equal(setupWelcome[0].when, '!warden.agentReady');
    for (const item of welcome.filter((item) => !setupWelcome.includes(item))) assert(item.when.includes('warden.agentReady'));
    const configureMenu = extension.packageJSON.contributes.menus['view/title'].find((item) => item.command === 'warden.configureAgents');
    assert.equal(configureMenu.when, 'view == warden.task && warden.agentReady');
    for (const command of ['warden.configure', 'warden.createTask', 'warden.showPreview']) {
      assert.equal(extension.packageJSON.contributes.commands.find((item) => item.command === command).enablement, 'warden.agentReady');
    }
    await configuration.update('acpAgents', [], vscode.ConfigurationTarget.Global);
    await eventually(() => workbench.model('workspaces').agentConfiguration.status === 'missing');
    await gate([]);
    assert.equal(workbench.sidebar.view.message, undefined, 'missing ACP shows only the native button');
    await screenshot(hasBranch ? 'missing-with-saved-work' : 'missing-before-branch');
    await vscode.commands.executeCommand('warden.configureAgents');
    const settings = workbench.views.panels.get('settings');
    await eventually(() => settings?.active);
    assert(settings, 'Configure ACP opens Warden Settings before branch selection');
    assert.equal(workbench.agentSetup.picker, undefined, 'the sidebar button does not open the preset picker');
    await workbench.handleAction({ type: 'setup.agents' }, workbench.session);
    assert.equal(workbench.views.panels.get('settings'), settings, 'all configuration entry points reuse one Settings panel');
    assert.equal(workbench.model('settings').agentConfiguration.status, 'missing', 'opening Settings does not configure an agent');
    await assert.rejects(configuration.update('acpAgents', [healthyProfile(fixture)], vscode.ConfigurationTarget.Workspace), /only into User settings/);

    await configuration.update('acpAgents', [{ id: 'broken' }], vscode.ConfigurationTarget.Global);
    await gate([]);
    assert.equal(workbench.model('settings').agentConfiguration.status, 'invalid');
    await screenshot('invalid-profile');

    await configuration.update('acpAgents', [healthyProfile(fixture, 'initialize-hangs')], vscode.ConfigurationTarget.Global);
    assert.equal(workbench.model('settings').agentConfiguration.status, 'configured');
    await eventually(() => workbench.model('settings').agentReadiness.status === 'checking');
    await gate([]);
    await screenshot('connecting');
    await vscode.commands.executeCommand('warden.cancelAgentCheck');
    assert.equal(workbench.model('settings').agentReadiness.status, 'unchecked');

    await configuration.update('acpAgents', [{ ...healthyProfile(fixture), command: `${fixture.node}-missing-agent` }], vscode.ConfigurationTarget.Global);
    await eventually(() => workbench.model('settings').agentReadiness.status === 'error');
    await gate([]);
    await screenshot('unavailable-agent');

    await configuration.update('acpAgents', [healthyProfile(fixture, 'incompatible')], vscode.ConfigurationTarget.Global);
    await eventually(() => workbench.model('settings').agentReadiness.status === 'error');
    await gate([]);

    await configuration.update('acpAgents', [healthyProfile(fixture, 'auth')], vscode.ConfigurationTarget.Global);
    await eventually(() => workbench.model('settings').agentReadiness.status === 'authentication_required');
    await gate([]);
    await screenshot('authentication-required');
    const login = vscode.commands.executeCommand('warden.checkAgent');
    await eventually(async () => {
      const state = workbench.agentSetup.readiness.snapshot().status;
      if (state === 'ready') return true;
      if (state === 'authentication_required') await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return false;
    });
    await login;
    assert.deepEqual(
      (await workbench.sidebar.getChildren()).map((node) => node.kind),
      hasBranch ? taskIds.map(() => 'task') : [],
    );
    await screenshot(hasBranch ? 'verified-with-saved-work' : 'verified-before-branch');

    const events = async () => (await fs.readFile(`${fixture.journal}.check`, 'utf8')).trim().split('\n').map(JSON.parse);
    const connectedPid = (await events()).filter((row) => row.method === 'initialize').at(-1).pid;
    assert.doesNotThrow(() => process.kill(connectedPid, 0), 'the startup connection stays alive');
    process.kill(connectedPid, 'SIGTERM');
    await eventually(() => workbench.model('settings').agentReadiness.status === 'error');
    await gate([]);
    await exports.verifyAgent(workbench, fixture);
    assert.deepEqual(
      workbench.tasks().map((task) => task.id),
      taskIds,
    );
    const originalPid = (await events()).filter((row) => row.method === 'initialize').at(-1).pid;
    await configuration.update('acpAgents', [{ ...healthyProfile(fixture), label: 'Updated fixture' }], vscode.ConfigurationTarget.Global);
    await eventually(() => {
      const state = workbench.agentSetup.readiness.snapshot();
      return state.status === 'ready' && state.profile.label === 'Updated fixture';
    });
    assert.throws(() => process.kill(originalPid, 0), 'settings replacement stops the previous connection');

    const startup = new workbench.agentSetup.constructor(
      () => fixture.root,
      () => {},
      workbench.context.globalState,
    );
    let startupPid;
    try {
      startup.start();
      await eventually(() => startup.readiness.snapshot().status === 'ready');
      startupPid = (await events()).filter((row) => row.method === 'initialize').at(-1).pid;
      assert.doesNotThrow(() => process.kill(startupPid, 0), 'a new window connects from saved configuration without a manual check');
    } finally {
      await startup.close();
    }
    assert.throws(() => process.kill(startupPid, 0), 'closing the window stops its owned ACP process');
    assert.equal(workbench.agentSetup.readiness.snapshot().status, 'ready', 'another window connection is not stopped');
    const launches = (await events()).filter((row) => row.method === 'initialize').length;
    const cancelledStartup = new workbench.agentSetup.constructor(
      () => fixture.root,
      () => {},
      workbench.context.globalState,
    );
    cancelledStartup.start();
    await cancelledStartup.close();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await events()).filter((row) => row.method === 'initialize').length, launches, 'shutdown cancels scheduled startup');
    const wire = await events();
    assert(!wire.some((row) => row.method === 'session/prompt'), 'startup and reconnection never send work prompts');
    assert.equal(workbench.conversations.entries.size, 0, 'checks do not create Warden task chats');
  } finally {
    await configuration.update('acpAgents', previous, vscode.ConfigurationTarget.Global);
    if (previous?.length) await workbench.agentSetup.check();
  }
};

exports.checkAgentPresets = async (workbench, fixture, eventually) => {
  const configuration = vscode.workspace.getConfiguration('warden');
  const previous = configuration.inspect('acpAgents').globalValue;
  const value = () => vscode.workspace.getConfiguration('warden').inspect('acpAgents').globalValue;
  const setup = workbench.agentSetup;
  const accept = async (control, field) => {
    await eventually(async () => {
      if (setup[field] !== control) return true;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return setup[field] !== control;
    });
  };
  const choose = async (presetId) => {
    await eventually(() => !!setup.picker);
    const picker = setup.picker;
    const item = picker.items.find((item) => item.presetId === presetId);
    assert(item);
    picker.value = item.label;
    await eventually(() => picker.activeItems[0]?.label === item.label);
    await accept(picker, 'picker');
  };
  try {
    await configuration.update('acpAgents', [], vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('warden.configureAgents');
    let pending = workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    await eventually(() => !!setup.picker);
    assert.deepEqual(
      setup.picker.items.map((item) => item.label),
      ['Codex', 'OpenCode', 'Custom Agent / Edit Settings'],
    );
    if (process.env.WARDEN_VSCODE_AGENT_SETUP_SCREENSHOTS && process.platform === 'linux') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', `${process.env.WARDEN_VSCODE_AGENT_SETUP_SCREENSHOTS}/presets.png`]);
    }
    setup.picker.hide();
    await pending;
    assert.deepEqual(value(), [], 'cancelling the preset picker cannot change settings');

    pending = workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    await choose('codex');
    await eventually(() => !!setup.input);
    assert.equal(setup.input.value, process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp');
    setup.input.value = ' ';
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await eventually(() => !!setup.input?.validationMessage);
    assert(setup.input.validationMessage, 'an empty command cannot be saved');
    setup.input.hide();
    await pending;
    assert.deepEqual(value(), [], 'cancelling command input cannot add a profile');

    pending = workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    await choose('codex');
    await eventually(() => !!setup.input);
    const custom = { id: 'custom', label: 'Existing agent', command: fixture.node, env: { CUSTOM_SETTING: 'fixture' } };
    await configuration.update('acpAgents', [custom], vscode.ConfigurationTarget.Global);
    const executable = process.platform === 'win32' ? 'C:\\Agents with spaces\\codex-acp.exe' : '/agents with spaces/codex-acp';
    setup.input.value = executable;
    await accept(setup.input, 'input');
    await pending;
    assert.deepEqual(value(), [custom, { id: 'codex', label: 'Codex', command: executable, args: [] }], 'saving preserves edits made while the input was open');
    assert.equal(workbench.model('workspaces').agentConfiguration.count, 2);
    await eventually(() => setup.readiness.snapshot().status === 'error' && setup.readiness.snapshot().profile?.id === 'codex');

    pending = workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    await choose('opencode');
    await eventually(() => !!setup.input);
    assert.equal(setup.input.value, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    setup.input.value = `${fixture.node}-opencode-fixture`;
    const openCode = { id: 'opencode', label: 'OpenCode', command: setup.input.value, args: ['acp'] };
    await accept(setup.input, 'input');
    await pending;
    const configured = value();
    assert.deepEqual(configured.at(-1), openCode);
    assert.equal(configured.length, 3);

    pending = workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    await eventually(() => !!setup.picker);
    assert.match(setup.picker.items.find((item) => item.presetId === 'codex').description, /Configured/);
    await choose('codex');
    await pending;
    assert.equal(setup.input, undefined, 'an existing preset goes to settings');
    assert.deepEqual(value(), configured, 'selecting a configured preset never duplicates or overwrites it');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    pending = workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    await choose(undefined);
    await pending;
    assert(
      vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.label === 'Settings')),
      'custom agents retain native settings access',
    );

    await configuration.update('acpAgents', [], vscode.ConfigurationTarget.Global);
    pending = workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    await choose('opencode');
    await eventually(() => !!setup.input);
    const concurrent = { ...openCode, command: fixture.node, args: ['--custom'] };
    await configuration.update('acpAgents', [concurrent], vscode.ConfigurationTarget.Global);
    await accept(setup.input, 'input');
    await pending;
    assert.deepEqual(value(), [concurrent], 'a preset configured while the input was open is preserved');

    const invalid = [{ id: 'broken' }];
    await configuration.update('acpAgents', invalid, vscode.ConfigurationTarget.Global);
    assert.equal(workbench.model('settings').agentConfiguration.status, 'invalid');
    await workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    assert.equal(setup.picker, undefined, 'invalid settings go directly to repair');
    assert.deepEqual(value(), invalid, 'invalid settings are not replaced by presets');
    assert.equal(workbench.data.workflow, null, 'presets are configured before selecting a branch');
    assert.equal(workbench.conversations.entries.size, 0);
    await assert.rejects(fs.access(fixture.journal), 'configuration never starts a task conversation');
  } finally {
    setup.picker?.hide();
    setup.input?.hide();
    await configuration.update('acpAgents', previous, vscode.ConfigurationTarget.Global);
  }
};
