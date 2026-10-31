const assert = require('node:assert/strict');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');

exports.checkSidebar = async (workbench, extension, repository, eventually) => {
  const contributions = extension.packageJSON.contributes;
  assert.notEqual(contributions.views.warden[0].type, 'webview', 'workspace navigation uses a native tree');
  assert.equal(workbench.sidebar.view.title, 'Workbench');
  assert(contributions.viewsWelcome.some((row) => row.when.includes('!warden.hasDevelopmentBranch')));
  assert(contributions.menus['view/item/context'].some((row) => row.command === 'warden.deliver'));
  assert(!contributions.menus['view/item/context'].some((row) => row.command === 'warden.taskOptions'), 'allocation details are not task actions');
  assert(contributions.menus.commandPalette.some((row) => row.command === 'warden.startTask' && row.when === 'false'));
  assert(contributions.menus['view/item/context'].find((row) => row.command === 'warden.startTask').when.includes('allocationFailed'));
  await vscode.commands.executeCommand('warden.task.focus');
  await eventually(() => workbench.sidebar.view.visible);
  const root = await workbench.sidebar.getChildren();
  assert.deepEqual(
    root.map((node) => node.kind),
    ['preview', 'tasks'],
  );
  assert.equal((await vscode.commands.getCommands(true)).includes('warden.editHistory'), false, 'history arrangement has no command entry');
  await assert.rejects(workbench.views.show('history'), /Unknown view/, 'retired history views cannot be opened');
  const execute = workbench.backend.execute;
  const observed = [];
  workbench.backend.execute = function (command, ...args) {
    observed.push(command);
    return execute.call(this, command, ...args);
  };
  try {
    await workbench.refresh(true);
  } finally {
    workbench.backend.execute = execute;
  }
  assert(!observed.some((command) => command.startsWith('history.')), 'refresh does not load or rewrite history');
  const taskRoot = root.find((node) => node.kind === 'tasks');
  const session = workbench.session;
  const count = workbench.tasks().length;
  const cancel = vscode.commands.executeCommand('warden.createTask');
  await eventually(() => !!workbench.taskInput);
  workbench.taskInput.value = 'Native task draft';
  workbench.taskInput.hide();
  await cancel;
  assert.equal(workbench.tasks().length, count, 'cancellation leaves Git and the plan untouched');
  assert.equal(workbench.views.panels.has('task'), false, 'native creation does not open a webview');

  const create = vscode.commands.executeCommand('warden.createTask');
  await eventually(() => !!workbench.taskInput);
  assert.equal(workbench.taskInput.value, 'Native task draft', 'cancelled input is restored');
  workbench.taskInput.value = '   ';
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  assert(workbench.taskInput, 'blank titles keep the input open');
  workbench.taskInput.value = 'Native first task';
  await eventually(async () => {
    if (!workbench.taskInput) return true;
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    return !workbench.taskInput;
  });
  await create;
  assert.equal(workbench.tasks().length, count + 1, 'native input creates exactly one task');
  const firstId = workbench.tasks().at(-1).id;
  const firstWorkspace = workbench.tasks().at(-1).worktree;
  assert(firstWorkspace, 'native task creation automatically allocates its workspace');
  const draftKey = `warden.newTask:${workbench.backend.root}:${workbench.branch}`;
  assert.equal(workbench.context.workspaceState.get(draftKey), undefined, 'a successful creation clears only the native title draft');
  const failCreate = workbench.backend.execute;
  workbench.backend.execute = function (command, ...args) {
    if (command === 'task.create') return Promise.reject(new Error('Fixture task creation failure'));
    return failCreate.call(this, command, ...args);
  };
  try {
    const failed = vscode.commands.executeCommand('warden.createTask');
    await eventually(() => !!workbench.taskInput);
    workbench.taskInput.value = 'Keep failed title';
    await eventually(async () => {
      if (!workbench.taskInput) return true;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return !workbench.taskInput;
    });
    await failed;
    assert.equal(workbench.tasks().length, count + 1, 'failed creation cannot reuse a previous success');
    assert.equal(workbench.context.workspaceState.get(draftKey), 'Keep failed title', 'failed creation retains its own native draft');
    assert.equal(workbench.model('workspaces').task.id, firstId, 'failed creation preserves the selected task');
  } finally {
    workbench.backend.execute = failCreate;
  }
  await workbench.handleAction({ type: 'task.create', title: 'Native second task', body: '' }, session);
  const secondId = workbench.tasks().at(-1).id;
  let nodes = await workbench.sidebar.getChildren(taskRoot);
  const first = nodes.find((node) => node.task.id === firstId);
  const second = nodes.find((node) => node.task.id === secondId);
  assert.match(workbench.sidebar.getTreeItem(first).contextValue, /^wardenTask:workspace/);
  assert.notEqual(second.task.worktree, firstWorkspace, 'every task gets its own workspace');
  const token = new vscode.CancellationTokenSource();
  const transfer = new vscode.DataTransfer();
  workbench.sidebar.handleDrag([second], transfer, token.token);
  await workbench.sidebar.handleDrop(first, transfer, token.token);
  assert(
    workbench.tasks().findIndex((task) => task.id === secondId) < workbench.tasks().findIndex((task) => task.id === firstId),
    'native drag reorders the plan',
  );
  await vscode.commands.executeCommand('warden.moveTaskDown', second);
  assert(
    workbench.tasks().findIndex((task) => task.id === secondId) > workbench.tasks().findIndex((task) => task.id === firstId),
    'keyboard ordering uses the same task sequence',
  );
  await vscode.commands.executeCommand('warden.moveTaskUp', second);
  assert.equal(workbench.tasks().at(-2).id, secondId);
  workbench.sidebar.handleDrag([second], transfer, token.token);
  await workbench.sidebar.handleDrop(undefined, transfer, token.token);
  assert.equal(workbench.tasks().at(-1).id, secondId, 'dropping at the root moves to the end');
  await vscode.commands.executeCommand('warden.selectTask', first);
  assert.equal(workbench.views.panels.has('task'), false, 'task selection keeps the editor free for review');
  nodes = await workbench.sidebar.getChildren(taskRoot);
  const workspace = nodes.find((node) => node.task.id === firstId);
  assert.match(workbench.sidebar.getTreeItem(workspace).contextValue, /^wardenTask:workspace/);
  await workbench.sidebar.view.reveal(workspace, { select: true, expand: true });
  await eventually(() => workbench.expanded[firstId] === true);
  if (process.env.WARDEN_VSCODE_SCREENSHOT && process.platform === 'linux') {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await workbench.sidebar.view.reveal(workspace, { select: true, focus: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', process.env.WARDEN_VSCODE_SCREENSHOT]);
  }
  await vscode.commands.executeCommand('list.collapse');
  // Explicit expansion storage also covers restores when the view is hidden.
  await workbench.rememberExpansion(workspace, false);
  assert.equal(workbench.sidebar.getTreeItem(workspace).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

  await workbench.backend.store.update((state) => {
    state.workflow.changes.push({
      id: 'legacy-unallocated',
      title: 'Legacy task',
      status: 'planned',
      developmentBranch: state.workflow.developmentBranch,
      createdAt: new Date().toISOString(),
    });
  });
  await workbench.refresh(true);
  const legacy = (await workbench.sidebar.getChildren(taskRoot)).find((node) => node.task.id === 'legacy-unallocated');

  const draft = vscode.commands.executeCommand('warden.createTask');
  await eventually(() => !!workbench.taskInput);
  workbench.taskInput.value = 'Keep this repository draft';
  const staleTransfer = new vscode.DataTransfer();
  workbench.sidebar.handleDrag([second], staleTransfer, token.token);
  await workbench.open(repository);
  await draft;
  const order = workbench.tasks().map((task) => task.id);
  await workbench.sidebar.handleDrop(undefined, staleTransfer, token.token);
  assert.deepEqual(
    workbench.tasks().map((task) => task.id),
    order,
    'a drag from the previous session cannot reorder tasks',
  );
  assert.deepEqual(await workbench.sidebar.getChildren(taskRoot), [], 'old nodes do not expose a different session');
  await vscode.commands.executeCommand('warden.startTask', legacy);
  assert.equal(workbench.tasks().find((task) => task.id === legacy.task.id).worktree, undefined, 'a stale menu cannot allocate a workspace');
  const current = await workbench.sidebar.getChildren({ kind: 'tasks' });
  await vscode.commands.executeCommand(
    'warden.selectTask',
    current.find((node) => node.task.id === legacy.task.id),
  );
  const legacyWorkspace = workbench.tasks().find((task) => task.id === legacy.task.id).worktree;
  assert(legacyWorkspace, 'opening a legacy task prepares its workspace without a separate creation action');
  await vscode.commands.executeCommand(
    'warden.selectTask',
    current.find((node) => node.task.id === legacy.task.id),
  );
  assert.equal(workbench.tasks().find((task) => task.id === legacy.task.id).worktree, legacyWorkspace, 'reselection keeps the same workspace');
  const editTask = current.find((node) => node.task.id === firstId);
  await vscode.commands.executeCommand('warden.editTask', editTask);
  assert(workbench.views.panels.has('task'), 'multiline editing opens only on explicit request');
  await vscode.commands.executeCommand(
    'warden.selectTask',
    current.find((node) => node.task.id === secondId),
  );
  assert.equal(workbench.views.currentModel('task').task.id, firstId, 'notes remain bound to their task while navigating');
  const notesModel = workbench.views.currentModel('task');
  const noteDraft = { type: 'task.draft', taskId: firstId, title: notesModel.task.title, body: 'Unsaved native notes\nKeep on reopen' };
  const sendDraft = (action) =>
    workbench.views.receive('task', { type: 'action', session: notesModel.session, action }, workbench.views.panels.get('task').webview);
  await sendDraft(noteDraft);
  await assert.rejects(sendDraft({ ...noteDraft, taskId: secondId }), /assigned task draft/);
  assert.notEqual(workbench.tasks().find((task) => task.id === firstId).body, noteDraft.body, 'draft edits never save task records');
  workbench.views.panels.get('task').dispose();
  await eventually(() => !workbench.views.panels.has('task'));
  await vscode.commands.executeCommand('warden.editTask', editTask);
  assert.deepEqual(
    workbench.views.currentModel('task').taskDraft,
    { title: noteDraft.title, body: noteDraft.body },
    'closed editor drafts restore from host state',
  );

  await workbench.open(repository);
  assert.match(workbench.views.currentModel('task').busy, /base branch changed/, 'old task forms become read-only after a context change');
  await sendDraft({ ...noteDraft, body: 'Draft retained across the repository context change' });
  assert.equal(workbench.views.currentModel('task').taskDraft.body, 'Draft retained across the repository context change');
  await assert.rejects(sendDraft({ ...noteDraft, type: 'task.update' }), /base branch changed/);

  workbench.views.panels.get('task').dispose();
  token.dispose();
};
