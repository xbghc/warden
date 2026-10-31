const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

exports.checkPreviewLineEndings = async (workbench, root, eventually) => {
  const git = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const original = '@echo off\r\necho Original\r\n';
  await fs.writeFile(path.join(root, 'gradlew.bat'), original);
  git('-c', 'core.autocrlf=false', 'add', 'gradlew.bat');
  git('commit', '-qm', 'Keep a CRLF wrapper');
  await fs.writeFile(path.join(root, '.gitattributes'), 'gradlew.bat text=auto\n');
  git('add', '.gitattributes');
  git('commit', '-qm', 'Normalize new wrapper content');
  const head = git('rev-parse', 'HEAD');
  const index = await fs.readFile(path.join(root, '.git', 'index'));

  await vscode.commands.executeCommand('warden.refreshPreview');
  await eventually(() => workbench.preview?.syncStatus === 'synced');
  assert.deepEqual(workbench.preview.connectedIds, [], 'selecting a requirement can initialize a preview without tasks');
  const file = path.join(workbench.preview.worktree, 'gradlew.bat');
  assert.equal(await fs.readFile(file, 'utf8'), original, 'preview initialization preserves committed CRLF bytes');
  await fs.writeFile(file, '@echo off\r\necho Preview edit\r\n');
  await vscode.commands.executeCommand('warden.refreshPreview');
  await eventually(() => workbench.preview?.syncStatus === 'error');
  assert.match(workbench.status.text, /Sync Failed/);
  assert.match(workbench.sidebar.view.message, /Sync Failed/);
  assert.equal(workbench.contextValues.get('warden.previewNeedsSync'), true, 'a real sync failure exposes recovery in More Actions');
  const output = workbench.output;
  const execute = workbench.backend.execute;
  const lines = [];
  const commands = [];
  let shown = false;
  workbench.output = {
    appendLine: (line) => {
      lines.push(line);
      output.appendLine(line);
    },
    show: () => {
      shown = true;
      output.show(true);
    },
  };
  workbench.backend.execute = function (command, ...args) {
    commands.push(command);
    return execute.call(this, command, ...args);
  };
  try {
    await vscode.commands.executeCommand('warden.showPreview');
    assert(shown, 'the retained preview command opens native output');
    assert(lines.join('\n').includes(workbench.preview.worktree));
    assert.match(lines.join('\n'), /Sync Failed/);
    assert.equal(workbench.views.panels.has('preview'), false, 'preview diagnostics never open an editor page');
    assert(
      !commands.some((command) => ['preview.refresh', 'preview.setup', 'preview.connect'].includes(command)),
      'reading output cannot change preview files',
    );
  } finally {
    workbench.output = output;
    workbench.backend.execute = execute;
  }
  assert.match(await fs.readFile(file, 'utf8'), /Preview edit/, 'real preview edits are retained');
  await fs.writeFile(file, original);
  await vscode.commands.executeCommand('warden.refreshPreview');
  await eventually(() => workbench.preview?.syncStatus === 'synced');
  assert(!workbench.sidebar.view.message?.includes('Sync Failed'), 'successful sync clears the persistent preview failure');
  assert.equal(workbench.contextValues.get('warden.previewNeedsSync'), false, 'successful sync removes the recovery action');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), index);
  assert.equal(await fs.readFile(path.join(root, 'gradlew.bat'), 'utf8'), original);
};

exports.checkPreviewActions = async (workbench, extension, eventually) => {
  const menus = extension.packageJSON.contributes.menus;
  const overflow = menus['view/title'].filter((item) => !item.group?.startsWith('navigation'));
  assert.deepEqual(
    overflow.map((item) => item.command).sort(),
    ['warden.configureScripts', 'warden.previewTerminal', 'warden.refreshPreview', 'warden.runPreview', 'warden.selectRepository', 'warden.setup'],
    'More Actions contains execution, Settings, repository selection and conditional recovery',
  );
  assert.equal(
    overflow.find((item) => item.command === 'warden.refreshPreview').when,
    'warden.agentReady && view == warden.task && warden.hasDevelopmentBranch && warden.previewNeedsSync',
  );
  assert.equal(
    overflow.find((item) => item.command === 'warden.setup').when,
    'warden.agentReady && view == warden.task && warden.hasDevelopmentBranch && warden.hasPreviewSetup && warden.previewSetupFailed',
  );
  for (const name of ['previewTerminal', 'runPreview', 'previewPath', 'showPreview', 'refreshPreview', 'setup', 'configure'])
    assert.equal(menus.commandPalette.find((item) => item.command === `warden.${name}`).when, 'warden.agentReady', 'secondary commands remain discoverable');
  assert.equal(workbench.status.command, 'warden.showPreview', 'status-bar activation keeps the diagnostic entry point');

  const settings = vscode.workspace.getConfiguration('warden');
  const previous = settings.inspect('previewCommand').globalValue;
  const config = (await workbench.backend.execute('workflow.get')).workspaceConfig ?? { hooks: {} };
  try {
    for (const command of ['', 'echo preview', '   ']) {
      await settings.update('previewCommand', command, vscode.ConfigurationTarget.Global);
      await eventually(() => workbench.contextValues.get('warden.hasPreviewCommand') === !!command.trim());
    }
    const refresh = workbench.refresh;
    const preview = workbench.preview;
    // Hold background reads while exercising the native menu's failure-state transitions.
    workbench.refresh = async () => {};
    try {
      for (const syncStatus of ['pending', 'updating', 'synced', 'stale', 'conflict', 'error', 'paused', 'synced']) {
        workbench.preview = { ...preview, syncStatus };
        await workbench.updateContext();
        assert.equal(workbench.contextValues.get('warden.previewNeedsSync'), ['stale', 'conflict', 'error', 'paused'].includes(syncStatus));
        await vscode.commands.executeCommand('notifications.clearAll');
        assert.equal(workbench.contextValues.get('warden.previewNeedsSync'), ['stale', 'conflict', 'error', 'paused'].includes(syncStatus));
      }
    } finally {
      workbench.refresh = refresh;
      workbench.preview = preview;
      await workbench.updateContext();
    }
    await workbench.backend.execute('config.save', { ...config, previewSetup: 'exit 7' });
    await workbench.refresh(true);
    const row = workbench.settings
      .getChildren()
      .find((item) => item.id === 'scripts')
      .children.find((item) => item.id === 'script:preview');
    await vscode.commands.executeCommand('warden.setup', row);
    await eventually(() => workbench.contextValues.get('warden.previewSetupFailed') === true);
    assert.equal(workbench.contextValues.get('warden.hasPreviewSetup'), true);
    assert.match(workbench.sidebar.view.message, /Preview setup failed/);
    await vscode.commands.executeCommand('notifications.clearAll');
    assert.equal(workbench.contextValues.get('warden.previewSetupFailed'), true, 'dismissing notifications does not hide recovery');
    await workbench.backend.execute('config.save', { ...config, previewSetup: 'echo recovered' });
    await workbench.refresh(true);
    await vscode.commands.executeCommand('warden.setup', row);
    await eventually(() => workbench.preview.setup?.status === 'succeeded');
    assert.equal(workbench.contextValues.get('warden.previewSetupFailed'), false);
    const execute = workbench.backend.execute;
    let reruns = 0;
    workbench.backend.execute = function (command, ...args) {
      if (command === 'preview.setup') ++reruns;
      return execute.call(this, command, ...args);
    };
    try {
      await vscode.commands.executeCommand('warden.setup', row);
      assert.equal(reruns, 1, 'the Settings row still reruns a successful setup');
    } finally {
      workbench.backend.execute = execute;
    }
    await workbench.backend.execute('config.save', { ...config, previewSetup: undefined });
    await workbench.refresh(true);
    assert.equal(workbench.contextValues.get('warden.hasPreviewSetup'), false, 'removing a script hides its rerun action');
  } finally {
    await settings.update('previewCommand', previous, vscode.ConfigurationTarget.Global);
    await workbench.backend.execute('config.save', config);
    await workbench.refresh(true);
  }
};

exports.checkPreviewTerminals = async (workbench, fixture, eventually) => {
  const repository = workbench.backend.root;
  const original = new Set(vscode.window.terminals);
  const matching = () => vscode.window.terminals.filter((terminal) => terminal.creationOptions.env?.WARDEN_REPO === workbench.backend.root);
  try {
    const preview = await workbench.ensurePreview();
    const foreign = vscode.window.createTerminal({
      name: 'Warden · Preview',
      cwd: preview.worktree,
      env: { WARDEN_REPO: fixture.unconfigured, WARDEN_PREVIEW: preview.worktree },
    });
    await vscode.commands.executeCommand('warden.previewTerminal');
    assert.equal(matching().length, 1, 'a same-name terminal for another repository is not reused');
    const terminal = matching()[0];
    assert.equal(terminal.creationOptions.cwd, preview.worktree);
    assert.equal(terminal.creationOptions.env.WARDEN_PREVIEW, preview.worktree);
    await vscode.commands.executeCommand('warden.previewTerminal');
    assert.deepEqual(matching(), [terminal], 'repeated opens reuse the live preview terminal');
    terminal.dispose();
    await eventually(() => !vscode.window.terminals.includes(terminal));
    await vscode.commands.executeCommand('warden.previewTerminal');
    assert.equal(matching().length, 1);
    const replacement = matching()[0];
    assert.notEqual(replacement, terminal, 'closing a terminal allows a new one');
    await workbench.open(fixture.unconfigured);
    await eventually(() => workbench.agentReady);
    await vscode.commands.executeCommand('warden.previewTerminal');
    const other = matching().filter((item) => item !== foreign);
    assert.equal(other.length, 1, 'another preview path gets its own terminal even with the same repository marker');
    assert.equal(other[0].creationOptions.cwd, workbench.preview.worktree);
    assert.notEqual(other[0], replacement);
    await workbench.open(repository);
    await eventually(() => workbench.agentReady);
    await vscode.commands.executeCommand('warden.previewTerminal');
    assert.deepEqual(matching(), [replacement], 'returning to a repository reuses its retained terminal');
  } finally {
    for (const terminal of vscode.window.terminals) if (!original.has(terminal)) terminal.dispose();
    await eventually(() => vscode.window.terminals.every((terminal) => original.has(terminal)));
    if (workbench.backend.root !== repository) await workbench.open(repository);
  }
};
