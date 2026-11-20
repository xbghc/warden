const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const { verifyAgent } = require('./agent-setup.cjs');

/**
 * The core loop as one user would walk it, in order, in the packaged extension: each step is done,
 * checked, and photographed. The pictures are the acceptance record: a step that cannot be done
 * ends the run there, and `steps.json` names it.
 */
const eventually = async (condition, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for extension state');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const output = process.env.WARDEN_VSCODE_WALKTHROUGH;
  assert(output, 'WARDEN_VSCODE_WALKTHROUGH names the directory for the pictures');
  await fs.mkdir(output, { recursive: true });
  const extension = vscode.extensions.getExtension('xbghc.warden');
  assert(extension, 'extension is installed');
  const workbench = await extension.activate();
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const steps = [];
  const step = async (title, action) => {
    const name = `${String(steps.length + 1).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const row = { name, title, status: 'passed' };
    steps.push(row);
    try {
      await action();
    } catch (error) {
      row.status = 'blocked';
      row.error = String(error?.message ?? error);
    }
    // Let the native views paint what the step left behind before the picture.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (process.platform === 'linux' && process.env.DISPLAY)
      execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', path.join(output, `${name}.png`)]);
    await fs.writeFile(path.join(output, 'steps.json'), `${JSON.stringify(steps, null, 2)}\n`);
    if (row.status === 'blocked') throw new Error(`${title}: ${row.error}`);
  };
  const node = async (title) => {
    const found = (await workbench.sidebar.getChildren()).find((row) => row.task?.title === title);
    assert(found, `task ${title} is in the sidebar`);
    return found;
  };
  const title = 'Add order filtering';
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await verifyAgent(workbench, fixture);
    await workbench.refresh(true);

    await step('Open the work folder', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.warden');
      assert.equal(workbench.model('workspaces').agentReadiness.status, 'ready', 'the agent is connected');
      assert(workbench.data.workflow, 'the base branch is chosen');
    });

    let creating;
    await step('Name a new task', async () => {
      creating = vscode.commands.executeCommand('warden.createTask');
      await eventually(() => !!workbench.taskInput);
      workbench.taskInput.value = title;
    });

    await step('Task gets its own workspace', async () => {
      await eventually(async () => {
        if (!workbench.taskInput) return true;
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        return !workbench.taskInput;
      });
      await creating;
      await eventually(() => workbench.tasks().some((task) => task.title === title && task.worktree));
    });

    let chat;
    await step('Select the task to open its chat', async () => {
      await vscode.commands.executeCommand('warden.selectTask', await node(title));
      await eventually(() => workbench.conversations.sidebarEntry?.session.snapshot().status === 'connected');
      chat = workbench.conversations.sidebarEntry;
      assert.equal(chat.binding.taskId, (await node(title)).task.id);
    });

    await step('Agent works in the task workspace', async () => {
      const workspace = (await node(title)).task.worktree;
      // The fixture agent edits a file in its own working directory, as a real agent would.
      await fs.writeFile(path.join(workspace, 'context.txt'), 'Order filter\n');
      await chat.session.send('own-edit');
      await eventually(() => chat.session.snapshot().status === 'connected');
      assert.match(await fs.readFile(path.join(workspace, 'agent-output.txt'), 'utf8'), /Order filter edited by/);
      await assert.rejects(fs.access(path.join(fixture.root, 'agent-output.txt')), 'primary is untouched');
    });

    await step('See the changed files under the task', async () => {
      await workbench.refresh(true);
      const task = await node(title);
      await workbench.sidebar.view.reveal(task, { select: true, expand: true });
      await eventually(async () => (await workbench.getChildren(await node(title))).length === 2);
    });

    await step('Connect the task to the work folder', async () => {
      await vscode.commands.executeCommand('warden.connect', await node(title));
      const folder = `${fixture.root}-work`;
      await eventually(() =>
        fs.access(path.join(folder, 'agent-output.txt')).then(
          () => true,
          () => false,
        ),
      );
      await assert.rejects(fs.access(path.join(fixture.root, 'agent-output.txt')), 'primary is untouched');
    });

    await step('Review a change as a native diff', async () => {
      const files = await workbench.getChildren(await node(title));
      await vscode.commands.executeCommand('warden.openDiff', files[0]);
      await eventually(() => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.input instanceof vscode.TabInputTextDiff));
    });

    let delivering;
    await step('Write the commit message', async () => {
      delivering = workbench.promptDelivery(await node(title));
      await eventually(() => !!workbench.commitInput);
      workbench.commitInput.value = 'Add order filtering';
    });

    await step('Commit the task to the base branch', async () => {
      await eventually(async () => {
        if (!workbench.commitInput) return true;
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        return !workbench.commitInput;
      });
      await delivering;
      assert.equal(git(fixture.root, 'log', '-1', '--format=%s'), 'Add order filtering', JSON.stringify([...workbench.errors.values()]));
      assert.equal(git(fixture.root, 'status', '--porcelain'), '', 'primary is clean after the commit');
    });

    await step('Check the other task against the new base', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await workbench.refresh(true);
      while (workbench.checkReading) await workbench.checkReading;
      await workbench.showRebase();
      await eventually(() => workbench.views.panels.has('rebase'));
      assert(workbench.model('rebase').checks?.checks.length, 'the rebase panel lists the workspaces behind the base branch');
    });
  } finally {
    await fs.writeFile(path.join(output, 'steps.json'), `${JSON.stringify(steps, null, 2)}\n`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  console.log(`Walkthrough: ${steps.filter((row) => row.status === 'passed').length} of ${steps.length} steps passed`);
};
