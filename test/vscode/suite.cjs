const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const { checkBranches } = require('./branches.cjs');
// Git may materialize preview text with CRLF under the user's Windows configuration.
const textLines = (text) => text.replace(/\r\n/g, '\n');
const eventually = async (condition, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for extension state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const extension = vscode.extensions.getExtension('xbghc.warden');
  assert(extension, 'extension is installed');
  const workbench = await extension.activate();
  try {
    assert.equal(workbench.backend?.store.file, fixture.state, 'fixture setup and extension activation must use the same canonical state path');
    await workbench.open(fixture.unconfigured);
    assert.equal(workbench.model('task').workflow.workflow, null, 'opening a repository does not choose its development branch');
    assert.deepEqual(await workbench.getChildren(), [], 'unconfigured repositories show setup instead of operational navigation');
    assert.deepEqual(await workbench.getChildren({ kind: 'history' }), [], 'previous repository history is unavailable during setup');
    for (const surface of ['workspaces', 'task', 'preview', 'history', 'rebase']) {
      const model = workbench.model(surface);
      assert.equal(model.repository, fixture.unconfigured);
      assert.equal(model.workflow.workflow, null, 'directly opened workflow pages receive setup state');
    }
    await workbench.handleAction({ type: 'settings.agents' }, workbench.session);
    assert.equal(workbench.errors.has('settings'), false, 'ACP settings remain available before branch configuration');
    assert(
      vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.label === 'Settings')),
      'ACP configuration opens VS Code settings',
    );
    await workbench.views.show('settings');
    await eventually(() => workbench.views.displaysError('settings'));
    assert.equal(workbench.views.displaysError('repository'), true);
    assert.equal(workbench.views.displaysError('preview'), false, 'errors for hidden pages still need native notification');
    assert.equal(workbench.views.displaysError('task:another-task'), false);
    await workbench.views.show('preview');
    await eventually(() => workbench.views.displaysError('preview') && !workbench.views.displaysError('settings'));
    const settings = vscode.workspace.getConfiguration('warden');
    assert.equal(workbench.model('preview').hasPreviewCommand, false);
    await settings.update('previewCommand', 'echo preview', vscode.ConfigurationTarget.Global);
    assert.equal(workbench.model('preview').hasPreviewCommand, true);
    await settings.update('previewCommand', undefined, vscode.ConfigurationTarget.Global);
    assert.equal(workbench.model('preview').hasPreviewCommand, false);
    await workbench.backend.execute('workflow.configure', { branch: 'main' });
    await workbench.refresh();
    assert.deepEqual(
      (await workbench.getChildren()).map((node) => node.kind),
      ['preview', 'history', 'tasks', 'settings'],
    );
    await checkBranches(workbench, fixture.unconfigured, eventually);
    await workbench.open(fixture.root);
    assert.equal(workbench.backend.store.file, fixture.state);
    const tasks = await workbench.getChildren({ kind: 'tasks' });
    assert.equal(tasks.length, 1);
    const attention = workbench.workspaceRow({
      ...tasks[0].task,
      agent: 'fixture-agent',
      status: 'integrating',
      integration: { error: 'Fixture commit failure' },
      workspaceHook: { status: 'failed' },
    });
    assert.equal(attention.description, '提交失败 · 初始化失败', 'task rows prioritize problems and show at most two facts');
    assert(attention.tooltip.includes('待提交') && attention.tooltip.includes('fixture-agent'), 'secondary context remains in the tooltip');
    const checked = workbench.checks;
    for (const status of ['ready', 'conflict']) {
      workbench.checks = { checks: [{ changeId: tasks[0].task.id, status, message: 'Fixture sync check' }] };
      const item = workbench.workspaceRow(tasks[0].task);
      assert.equal(workbench.model('workspaces').checks.checks[0].status, status, 'workspace actions receive synchronization conditions');
      assert(!item.description.includes('rebase'), 'sync conditions do not add a text row');
      assert(item.tooltip.includes('Fixture sync check'));
    }
    workbench.checks = checked;
    await workbench.showRebase(tasks[0]);
    assert.deepEqual(workbench.model('rebase').rebaseSelection.taskIds, [tasks[0].task.id]);
    await workbench.showRebase();
    assert.deepEqual(workbench.model('rebase').rebaseSelection.taskIds, [], 'batch sync does not inherit the last single-task selection');
    await vscode.commands.executeCommand('warden.connect', tasks[0]);
    const state = () => fs.readFile(fixture.state, 'utf8').then(JSON.parse);
    let preview = (await state()).connectionPreview;
    assert.notEqual(preview.worktree, fixture.root);
    const commonGit = async (cwd) =>
      fs.realpath(path.resolve(cwd, execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()));
    assert.equal(await commonGit(preview.worktree), await commonGit(tasks[0].task.worktree), 'task and preview share the external Git repository');
    assert.notEqual(await commonGit(preview.worktree), await commonGit(fixture.root), 'primary Git storage stays independent');
    assert.equal(textLines(await fs.readFile(path.join(preview.worktree, 'agent.txt'), 'utf8')), 'Agent addition\n');
    await assert.rejects(fs.access(path.join(fixture.root, 'agent.txt')));
    await workbench.rememberExpansion(tasks[0], false);
    await workbench.open(fixture.root);
    assert.equal(workbench.workspaceRow(tasks[0].task).expanded, false, 'collapsed state survives reopening the repository');
    const files = await workbench.getChildren(tasks[0]);
    assert.equal(files.length, 1);
    await vscode.commands.executeCommand('warden.openDiff', files[0]);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const diff = tabs.find((tab) => tab.input instanceof vscode.TabInputTextDiff);
    assert(diff, 'native diff tab is open');
    assert.equal(diff.input.original.scheme, 'warden-review');
    assert.equal(diff.input.modified.scheme, 'warden-review');
    const doc = await vscode.workspace.openTextDocument(diff.input.modified);
    const originalText = doc.getText();
    assert.equal(textLines(originalText), 'Agent addition\n');
    await workbench.rememberExpansion(tasks[0], false);
    await workbench.handleAction({ type: 'task.message', taskId: tasks[0].task.id, message: 'Keep this draft' }, workbench.session);
    await workbench.selectTask(tasks[0]);
    assert.equal(workbench.workspaceRow(tasks[0].task).expanded, false, 'selecting a task does not reopen its changed files');
    assert(
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab === diff),
      'selecting the task retains the existing native diff',
    );
    assert.equal(workbench.model('task').message, 'Keep this draft');
    assert.equal(workbench.views.panels.has('task'), false, 'task controls stay out of the editor area');
    await workbench.selectTask(tasks[0], false, 'history');
    assert.equal(workbench.model('task').taskSection.section, 'history', 'delivery records use the workspace list');
    assert.equal(workbench.views.panels.has('task'), false);
    await workbench.selectTask(tasks[0], false, 'commit');
    await vscode.commands.executeCommand('type', { text: 'Forbidden' });
    assert.equal(doc.getText(), originalText, 'native typing cannot edit review content');
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
    const pinnedText = pinnedDoc.getText();
    const pinnedContent = await workbench.documents.provideTextDocumentContent(pinnedDoc.uri);
    assert.equal(textLines(pinnedText), 'Agent addition\n');
    const cancelledInput = workbench.promptDelivery(tasks[0]);
    await eventually(() => !!workbench.commitInput);
    assert.match(workbench.commitInput.title, /提交到 main/);
    workbench.commitInput.value = 'Cancelled commit draft';
    workbench.commitInput.hide();
    await cancelledInput;
    assert.equal(workbench.model('workspaces').message, 'Cancelled commit draft', 'cancelling the native input retains its draft');
    assert.equal((await state()).workflow.changes[0].integration, undefined, 'cancelling never stages primary');
    const staleInput = workbench.promptDelivery(tasks[0]);
    await eventually(() => !!workbench.commitInput);
    assert.equal(workbench.commitInput.value, 'Cancelled commit draft');
    await fs.writeFile(path.join(workspace, 'later.txt'), 'Unreviewed addition\n');
    git('add', 'later.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Later version');
    await workbench.refresh();
    assert.equal(pinnedDoc.getText(), pinnedText, 'open documents stay immutable');
    await eventually(async () => {
      if (!workbench.commitInput) return true;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return !workbench.commitInput;
    });
    await staleInput;
    assert.match(workbench.errors.get(`task:${tasks[0].task.id}`).message, /输入期间审阅版本已变化/);
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
    // A background composition can own the repository lock longer than the command's
    // wait budget. A reported refusal does not mean the requested version was published.
    await workbench.backend.store.withRepositoryLock(async () => {
      await fs.writeFile(path.join(fixture.root, 'human.txt'), 'Human code\n');
      assert.equal(await vscode.commands.executeCommand('warden.refreshPreview'), undefined);
      assert.equal(workbench.errors.get('repository')?.code, 'operation_locked');
    });
    const refreshDeadline = Date.now() + 60_000;
    for (;;) {
      preview = await vscode.commands.executeCommand('warden.refreshPreview');
      if (preview) break;
      const error = workbench.errors.get('repository');
      assert.equal(error?.code, 'operation_locked', JSON.stringify(error));
      assert(Date.now() < refreshDeadline, 'Preview refresh remained blocked by another operation');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(preview.syncStatus, 'synced', JSON.stringify(preview));
    assert.equal(textLines(await fs.readFile(path.join(preview.worktree, 'human.txt'), 'utf8')), 'Human code\n');
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
    // The packaged host must preserve normal hooks and recover its exact staged version.
    const primaryGit = (...args) => execFileSync('git', ['-C', fixture.root, ...args], { encoding: 'utf8' }).trim();
    primaryGit('add', 'human.txt');
    primaryGit('commit', '-qm', 'Human development');
    await workbench.refresh();
    currentFiles = await workbench.getChildren(tasks[0]);
    await workbench.openDiff(currentFiles[0]);
    const hook = path.join(fixture.root, '.git', 'hooks', 'commit-msg');
    await fs.writeFile(hook, '#!/bin/sh\necho blocked-by-hook >&2\nexit 1\n');
    await fs.chmod(hook, 0o755);
    await assert.rejects(workbench.deliver(tasks[0], 'Reviewed delivery'), /blocked-by-hook/);
    assert.equal((await state()).workflow.changes[0].integration.prepared, true);
    await fs.unlink(hook);
    await workbench.refresh();
    currentFiles = await workbench.getChildren(tasks[0]);
    await workbench.openDiff(currentFiles[0]);
    const submittedInput = workbench.promptDelivery(tasks[0]);
    await eventually(() => !!workbench.commitInput);
    workbench.commitInput.value = 'Reviewed delivery\n\nKeep normal commit hooks';
    await eventually(async () => {
      if (!workbench.commitInput) return true;
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return !workbench.commitInput;
    });
    await submittedInput;
    assert.equal(primaryGit('log', '-1', '--format=%B'), 'Reviewed delivery\n\nKeep normal commit hooks');
    const deliveredTask = (await state()).workflow.changes[0];
    assert(
      deliveredTask.deliveries?.length,
      `delivery bookkeeping is durable: ${JSON.stringify({ task: deliveredTask, errors: [...workbench.errors.values()] })}`,
    );
    const accepted = deliveredTask.deliveries[0];
    assert(accepted.id && accepted.commit, 'delivery is durable');
    assert.equal((await state()).workflow.changes[0].worktree, workspace);

    await workbench.refresh();
    const session = workbench.session;
    const count = (await state()).workflow.changes.length;
    const previousTask = workbench.model('workspaces').task.id;
    await workbench.handleAction({ type: 'workspaces.create' }, session);
    assert.equal(workbench.model('workspaces').creating, true);
    assert.equal(workbench.model('workspaces').task, undefined);
    await assert.rejects(workbench.handleAction({ type: 'task.cancelCreate' }, 'old-session'), /仓库或主开发分支已切换/);
    assert.equal(workbench.model('workspaces').creating, true);
    await workbench.handleAction({ type: 'task.cancelCreate' }, session);
    assert.equal(workbench.model('workspaces').creating, false);
    assert.equal(workbench.model('workspaces').createdTaskId, undefined);
    assert.equal(workbench.model('workspaces').task.id, previousTask, 'cancel preserves the prior task selection');
    assert.equal((await state()).workflow.changes.length, count, 'cancel never creates a task');
    await assert.rejects(workbench.handleAction({ type: 'task.create', title: 'Wrong repository', body: '' }, 'old-session'), /仓库或主开发分支已切换/);
    assert.equal((await state()).workflow.changes.length, count);
    await workbench.handleAction({ type: 'workspaces.create' }, session);
    // Hold a real pre-mutation read until creation commits; it must not hide the newly saved task.
    await workbench.reading;
    const engine = workbench.backend;
    const execute = engine.execute;
    let releaseRead;
    let capturedRead;
    const heldRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const captured = new Promise((resolve) => {
      capturedRead = resolve;
    });
    let releaseCreate;
    let creationStarted = false;
    const heldCreate = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    let hold = true;
    engine.execute = async (command, request) => {
      if (command === 'task.create') {
        creationStarted = true;
        await heldCreate;
      }
      try {
        const result = await execute.call(engine, command, request);
        if (command === 'workflow.get' && hold) {
          hold = false;
          capturedRead();
          await heldRead;
        }
        return result;
      } finally {
        if (command === 'task.create') releaseRead();
      }
    };
    try {
      const reading = workbench.refresh();
      await captured;
      const creating = workbench.handleAction({ type: 'task.create', title: 'Fresh workspace', body: 'Line one\nLine two' }, session);
      await eventually(() => creationStarted);
      await workbench.handleAction({ type: 'task.cancelCreate' }, session);
      assert.equal(workbench.model('workspaces').creating, true, 'an in-flight creation cannot appear cancelled');
      assert(workbench.model('workspaces').busy, 'creation stays visibly in progress');
      releaseCreate();
      await creating;
      await reading;
    } finally {
      releaseCreate();
      releaseRead();
      engine.execute = execute;
    }
    const newTask = (await state()).workflow.changes.at(-1);
    assert.equal(workbench.model('workspaces').createdTaskId, newTask.id, 'successful creation has an explicit draft-clear receipt');
    assert.equal(newTask.body, 'Line one\nLine two');
    await workbench.handleAction({ type: 'task.start', taskId: newTask.id, kind: 'shared', agent: 'worker-b' }, session);
    await workbench.handleAction({ type: 'task.brief', taskId: newTask.id }, session);
    assert.match(await vscode.env.clipboard.readText(), /执行者：worker-b/);
    assert.notEqual((await state()).workflow.changes.at(-1).worktree, workspace);

    const beforeHistory = primaryGit('rev-parse', 'HEAD');
    const draft = { head: beforeHistory, start: beforeHistory, commits: [{ sha: beforeHistory, message: 'Arrange accepted delivery' }] };
    await workbench.handleAction({ type: 'history.preview', draft }, session);
    assert.equal(workbench.historyPreview.canApply, true);
    await workbench.handleAction({ type: 'history.apply', id: workbench.historyPreview.id, head: beforeHistory }, session);
    assert.equal(primaryGit('log', '-1', '--format=%B'), 'Arrange accepted delivery');
    assert.equal((await state()).workflow.changes[0].deliveries[0].id, accepted.id);
    assert.notEqual((await state()).workflow.changes[0].deliveries[0].commit, accepted.commit);
    assert.equal(workbench.historyDraft, undefined);
    workbench.documents.contents.clear();
    assert.equal(await workbench.documents.provideTextDocumentContent(pinnedDoc.uri), pinnedContent, 'saved native snapshots survive memory eviction');
    await workbench.open(fixture.root);
    assert.notEqual(workbench.session, session, 'reopening the repository creates a new session');
    await assert.rejects(workbench.handleAction({ type: 'task.create', title: 'Stale view', body: '' }, session), /仓库或主开发分支已切换/);
    assert.equal((await state()).workflow.changes.length, count + 1);

    // A pure executable-bit change has identical text on both sides of the native diff.
    await fs.chmod(path.join(workspace, 'README.md'), 0o755);
    git('update-index', '--chmod=+x', 'README.md');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Make README executable');
    await workbench.refresh();
    const modeFile = (await workbench.getChildren(tasks[0])).find((row) => row.file.path === 'README.md');
    assert(modeFile, 'a mode-only change remains in the review inventory');
    assert.equal(modeFile.file.additions + modeFile.file.deletions, 0);
    assert.equal(modeFile.file.oldMode, '100644');
    assert.equal(modeFile.file.newMode, '100755');
    assert(workbench.model('workspaces').workspaces[0].files.some((file) => file.path === 'README.md' && file.newMode === '100755'));
    await workbench.openDiff(modeFile);
    const modeDiff = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.label.includes('100644 → 100755'));
    assert(modeDiff?.input instanceof vscode.TabInputTextDiff, 'the native diff title exposes the mode-only change');
    const modeBefore = await vscode.workspace.openTextDocument(modeDiff.input.original);
    const modeAfter = await vscode.workspace.openTextDocument(modeDiff.input.modified);
    assert.equal(modeBefore.getText(), modeAfter.getText(), 'mode metadata does not alter the immutable source snapshots');

    // Index a symlink without requiring the OS account to have symlink creation privileges.
    git('config', 'core.symlinks', 'false');
    await fs.writeFile(path.join(workspace, 'README.md'), 'agent.txt');
    git('add', 'README.md');
    const linkBlob = git('rev-parse', ':README.md');
    git('update-index', '--cacheinfo', `120000,${linkBlob},README.md`);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Replace README with a symlink');
    await workbench.refresh();
    const typeFiles = await workbench.getChildren(tasks[0]);
    const typeChanges = typeFiles.filter((row) => row.file.path === 'README.md');
    assert.equal(typeChanges.length, 1, 'a file-type change has one workspace file entry');
    assert.equal(new Set(typeFiles.map((row) => row.file.path)).size, typeFiles.length);
    assert.equal(typeChanges[0].file.oldMode, '100644');
    assert.equal(typeChanges[0].file.newMode, '120000');
    await workbench.openDiff(typeChanges[0]);
    const typeDiff = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.label.includes('100644 → 120000'));
    assert(typeDiff?.input instanceof vscode.TabInputTextDiff, 'the native diff shows the complete file-type transition');
    assert.equal((await vscode.workspace.openTextDocument(typeDiff.input.modified)).getText(), 'agent.txt');

    // Exercise the bundled ACP host through its command, configured profile and panel action boundary.
    const configuration = vscode.workspace.getConfiguration('warden');
    await configuration.update(
      'acpAgents',
      [{ id: 'fixture', label: 'Test agent', command: fixture.node, args: [fixture.agent, fixture.journal, 'controls'] }],
      vscode.ConfigurationTarget.Global,
    );
    const chatTask = (await workbench.getChildren({ kind: 'tasks' })).find((row) => row.task.id === newTask.id);
    await vscode.commands.executeCommand('warden.chat', chatTask);
    const conversations = workbench.conversations;
    const chat = [...conversations.entries.values()].find((entry) => entry.binding.taskId === newTask.id);
    assert(chat?.panel, 'task command opens a dedicated conversation panel');
    const edit = (text) => {
      const current = chat.draft.snapshot();
      return { text, version: current.draftVersion, revision: current.draftRevision + 1 };
    };
    assert.equal(chat.session.snapshot().status, 'disconnected');
    await assert.rejects(fs.access(fixture.journal), 'opening a panel does not launch the agent');
    await fs.writeFile(path.join(chat.binding.workspace, 'context.txt'), 'Task context\n');
    await conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('own-edit') });
    assert.match(await fs.readFile(path.join(chat.binding.workspace, 'agent-output.txt'), 'utf8'), /^Task context edited by /);
    await assert.rejects(fs.access(path.join(fixture.root, 'agent-output.txt')));
    await assert.rejects(fs.access(path.join(preview.worktree, 'agent-output.txt')));
    const journal = () => fs.readFile(fixture.journal, 'utf8').then((text) => text.trim().split('\n').map(JSON.parse));
    const initialized = (await journal()).find((row) => row.method === 'initialize');
    assert.deepEqual(initialized.params.clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
    });
    assert.equal(initialized.cwd, chat.binding.workspace);
    assert.equal(chat.draft.text, '', 'completed prompt clears the submitted draft');
    assert.equal(chat.session.snapshot().controls.configOptions.find((option) => option.id === 'model').currentValue, 'fast');
    await conversations.handle(chat, { type: 'set-config', configId: 'model', value: 'deep' });
    await conversations.handle(chat, { type: 'set-config', configId: 'thinking', value: true });
    assert.equal(chat.session.snapshot().controls.configOptions.find((option) => option.id === 'model').currentValue, 'deep');
    assert.equal(chat.session.snapshot().controls.configOptions.find((option) => option.id === 'thinking').currentValue, true);
    assert.equal(chat.session.snapshot().controls.modes, undefined, 'session config takes precedence over legacy modes');
    const asking = conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('permission') });
    await eventually(() => chat.session.snapshot().permissions.length === 1);
    const permission = chat.session.snapshot().permissions[0];
    const previousPanel = chat.panelId;
    chat.panel.dispose();
    await conversations.show(fixture.root, newTask.id);
    assert.notEqual(chat.panelId, previousPanel, 'reopening retains the running session in a fresh panel');
    await conversations.handle(chat, { type: 'permission', requestId: permission.id, optionId: 'reject-once' });
    await asking;
    assert.equal(chat.draft.text, '', 'completion clears a submitted draft after reopening the panel');
    assert.match(
      await fs.readFile(path.join(chat.binding.workspace, 'agent-output.txt'), 'utf8'),
      /^Task context edited by /,
      'rejection does not authorize the requested edit',
    );
    const typedDraft = edit('Edited task');
    await conversations.handle(chat, { type: 'draft', ...typedDraft });
    await conversations.append(fixture.root, newTask.id, 'Selected source');
    assert.equal(chat.draft.text, 'Edited task\n\nSelected source');
    await assert.rejects(conversations.handle(chat, { type: 'send', profileId: 'fixture', ...typedDraft }), /草稿已更新/);
    assert.equal(chat.draft.text, 'Edited task\n\nSelected source', 'a stale send cannot erase appended context');
    const held = conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('hold') });
    await eventually(async () => (await journal()).some((row) => row.method === 'session/prompt' && row.params.prompt[0].text === 'hold'));
    await conversations.handle(chat, { type: 'draft', ...edit('hold') });
    await conversations.handle(chat, { type: 'cancel' });
    await held;
    assert.equal(chat.draft.text, 'hold', 'cancelling preserves a new draft even when its text is identical to the submitted prompt');
    const savedSession = chat.session.snapshot().record.sessionId;
    await conversations.handle(chat, { type: 'disconnect' });
    await conversations.handle(chat, { type: 'connect', profileId: 'fixture', resume: true });
    assert.equal(chat.session.snapshot().record.sessionId, savedSession);
    assert.equal((await journal()).filter((row) => row.method === 'session/prompt').length, 3, 'resume never resends a prompt');
    await conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('session-updates') });
    assert.equal(chat.session.snapshot().controls.title, '测试会话标题');
    assert.equal(chat.session.snapshot().controls.usage.used, 1200);
    assert(
      chat.session.snapshot().record.messages.some((item) => item.role === 'thought'),
      'the packaged host retains streamed thoughts',
    );
    await workbench.open(fixture.root);
    assert.equal(chat.binding.taskId, newTask.id, 'workbench navigation does not retarget the conversation');
    assert.equal(chat.session.snapshot().status, 'connected');
    chat.panel.dispose();
    const gitFile = path.join(chat.binding.workspace, '.git');
    await fs.copyFile(gitFile, `${gitFile}.replacement`);
    await fs.rename(`${gitFile}.replacement`, gitFile);
    await conversations.show(fixture.root, newTask.id);
    assert(chat.panel, 'a replaced checkout still allows reopening the original connection to stop it');
    assert.equal(chat.session.snapshot().status, 'connected');
    await assert.rejects(conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('wrong allocation') }), /工作区已被替换/);
    await conversations.handle(chat, { type: 'disconnect' });
    await conversations.show(fixture.root, newTask.id);
    const replacement = [...conversations.entries.values()].find((entry) => entry.binding.taskId === newTask.id);
    assert.notEqual(replacement, chat, 'reopening a disconnected replaced allocation creates a fresh binding');
    assert.equal(replacement.session.snapshot().record.sessionId, undefined);
    assert.equal((await state()).workflow.changes.find((task) => task.id === newTask.id).deliveries?.length ?? 0, 0, 'ACP responses never deliver code');
    console.log(
      'Packaged extension passed: branch following and restoration, native readonly review, version guards, preview/setup, normal hooks, recovery, multiline delivery, fresh workspaces, history mapping and task-bound ACP commands, permissions, cancellation and explicit resume',
    );
  } finally {
    await workbench.close();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};
