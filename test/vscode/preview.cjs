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
  assert.match(await fs.readFile(file, 'utf8'), /Preview edit/, 'real preview edits are retained');
  await fs.writeFile(file, original);
  await vscode.commands.executeCommand('warden.refreshPreview');
  await eventually(() => workbench.preview?.syncStatus === 'synced');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), index);
  assert.equal(await fs.readFile(path.join(root, 'gradlew.bat'), 'utf8'), original);
};
