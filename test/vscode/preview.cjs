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
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), index);
  assert.equal(await fs.readFile(path.join(root, 'gradlew.bat'), 'utf8'), original);
};
