const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');

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
  const pause = Number(process.env.WARDEN_VSCODE_WALKTHROUGH_PAUSE ?? 1500);
  const steps = [];
  const step = async (title, action) => {
    const name = `${String(steps.length + 1).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const row = { name, title, status: 'passed', startedAt: Date.now() };
    steps.push(row);
    try {
      await action();
    } catch (error) {
      row.status = 'blocked';
      row.error = String(error?.message ?? error);
    }
    // Let the native views paint what the step left behind before the picture.
    await new Promise((resolve) => setTimeout(resolve, pause));
    if (process.platform === 'linux' && process.env.DISPLAY)
      execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', path.join(output, `${name}.png`)]);
    row.endedAt = Date.now();
    await fs.writeFile(path.join(output, 'steps.json'), `${JSON.stringify(steps, null, 2)}\n`);
    if (row.status === 'blocked') throw new Error(`${title}: ${row.error}`);
  };
  const node = async (title) => {
    const found = (await workbench.sidebar.getChildren()).find((row) => row.task?.title === title);
    assert(found, `task ${title} is in the sidebar`);
    return found;
  };
  const title = 'Filter orders by status';
  const folder = `${fixture.root}-work`;
  const freePort = () =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  const served = (port, file) =>
    new Promise((resolve) => {
      http
        .get({ host: '127.0.0.1', port, path: `/${file}` }, (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve(response.statusCode === 200 ? body : undefined));
        })
        .on('error', () => resolve(undefined));
    });
  const settings = vscode.workspace.getConfiguration('warden');
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // An agent that plays one scripted turn: it reads the demo, edits app.js in its workspace and explains.
    await settings.update(
      'acpAgents',
      [{ id: 'setup-fixture', label: 'Demo agent', command: fixture.node, args: [fixture.agent, `${fixture.journal}.check`, 'scripted', fixture.turn] }],
      vscode.ConfigurationTarget.Global,
    );
    await workbench.agentSetup.check();
    assert.equal(workbench.agentSetup.readiness.snapshot().status, 'ready');
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

    await step('Ask the agent for the change', async () => {
      const workspace = (await node(title)).task.worktree;
      const turn = chat.session.send('Add a status filter above the order list.');
      // The picture of this step is the finished turn; the recording shows it as it happens.
      await turn;
      await eventually(() => chat.session.snapshot().status === 'connected');
      assert.match(await fs.readFile(path.join(workspace, 'app.js'), 'utf8'), /renderToolbar/, 'the agent edited its own workspace');
      assert.doesNotMatch(await fs.readFile(path.join(fixture.root, 'app.js'), 'utf8'), /renderToolbar/, 'primary is untouched');
    });

    await step('See the changed files under the task', async () => {
      await workbench.refresh(true);
      const task = await node(title);
      await workbench.sidebar.view.reveal(task, { select: true, expand: true });
      await eventually(async () => (await workbench.getChildren(await node(title))).length === 1);
    });

    await step('Connect the task to the work folder', async () => {
      await vscode.commands.executeCommand('warden.connect', await node(title));
      await eventually(async () => /renderToolbar/.test(await fs.readFile(path.join(folder, 'app.js'), 'utf8')));
      assert.doesNotMatch(await fs.readFile(path.join(fixture.root, 'app.js'), 'utf8'), /renderToolbar/, 'primary is untouched');
    });

    let port;
    await step('Run the development server in the work folder', async () => {
      port = await freePort();
      await settings.update('previewCommand', `PORT=${port} node server.mjs`, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('warden.runPreview');
      await eventually(async () => !!(await served(port, 'index.html')));
      assert.match(await served(port, 'app.js'), /renderToolbar/, "the server runs the work folder's composition, with the agent's change");
    });

    await step('Try the change in the browser', async () => {
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('simpleBrowser.show', `http://127.0.0.1:${port}/`);
      await eventually(() => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.input instanceof vscode.TabInputWebview));
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
      workbench.commitInput.value = 'Filter orders by status';
    });

    await step('Commit the task to the base branch', async () => {
      await eventually(async () => {
        if (!workbench.commitInput) return true;
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        return !workbench.commitInput;
      });
      await delivering;
      assert.equal(git(fixture.root, 'log', '-1', '--format=%s'), 'Filter orders by status', JSON.stringify([...workbench.errors.values()]));
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
    for (const execution of vscode.tasks.taskExecutions) execution.terminate();
    await settings.update('previewCommand', undefined, vscode.ConfigurationTarget.Global);
    await fs.writeFile(path.join(output, 'steps.json'), `${JSON.stringify(steps, null, 2)}\n`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  console.log(`Walkthrough: ${steps.filter((row) => row.status === 'passed').length} of ${steps.length} steps passed`);
};
