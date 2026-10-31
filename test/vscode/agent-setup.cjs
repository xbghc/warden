const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

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
    let pending = vscode.commands.executeCommand('warden.configureAgents');
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

    pending = vscode.commands.executeCommand('warden.configureAgents');
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

    pending = vscode.commands.executeCommand('warden.configureAgents');
    await choose('codex');
    await eventually(() => !!setup.input);
    const custom = { id: 'custom', label: 'Existing agent', command: fixture.node, env: { CUSTOM_SETTING: 'fixture' } };
    await configuration.update('acpAgents', [custom], vscode.ConfigurationTarget.Global);
    const executable = process.platform === 'win32' ? 'C:\\Agents with spaces\\codex-acp.exe' : '/agents with spaces/codex-acp';
    setup.input.value = executable;
    await accept(setup.input, 'input');
    await pending;
    assert.deepEqual(value(), [custom, { id: 'codex', label: 'Codex', command: executable, args: [] }], 'saving preserves edits made while the input was open');
    assert.equal(workbench.conversations.configuration().count, 2);

    pending = vscode.commands.executeCommand('warden.configureAgents');
    await choose('opencode');
    await eventually(() => !!setup.input);
    const openCode = { id: 'opencode', label: 'OpenCode', command: setup.input.value, args: ['acp'] };
    assert.equal(openCode.command, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    await accept(setup.input, 'input');
    await pending;
    const configured = value();
    assert.deepEqual(configured.at(-1), openCode);
    assert.equal(configured.length, 3);

    pending = vscode.commands.executeCommand('warden.configureAgents');
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
    pending = vscode.commands.executeCommand('warden.configureAgents');
    await choose('opencode');
    await eventually(() => !!setup.input);
    const concurrent = { ...openCode, command: fixture.node, args: ['--custom'] };
    await configuration.update('acpAgents', [concurrent], vscode.ConfigurationTarget.Global);
    await accept(setup.input, 'input');
    await pending;
    assert.deepEqual(value(), [concurrent], 'a preset configured while the input was open is preserved');

    const invalid = [{ id: 'broken' }];
    await configuration.update('acpAgents', invalid, vscode.ConfigurationTarget.Global);
    assert.equal(workbench.conversations.configuration().status, 'invalid');
    await vscode.commands.executeCommand('warden.configureAgents');
    assert.equal(setup.picker, undefined, 'invalid settings go directly to repair');
    assert.deepEqual(value(), invalid, 'invalid settings are not replaced by presets');
    assert.equal(workbench.data.workflow, null, 'presets are configured before selecting a branch');
    assert.equal(workbench.conversations.entries.size, 0);
    await assert.rejects(fs.access(fixture.journal), 'adding presets never starts an agent');
  } finally {
    setup.picker?.hide();
    setup.input?.hide();
    await configuration.update('acpAgents', previous, vscode.ConfigurationTarget.Global);
  }
};
