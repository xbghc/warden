const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');
const { checkReviewRaces } = require('./review-race.cjs');

const eventually = async (condition) => {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the native tree');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const workbench = await vscode.extensions.getExtension('xbghc.warden').activate();
  const Sidebar = workbench.sidebar.constructor;
  await checkReviewRaces(workbench);
  await workbench.close();
  const task = (id) => ({ id, title: id, branch: id, developmentBranch: id, worktree: `${fixture.root}-${id}`, base: 'base', status: 'working' });
  const oldTask = task('old-branch');
  const newTask = task('new-branch');
  const model = (task) => ({
    repository: fixture.root,
    session: task.id,
    repositoryState: 'ready',
    surface: 'workspaces',
    agentConfiguration: { status: 'configured', count: 1 },
    agentReadiness: { status: 'ready' },
    workflow: { workflow: { developmentBranch: task.id, changes: [task] } },
    workspaces: [{ task, expanded: true }],
    task,
    errors: [],
  });
  let current = model(oldTask);
  let held;
  let waiting = false;
  let release;
  const errors = [];
  const reads = new Map();
  const sidebar = new Sidebar(
    () => current,
    async (node) => {
      if (!node) return current.workspaces.map(({ task }) => ({ kind: 'task', task }));
      if (node.kind !== 'task') return [];
      reads.set(node.task.id, (reads.get(node.task.id) ?? 0) + 1);
      if (node.task.id === newTask.id && held) {
        waiting = true;
        await held;
      }
      return [{ kind: 'file', task: node.task, target: 'all', file: { path: 'folder/file.txt', status: 'modified', additions: 1, deletions: 0 } }];
    },
    async () => {},
    async () => {},
    workbench.context.workspaceState,
    (error) => errors.push(error),
  );
  try {
    await vscode.commands.executeCommand('setContext', 'warden.agentReady', true);
    await vscode.commands.executeCommand('setContext', 'warden.hasDevelopmentBranch', true);
    await vscode.commands.executeCommand('setContext', 'warden.repositoryState', 'ready');
    await vscode.commands.executeCommand('warden.task.focus');
    await eventually(() => sidebar.view.visible);
    sidebar.refresh();
    const oldNode = (await sidebar.getChildren())[0];
    await sidebar.view.reveal(oldNode, { select: true, focus: true, expand: true });
    await eventually(() => !sidebar.restoring && !sidebar.pendingExpansion);
    assert.equal(sidebar.view.selection[0]?.task.id, oldTask.id);

    held = new Promise((resolve) => {
      release = resolve;
    });
    current = model(newTask);
    sidebar.refresh();
    await eventually(() => waiting);
    // This key participates in the native item menu. While a descendant read waits,
    // VS Code must not try to rerender a root that its data model already removed.
    await vscode.commands.executeCommand('setContext', 'warden.hasPreviewSetup', true);
    await vscode.commands.executeCommand('setContext', 'warden.hasPreviewSetup', false);
    release();
    held = undefined;
    const newNode = (await sidebar.getChildren())[0];
    await sidebar.view.reveal(newNode, { select: true, focus: true, expand: true });
    await eventually(() => !sidebar.restoring && !sidebar.pendingExpansion);
    assert.equal(sidebar.view.selection[0]?.task.id, newTask.id);
    assert.equal(sidebar.getTreeItem(newNode).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    await sidebar.setFileViewMode('tree');
    await sidebar.view.reveal((await sidebar.getChildren())[0], { expand: true });
    const folders = await sidebar.getChildren((await sidebar.getChildren())[0]);
    assert.equal(folders[0].kind, 'folder');

    // Do not reopen a hidden sidebar merely to restore a different branch's expansion.
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await eventually(() => !sidebar.view.visible);
    const hidden = task('hidden-branch');
    current = model(hidden);
    sidebar.refresh();
    await vscode.commands.executeCommand('setContext', 'warden.hasPreviewSetup', true);
    assert.equal(sidebar.view.visible, false);
    assert.equal(sidebar.restoring, undefined);
    assert.equal(reads.get(hidden.id), undefined);
    await vscode.commands.executeCommand('warden.task.focus');
    await eventually(() => reads.has(hidden.id) && !sidebar.restoring && !sidebar.pendingExpansion);
    assert.equal(sidebar.getTreeItem((await sidebar.getChildren())[0]).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

    // A replaced restore must not expand or select an obsolete branch after its read finishes.
    waiting = false;
    held = new Promise((resolve) => {
      release = resolve;
    });
    current = model(newTask);
    sidebar.refresh();
    await eventually(() => waiting);
    const latest = task('latest-branch');
    current = model(latest);
    sidebar.refresh();
    await vscode.commands.executeCommand('setContext', 'warden.hasPreviewSetup', false);
    release();
    held = undefined;
    await eventually(() => reads.has(latest.id) && !sidebar.restoring && !sidebar.pendingExpansion);
    assert.deepEqual(await sidebar.getChildren(newNode), []);
    const latestNode = (await sidebar.getChildren())[0];
    assert.equal(latestNode.task.id, latest.id);
    assert.equal(sidebar.getTreeItem(latestNode).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.deepEqual(errors, []);
    console.log('Native tree replacement completed while menu context changed during a held child read');
  } finally {
    release?.();
    sidebar.dispose();
  }
};
