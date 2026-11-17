const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { openWork } = require('./work-folder.cjs');

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
  await eventually(() => workbench.preview?.syncStatus === 'synced');
  assert.match(await fs.readFile(file, 'utf8'), /Preview edit/, 'an edit in the work folder survives a sync');
  // A folder that is no longer primary's worktree cannot be updated.
  const gitfile = path.join(workbench.preview.worktree, '.git');
  await fs.rename(gitfile, `${gitfile}.away`);
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
  assert.match(await fs.readFile(file, 'utf8'), /Preview edit/, 'a failed sync leaves the edit alone');
  await fs.rename(`${gitfile}.away`, gitfile);
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
    ['warden.configureScripts', 'warden.pullBase', 'warden.refreshPreview', 'warden.runPreview', 'warden.selectRepository', 'warden.setup'],
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
  for (const name of ['openWorkFolder', 'pullBase', 'runPreview', 'previewPath', 'showPreview', 'refreshPreview', 'setup', 'configure'])
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
      for (const syncStatus of ['pending', 'updating', 'synced', 'stale', 'conflict', 'error', 'synced']) {
        workbench.preview = { ...preview, syncStatus };
        await workbench.updateContext();
        assert.equal(workbench.contextValues.get('warden.previewNeedsSync'), ['stale', 'conflict', 'error'].includes(syncStatus));
        await vscode.commands.executeCommand('notifications.clearAll');
        assert.equal(workbench.contextValues.get('warden.previewNeedsSync'), ['stale', 'conflict', 'error'].includes(syncStatus));
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
    assert.match(workbench.sidebar.view.message, /Work folder setup failed/);
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

exports.checkWorkFolderEntry = async (workbench, eventually) => {
  const repository = workbench.backend.root;
  const folder = `${repository}-work`;
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  try {
    // A window on primary leads to the work folder and offers nothing else.
    await workbench.open(repository);
    await eventually(() => workbench.agentReady);
    assert.equal(workbench.contextValues.get('warden.primaryEntry'), true);
    assert.equal(workbench.contextValues.get('warden.workFolderEntry'), false);
    assert.equal(workbench.contextValues.get('warden.hasDevelopmentBranch'), false, 'primary exposes no workbench actions');
    assert.deepEqual(await workbench.getChildren(), [], 'primary lists no tasks');
    assert.equal(await vscode.commands.executeCommand('warden.previewPath'), folder, 'primary can still locate the work folder');
    await openWork(workbench, repository);
    await eventually(() => workbench.agentReady);
    assert.equal(workbench.contextValues.get('warden.primaryEntry'), false);
    assert.equal(workbench.contextValues.get('warden.workFolderEntry'), true);
    assert.equal(workbench.contextValues.get('warden.hasDevelopmentBranch'), true);
    assert.notEqual((await workbench.getChildren()).length, 0, 'the work folder window lists tasks');

    // The user's own edit is committed to the base branch from the work folder.
    await vscode.commands.executeCommand('warden.refreshPreview');
    await eventually(() => workbench.preview?.syncStatus === 'synced');
    const before = git('rev-parse', 'HEAD');
    await workbench.commitWorkFolder('Nothing to commit');
    assert.equal(git('rev-parse', 'HEAD'), before, 'a folder without edits commits nothing');
    await fs.writeFile(path.join(folder, 'own-edit.txt'), 'Own edit\n');
    await workbench.commitWorkFolder('   ');
    assert.equal(git('rev-parse', 'HEAD'), before, 'an empty message commits nothing');
    await workbench.commitWorkFolder('Commit own edit');
    assert.equal(git('log', '-1', '--format=%s'), 'Commit own edit');
    assert.equal(git('rev-parse', 'HEAD~1'), before);
    assert.equal(git('show', 'HEAD:own-edit.txt'), 'Own edit');
    assert.equal(git('status', '--porcelain'), '', 'primary is clean after the commit');
    assert.equal(await fs.readFile(path.join(folder, 'own-edit.txt'), 'utf8'), 'Own edit\n');
    assert.deepEqual((await workbench.backend.execute('workfolder.changes')).files, [], 'committed edits are no longer changes of the work folder');

    const started = new Promise((resolve) => {
      const subscription = vscode.tasks.onDidStartTask((event) => {
        if (event.execution.task.name !== `Pull ${workbench.branch}`) return;
        subscription.dispose();
        resolve(event.execution);
      });
    });
    await vscode.commands.executeCommand('warden.pullBase');
    const execution = await started;
    assert.equal(execution.task.execution.process, 'git');
    assert.deepEqual(execution.task.execution.args, ['pull', '--ff-only']);
    assert.equal(execution.task.execution.options.cwd, repository, 'the pull runs in primary');
    execution.terminate();
  } finally {
    if (!workbench.workFolderEntry) await openWork(workbench, repository);
  }
};
