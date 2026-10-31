const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

async function screenshot(mode) {
  const destination = process.env.WARDEN_VSCODE_SCREENSHOT;
  if (!destination || process.platform !== 'linux') return;
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', destination.replace(/\.png$/, `-${mode}.png`)]);
}

exports.checkFileViews = async (workbench, extension, workspace, eventually) => {
  const sidebar = workbench.sidebar;
  const mode = sidebar.fileViewMode;
  const root = workspace.task.worktree;
  const paths = ['src/alpha/shared.txt', 'src/beta/shared.txt', 'src/item10.txt', 'src/item2.txt', 'src-other/change.txt', 'root.txt'];
  const contributions = extension.packageJSON.contributes;
  for (const [command, current, icon] of [
    ['warden.viewAsTree', 'list', '$(list-tree)'],
    ['warden.viewAsList', 'tree', '$(list-flat)'],
  ]) {
    const menu = contributions.menus['view/title'].find((item) => item.command === command);
    assert(menu.when.includes(`warden.fileViewMode == ${current}`), 'the title action switches to the other layout');
    assert(menu.when.includes('warden.agentReady') && menu.when.includes('view == warden.task'));
    assert(menu.group.startsWith('navigation@'));
    assert.equal(contributions.commands.find((item) => item.command === command).icon, icon);
  }
  try {
    for (const file of paths) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), `Change in ${file}\n`);
    }
    await workbench.refresh(true);
    await vscode.commands.executeCommand('warden.viewAsList');
    assert.equal(workbench.contextValues.get('warden.fileViewMode'), 'list');
    const list = await sidebar.getChildren(workspace);
    assert.deepEqual(list.map((node) => node.file.path).sort(), [...paths].sort());
    const selected = list.find((node) => node.file.path === paths[0]);
    const listItem = sidebar.getTreeItem(selected);
    assert.equal(listItem.label, 'shared.txt');
    assert.match(listItem.description, /^src\/alpha · \+1 −0/);
    assert(listItem.tooltip.startsWith(paths[0]));
    assert.equal(sidebar.getParent(selected).kind, 'task');
    await vscode.commands.executeCommand('warden.openDiff', selected);
    const diff = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.input instanceof vscode.TabInputTextDiff);
    assert(diff, 'a file from the flat list opens its native diff');
    const review = workbench.reviews.get(workspace.task.id);
    await sidebar.view.reveal(selected, { select: true, focus: true });
    await screenshot('list');

    await vscode.commands.executeCommand('warden.viewAsTree');
    assert.equal(workbench.context.workspaceState.get('warden.fileViewMode'), 'tree', 'the chosen layout is persisted');
    assert.equal(workbench.contextValues.get('warden.fileViewMode'), 'tree');
    assert.equal(workbench.expanded[workspace.task.id], true, 'changing the layout preserves task expansion');
    assert.equal(workbench.reviews.get(workspace.task.id), review, 'changing layout does not advance the pinned review');
    assert(vscode.window.tabGroups.all.flatMap((group) => group.tabs).includes(diff), 'changing layout preserves the open diff');
    const tree = await sidebar.getChildren(workspace);
    assert.deepEqual(
      tree.map((node) => sidebar.getTreeItem(node).label),
      ['src', 'src-other', 'root.txt'],
    );
    assert.deepEqual(
      tree.map((node) => node.kind),
      ['folder', 'folder', 'file'],
    );
    assert.equal(sidebar.getParent(tree[0]).task.id, workspace.task.id);
    assert.equal(sidebar.getTreeItem(tree[0]).command, undefined, 'directories expand without opening a diff');
    const execute = workbench.backend.execute;
    const reads = [];
    workbench.backend.execute = function (command, ...args) {
      reads.push(command);
      return execute.call(this, command, ...args);
    };
    let src;
    let nested;
    try {
      src = await sidebar.getChildren(tree[0]);
      assert.deepEqual(
        src.map((node) => sidebar.getTreeItem(node).label),
        ['alpha', 'beta', 'item2.txt', 'item10.txt'],
      );
      nested = await sidebar.getChildren(src[0]);
      assert.equal(nested.length, 1);
      assert.deepEqual(nested[0], selected, 'directory grouping preserves the complete file and review target');
      assert.equal((await sidebar.getChildren(tree[1]))[0].file.path, 'src-other/change.txt', 'directory boundaries do not match path prefixes');
      assert.deepEqual(reads, [], 'expanding directories reuses the loaded comparison without additional Git reads');
    } finally {
      workbench.backend.execute = execute;
    }
    assert.equal(sidebar.getParent(nested[0]).path, 'src/alpha');
    assert.equal(sidebar.getParent(src[0]).path, 'src');
    const treeItem = sidebar.getTreeItem(nested[0]);
    assert.equal(treeItem.id, listItem.id, 'file identities are stable across layouts');
    assert.equal(treeItem.label, listItem.label);
    assert.equal(treeItem.description, listItem.description.replace('src/alpha · ', ''), 'tree rows keep metadata without repeating the parent path');
    await sidebar.view.reveal(nested[0], { select: true, focus: true });
    await eventually(() => sidebar.view.selection[0]?.file?.path === paths[0]);
    await vscode.commands.executeCommand(treeItem.command.command, ...treeItem.command.arguments);
    const document = await vscode.workspace.openTextDocument(vscode.window.activeTextEditor.document.uri);
    assert.equal(document.getText().replace(/\r\n/g, '\n'), `Change in ${paths[0]}\n`);
    await sidebar.view.reveal(nested[0], { select: true, focus: true });
    await screenshot('tree');

    await fs.rm(path.join(root, paths[0]));
    await workbench.refresh(true);
    const updated = await sidebar.getChildren(workspace);
    const updatedSrc = await sidebar.getChildren(updated.find((node) => node.path === 'src'));
    assert(!updatedSrc.some((node) => node.path === 'src/alpha'), 'refresh removes empty directories');
    assert.deepEqual(await sidebar.getChildren(src[0]), [], 'old directory nodes cannot retain removed files');
    await vscode.commands.executeCommand('warden.viewAsList');
    assert.equal(workbench.context.workspaceState.get('warden.fileViewMode'), 'list');
    const flat = await sidebar.getChildren(workspace);
    assert.deepEqual(flat.map((node) => node.file.path).sort(), paths.slice(1).sort());
    assert.deepEqual(await sidebar.getChildren(tree[0]), [], 'directory nodes disappear in list view');
    assert.deepEqual(await sidebar.getChildren({ ...tree[0], session: 'previous-session' }), [], 'stale directories cannot expose another session');
  } finally {
    await vscode.commands.executeCommand(mode === 'tree' ? 'warden.viewAsTree' : 'warden.viewAsList');
    for (const entry of ['src', 'src-other', 'root.txt']) await fs.rm(path.join(root, entry), { recursive: true, force: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await workbench.refresh(true);
    await sidebar.view.reveal(workspace, { select: true, focus: true });
  }
};
