const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

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
    console.log('Warden extension host: native diff, readonly review, preview isolation, setup and terminal passed');
  } finally {
    await workbench.close();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};
