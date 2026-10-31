const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { checkAgentSetup, checkAgentPresets, verifyAgent } = require('./agent-setup.cjs');

exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const extension = vscode.extensions.getExtension('xbghc.warden');
  const workbench = await extension.activate();
  const eventually = async (condition) => {
    const deadline = Date.now() + 30_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for native Settings');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    await verifyAgent(workbench, fixture);
    await workbench.open(fixture.unconfigured);
    await checkAgentSetup(workbench, extension, fixture, eventually);
    await checkAgentPresets(workbench, fixture, eventually);
    await verifyAgent(workbench, fixture);
    await exports.checkSettings(workbench, extension, fixture, eventually);
    console.log(
      'Native Settings passed: stacked views, shared navigation, ACP setup/recovery, multiline scripts, legacy preservation and stale-save rejection',
    );
  } finally {
    await workbench.close();
  }
};

exports.checkSettings = async (workbench, extension, fixture, eventually) => {
  const views = extension.packageJSON.contributes.views.warden;
  assert.deepEqual(
    views.map((view) => view.id),
    ['warden.task', 'warden.settings'],
    'native views stack in the same sidebar container',
  );
  assert(views.every((view) => view.type !== 'webview'));
  assert.equal(views[1].visibility, 'visible', 'Settings initially appears beneath Workbench and can be collapsed independently');
  assert.equal(views[1].when, 'workspaceFolderCount > 0');
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  await vscode.commands.executeCommand('warden.configureScripts');
  await vscode.commands.executeCommand('warden.configureAgents');
  await workbench.views.show('settings');
  await eventually(() => workbench.settings.view.visible);
  assert(!tabs().some((tab) => tab.label === 'Warden · Settings'), 'settings entry points never open an editor webview');
  assert.equal(workbench.agentSetup.picker, undefined, 'revealing Settings never selects a preset or connects an agent');
  const config = () => workbench.backend.execute('workflow.get').then((state) => state.workspaceConfig);
  const original = await config();
  const repository = workbench.backend.root;
  const session = workbench.session;
  const text = (document) => document.getText().replace(/\r\n/g, '\n');
  const replace = async (document, value) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), value);
    assert(await vscode.workspace.applyEdit(edit));
  };
  const open = async (kind) => {
    await vscode.commands.executeCommand('warden.editSetupScript', kind, workbench.session);
    const document = vscode.window.activeTextEditor.document;
    assert.equal(document.uri.scheme, 'warden-script');
    return document;
  };
  const revert = async (document) => {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  };
  const initial = { hooks: { create: 'echo original', reuse: 'echo legacy' }, previewSetup: 'echo preview' };
  const marker = path.join(repository, 'script-must-not-run');
  try {
    await workbench.backend.execute('config.save', initial);
    await workbench.refresh(true);
    const roots = workbench.settings.getChildren();
    assert.deepEqual(
      roots.map((node) => node.id),
      ['acp', 'scripts'],
    );
    const scripts = workbench.settings.getChildren(roots[1]);
    assert.deepEqual(
      scripts.map((node) => node.label),
      ['Workspace Setup Script', 'Legacy Workspace Reuse Script', 'Preview Setup Script', 'Preview Command'],
    );
    assert.equal(scripts[0].command.arguments[1], session, 'script rows capture their repository session');
    assert.equal(scripts[2].contextValue, 'wardenPreviewSetup');
    assert.equal(scripts[2].session, session, 'the rerun action captures its repository session');
    const rerun = extension.packageJSON.contributes.menus['view/item/context'].find((item) => item.command === 'warden.setup');
    assert.equal(
      rerun.when,
      'warden.agentReady && view == warden.settings && viewItem == wardenPreviewSetup && warden.hasDevelopmentBranch && warden.hasPreviewSetup',
    );
    assert(rerun.group.startsWith('inline'), 'configured setup has an explicit row action even after success');
    if (process.env.WARDEN_VSCODE_AGENT_SETUP_SCREENSHOTS && process.platform === 'linux') {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('notifications.clearAll');
      await workbench.settings.show();
      await new Promise((resolve) => setTimeout(resolve, 500));
      execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', `${process.env.WARDEN_VSCODE_AGENT_SETUP_SCREENSHOTS}/scripts.png`]);
    }
    const document = await open('workspace');
    assert.equal(text(document), initial.hooks.create);
    const value = 'echo workspace-ready\nprintf "second line\\n" > script-must-not-run';
    await replace(document, value);
    assert(document.isDirty);
    assert.equal(await open('workspace'), document, 'reopening retains one native editor and its draft');
    assert.equal(text(document), value);
    assert.deepEqual(await config(), initial, 'typing cannot change saved configuration');
    assert(await document.save(), 'native Save persists multiline configuration');
    assert.equal((await config()).hooks.create.replace(/\r\n/g, '\n'), value);
    assert.equal((await config()).hooks.reuse, initial.hooks.reuse, 'saving preserves a distinct legacy reuse script');
    await assert.rejects(fs.access(marker), 'saving script configuration does not execute it');

    const preview = await open('preview');
    const reuse = await open('reuse');
    await replace(reuse, 'echo updated-legacy');
    assert(await reuse.save());
    await replace(preview, 'echo preview-ready\necho second-line');
    assert(await preview.save(), 'an unrelated script save does not overwrite newer configuration');
    assert.equal((await config()).hooks.reuse, 'echo updated-legacy');
    assert.equal((await config()).previewSetup.replace(/\r\n/g, '\n'), 'echo preview-ready\necho second-line');

    await replace(document, 'keep my unsaved draft');
    const changed = { ...(await config()), hooks: { create: 'echo changed-elsewhere', reuse: 'echo updated-legacy' } };
    await workbench.backend.execute('config.save', changed);
    await workbench.refresh(true);
    await assert.rejects(workbench.scriptSettings.writeFile(document.uri, Buffer.from(text(document))), /changed since it was opened/);
    assert.equal(text(document), 'keep my unsaved draft', 'a conflicting save preserves the native draft');
    assert.equal((await config()).hooks.create, 'echo changed-elsewhere');
    await revert(document);
    await open('workspace');
    await eventually(() => text(document) === 'echo changed-elsewhere');

    await workbench.open(fixture.root);
    const other = await config();
    await assert.rejects(workbench.scriptSettings.writeFile(document.uri, Buffer.from('wrong repository')), /repository or base branch changed/);
    await assert.rejects(workbench.scriptSettings.open('workspace', session), /repository or base branch changed/);
    assert.deepEqual(await config(), other, 'stale editors cannot change the next repository');
    const execute = workbench.backend.execute;
    let reran = false;
    workbench.backend.execute = function (command, ...args) {
      if (command === 'preview.setup') reran = true;
      return execute.call(this, command, ...args);
    };
    try {
      await vscode.commands.executeCommand('warden.setup', scripts[2]);
      assert.equal(reran, false, 'a stale Settings row cannot run setup in the next repository');
      assert.match(workbench.errors.get('settings').message, /repository or base branch changed/);
    } finally {
      workbench.backend.execute = execute;
    }
    await workbench.open(repository);
    const cleared = await open('preview');
    await replace(cleared, '');
    assert(await cleared.save());
    assert.equal((await config()).previewSetup, undefined, 'clearing and saving disables the script');
    const workspace = await open('workspace');
    await replace(workspace, '');
    assert(await workspace.save());
    assert.equal((await config()).hooks.create, undefined);
    assert.equal((await config()).hooks.reuse, 'echo updated-legacy');
    assert.equal(text(await open('workspace')), '', 'a cleared workspace script does not fall back to the separate legacy script');
  } finally {
    if (workbench.backend.root !== repository) await workbench.open(repository);
    await workbench.backend.execute('config.save', original ?? { hooks: {} });
    workbench.errors.delete('settings');
    await workbench.refresh(true);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};
