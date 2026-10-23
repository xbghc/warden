const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');

exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const extension = vscode.extensions.getExtension('xbghc.warden');
  assert(extension, 'extension is installed');
  const workbench = await extension.activate();
  try {
    const tasks = await workbench.getChildren({ kind: 'tasks' });
    assert.equal(tasks.length, 1);
    await vscode.commands.executeCommand('warden.connect', tasks[0]);
    const state = () => fs.readFile(fixture.state, 'utf8').then(JSON.parse);
    let preview = (await state()).connectionPreview;
    assert.notEqual(preview.worktree, fixture.root);
    assert.equal(await fs.readFile(path.join(preview.worktree, 'agent.txt'), 'utf8'), 'Agent addition\n');
    await assert.rejects(fs.access(path.join(fixture.root, 'agent.txt')));
    const files = await workbench.getChildren(tasks[0]);
    assert.equal(files.length, 1);
    await vscode.commands.executeCommand('warden.openDiff', files[0]);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const diff = tabs.find((tab) => tab.input instanceof vscode.TabInputTextDiff);
    assert(diff, 'native diff tab is open');
    assert.equal(diff.input.original.scheme, 'warden-review');
    assert.equal(diff.input.modified.scheme, 'warden-review');
    const doc = await vscode.workspace.openTextDocument(diff.input.modified);
    assert.equal(doc.getText(), 'Agent addition\n');
    await vscode.commands.executeCommand('type', { text: 'Forbidden' });
    assert.equal(doc.getText(), 'Agent addition\n', 'native typing cannot edit review content');
    await assert.rejects(vscode.workspace.fs.writeFile(doc.uri, Buffer.from('Forbidden')), 'review documents cannot be saved');
    assert.equal((await vscode.commands.getCommands(true)).includes('warden.markViewed'), false);
    assert.equal('viewed' in files[0].file, false);
    const workspace = tasks[0].task.worktree;
    const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
    git('add', 'agent.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Reviewed version');
    await assert.rejects(workbench.deliver(tasks[0]), /重新打开/, 'committing a live diff requires reopening the committed version');
    await workbench.refresh();
    let currentFiles = await workbench.getChildren(tasks[0]);
    await workbench.openDiff(currentFiles[0]);
    const pinned = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.input instanceof vscode.TabInputTextDiff);
    const pinnedDoc = await vscode.workspace.openTextDocument(pinned.input.modified);
    await fs.writeFile(path.join(workspace, 'later.txt'), 'Unreviewed addition\n');
    git('add', 'later.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Later version');
    await workbench.refresh();
    assert.equal(pinnedDoc.getText(), 'Agent addition\n', 'open documents stay immutable');
    await assert.rejects(workbench.deliver(tasks[0]), /重新打开/, 'background refresh cannot authorize a newer source');
    assert.equal((await state()).workflow.changes[0].integration, undefined, 'stale delivery never stages primary');
    currentFiles = await workbench.getChildren(tasks[0]);
    await workbench.openDiff(currentFiles.find((file) => file.file.path === 'later.txt'));
    assert(
      !vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === pinned.input.modified.toString()),
      'opening a newer version closes older task comparisons',
    );
    assert.equal(workbench.reviews.get(tasks[0].task.id).sourceHead, git('rev-parse', 'HEAD'));
    execFileSync('git', [
      '-C',
      fixture.root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'Primary advanced',
    ]);
    await assert.rejects(workbench.deliver(tasks[0]), /重新打开/, 'a changed primary baseline also needs renewed review');
    await fs.writeFile(path.join(fixture.root, 'human.txt'), 'Human code\n');
    await vscode.commands.executeCommand('warden.refreshPreview');
    preview = (await state()).connectionPreview;
    assert.equal(await fs.readFile(path.join(preview.worktree, 'human.txt'), 'utf8'), 'Human code\n');
    await vscode.commands.executeCommand('warden.previewTerminal');
    const terminal = vscode.window.terminals.find((t) => t.name === 'Warden · 预览');
    assert(terminal, 'preview terminal exists');
    assert.equal(terminal.creationOptions.cwd, preview.worktree);
    terminal.dispose();
    await vscode.commands.executeCommand('warden.setup');
    assert.equal((await state()).connectionPreview.setup.status, 'succeeded');
    await vscode.commands.executeCommand('warden.connect', tasks[0]);
    assert.equal((await state()).connectionPreview.connectedIds.length, 0);
    assert.equal(await fs.readFile(path.join(fixture.root, 'human.txt'), 'utf8'), 'Human code\n');
    console.log(
      'Warden extension host: native diff, pinned source/baseline, stale-delivery rejection, readonly review, preview isolation, setup and terminal passed',
    );
  } finally {
    await workbench.close();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};
