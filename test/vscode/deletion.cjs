const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { verifyAgent } = require('./agent-setup.cjs');

exports.checkTaskDeletion = async (workbench, extension, fixture, eventually) => {
  const commands = await vscode.commands.getCommands(true);
  assert(commands.includes('warden.deleteTask') && commands.includes('warden.retryDeleteTask'));
  const menus = extension.packageJSON.contributes.menus['view/item/context'];
  assert(menus.some((item) => item.command === 'warden.deleteTask' && item.group === '9_delete@1'));
  assert(menus.some((item) => item.command === 'warden.retryDeleteTask' && item.when.includes('wardenTask:deleting')));
  const before = (await workbench.backend.store.load()).workflow.changes.map((task) => task.id);
  const created = await workbench.backend.execute('task.create', { title: 'Delete this task', body: 'Task notes' });
  await fs.writeFile(path.join(created.worktree, 'discard.txt'), 'Pending task work\n');
  await fs.mkdir(path.join(created.worktree, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(created.worktree, 'node_modules', 'retained'), 'Installed environment\n');
  await workbench.refresh(true);
  const node = (await workbench.getChildren()).find((row) => row.task.id === created.id);
  const confirm = workbench.confirmTaskDeletion;
  let accept = false;
  const prompts = [];
  workbench.confirmTaskDeletion = async (title, detail, button) => {
    prompts.push({ title, detail, button });
    return accept ? button : undefined;
  };
  try {
    await vscode.commands.executeCommand('warden.deleteTask', node);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].button, 'Delete Task');
    assert(prompts[0].detail.includes('workspace folder') && prompts[0].detail.includes('will be kept'));
    assert(!prompts[0].detail.includes('backup'));
    assert(
      (await workbench.backend.store.load()).workflow.changes.some((task) => task.id === created.id),
      'cancellation keeps the task',
    );
    assert.equal(await fs.readFile(path.join(created.worktree, 'discard.txt'), 'utf8'), 'Pending task work\n');

    await workbench.selectTask(node, 'edit');
    await workbench.views.notes.save(fixture.root, created.id, { title: 'Unsaved note', body: 'Draft' }, { title: created.title, body: created.body });
    await workbench.conversations.show(fixture.root, created.id);
    const entry = [...workbench.conversations.entries.values()].find((row) => row.binding.taskId === created.id);
    await eventually(() => entry.session.snapshot().status === 'connected' && entry.surface?.ready, 30_000);
    assert.equal(workbench.conversations.hasConnection(fixture.root, created.id), true);
    accept = true;
    await vscode.commands.executeCommand('warden.deleteTask', node);
    assert.equal(prompts.at(-1).button, 'End Agent Process and Delete');
    assert.equal(workbench.errors.get(`task:${created.id}`), undefined, JSON.stringify([...workbench.errors.values()]));
    assert.deepEqual(
      (await workbench.backend.store.load()).workflow.changes.map((task) => task.id),
      before,
    );
    assert.equal(workbench.conversations.entries.has(JSON.stringify([fixture.root, created.id])), false);
    assert.equal(workbench.views.notes.read(fixture.root, created.id), undefined);
    assert.equal(workbench.views.panels.has('task'), false);
    assert(!(await workbench.getChildren()).some((row) => row.task.id === created.id));
    assert.equal(await fs.readFile(path.join(created.worktree, 'node_modules', 'retained'), 'utf8'), 'Installed environment\n');
    await assert.rejects(fs.access(path.join(created.worktree, 'discard.txt')), { code: 'ENOENT' });

    const retry = await workbench.backend.execute('task.create', { title: 'Retry task' });
    assert.equal(retry.worktree, created.worktree, 'new task reuses the physical directory');
    await fs.writeFile(path.join(retry.worktree, 'retry.txt'), 'Keep until confirmed\n');
    await workbench.backend.execute('preview.connect', { connectedIds: [retry.id] });
    const preview = await workbench.backend.execute('preview.get');
    const readme = await fs.readFile(path.join(preview.worktree, 'README.md'));
    await fs.writeFile(path.join(preview.worktree, 'README.md'), 'Unexpected edit\n');
    await workbench.refresh(true);
    let retryNode = (await workbench.getChildren()).find((row) => row.task.id === retry.id);
    await vscode.commands.executeCommand('warden.deleteTask', retryNode);
    const pending = (await workbench.backend.store.load()).workflow.changes.find((row) => row.id === retry.id);
    assert.equal(pending.deletion.phase, 'disconnecting');
    assert(pending.deletion.error);
    retryNode = (await workbench.getChildren()).find((row) => row.task.id === retry.id);
    const item = workbench.sidebar.getTreeItem(retryNode);
    assert(item.contextValue.startsWith('wardenTask:deleting'));
    assert(item.description.includes('Delete Failed'));
    await fs.writeFile(path.join(preview.worktree, 'README.md'), readme);
    await vscode.commands.executeCommand('warden.retryDeleteTask', retryNode);
    assert.deepEqual(
      (await workbench.backend.store.load()).workflow.changes.map((task) => task.id),
      before,
    );
    assert.deepEqual((await workbench.backend.execute('preview.get')).connectedIds, []);

    const observedTask = await workbench.backend.execute('task.create', { title: 'Observe engine deletion' });
    await workbench.conversations.show(fixture.root, observedTask.id);
    const observedKey = JSON.stringify([fixture.root, observedTask.id]);
    const observedChat = workbench.conversations.entries.get(observedKey);
    await eventually(() => observedChat.session.snapshot().status === 'connected' && observedChat.surface?.ready, 30_000);
    await workbench.conversations.handle(observedChat, { type: 'disconnect' });
    const checked = await workbench.backend.execute('task.deleteCheck', { taskId: observedTask.id });
    // Bypass the workbench deletion command so cleanup must come from the conversation's state observer.
    await workbench.backend.execute('task.delete', { taskId: observedTask.id, confirmation: checked.confirmation });
    await eventually(() => !workbench.conversations.entries.has(observedKey), 30_000);
    assert.equal(observedChat.surface, undefined, 'state notifications release a deleted conversation surface');
    console.log(
      'Packaged task deletion passed: native commands, confirmation/cancel, owned-agent disconnect, note/chat cleanup, state notifications, retained folders, fresh allocation and visible retry',
    );
  } finally {
    workbench.confirmTaskDeletion = confirm;
  }
};

exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const extension = vscode.extensions.getExtension('xbghc.warden');
  const workbench = await extension.activate();
  const eventually = async (condition, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for extension state');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    await verifyAgent(workbench, fixture);
    await exports.checkTaskDeletion(workbench, extension, fixture, eventually);
  } finally {
    await workbench.close();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};
