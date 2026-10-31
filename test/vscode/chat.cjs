const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { checkAgentPresets, checkAgentSetup } = require('./agent-setup.cjs');

const checkChats = async (workbench, extension, fixture, eventually) => {
  const newTask = await workbench.backend.execute('task.create', { title: 'Task chat' });
  await workbench.refresh(true);
  const preview = await workbench.backend.execute('preview.refresh', undefined);
  console.log('Checking task chats in the sidebar and editors');
  // Exercise the bundled ACP host through its command, configured profile and panel action boundary.
  const configuration = vscode.workspace.getConfiguration('warden');
  const selectedAgent = { id: 'fixture', label: 'Test agent', command: fixture.node, args: [fixture.agent, fixture.journal, 'controls'] };
  const otherAgent = { ...selectedAgent, id: 'other', label: 'Other agent', args: [fixture.agent, `${fixture.journal}.other`, 'controls'] };
  await configuration.update('acpAgents', [otherAgent, selectedAgent], vscode.ConfigurationTarget.Global);
  await workbench.agentSetup.check(selectedAgent.id);
  assert.equal(workbench.agentSetup.readiness.snapshot().status, 'ready');
  await fs.rm(fixture.journal, { force: true });
  await fs.rm(`${fixture.journal}.history`, { force: true });
  const chatTask = (await workbench.getChildren()).find((row) => row.task.id === newTask.id);
  await vscode.commands.executeCommand('warden.chat', chatTask);
  const conversations = workbench.conversations;
  const chat = [...conversations.entries.values()].find((entry) => entry.binding.taskId === newTask.id);
  assert.equal(chat?.surface?.location, 'sidebar', 'task command opens the sidebar conversation');
  assert(conversations.sidebar.visible, 'task chat is visible without opening an editor');
  assert.equal(chat.panel, undefined);
  await eventually(() => chat.surface.ready);
  workbench.views.panels.get('settings')?.dispose();
  await eventually(() => !workbench.views.panels.has('settings'));
  const settingsOpening = conversations.handle(chat, { type: 'configure' });
  await eventually(() => workbench.views.panels.has('settings') || !!workbench.agentSetup.picker);
  const directPicker = workbench.agentSetup.picker;
  directPicker?.hide();
  await settingsOpening;
  assert.equal(directPicker, undefined, 'chat settings opens the shared Settings panel before choosing a preset');
  assert(workbench.views.panels.get('settings')?.visible, 'chat and sidebar use the same Warden Settings panel');
  workbench.views.panels.get('settings').dispose();
  assert(extension.packageJSON.contributes.viewsContainers.secondarySidebar.some((item) => item.id === 'warden-chat'));
  const edit = (text) => {
    const current = chat.draft.snapshot();
    return { text, version: current.draftVersion, revision: current.draftRevision + 1 };
  };
  assert.equal(chat.session.snapshot().status, 'disconnected');
  assert.equal(conversations.defaultProfileId(), 'fixture', 'new chats use the verified agent, not settings order');
  await assert.rejects(conversations.handle(chat, { type: 'connect', profileId: 'other', resume: false }), /The agent changed/);
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
  await workbench.agentSetup.check(otherAgent.id);
  assert.equal(conversations.defaultProfileId(), 'other');
  assert.equal(conversations.conversationProfile(chat, 'fixture').id, 'fixture', 'existing sessions retain their agent after setup changes');
  await workbench.agentSetup.check(selectedAgent.id);
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
  const previousSurface = chat.surface;
  const otherTask = await workbench.backend.execute('task.create', { title: 'Concurrent chat' });
  const savedDraft = edit('Keep this task draft');
  await conversations.handle(chat, { type: 'draft', ...savedDraft });
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await eventually(() => !conversations.sidebar.visible);
  await conversations.show(fixture.root, otherTask.id);
  const otherChat = conversations.sidebarEntry;
  assert.equal(otherChat.binding.taskId, otherTask.id);
  assert.equal(chat.surface, undefined);
  assert.equal(chat.session.snapshot().status, 'waiting_permission', 'switching does not stop the background turn');
  assert.equal(conversations.activity(fixture.root, newTask.id), 'Agent: Permission Required');
  await conversations.receive(otherChat, otherChat.surface, {
    type: 'acp-action',
    panelId: previousPanel,
    action: { type: 'permission', requestId: permission.id, optionId: 'allow-once' },
  });
  await conversations.receive(chat, previousSurface, {
    type: 'acp-action',
    panelId: previousPanel,
    action: { type: 'draft', ...savedDraft, text: 'Late stale draft', revision: savedDraft.revision + 1 },
  });
  assert.equal(chat.session.snapshot().permissions.length, 1, 'a stale view cannot answer a permission after switching');
  assert.equal(chat.draft.text, 'Keep this task draft', 'queued messages cannot overwrite the old task draft');
  assert.equal(otherChat.session.snapshot().status, 'disconnected');
  await eventually(() => otherChat.surface.ready);
  await conversations.expand();
  assert(otherChat.panel);
  await conversations.show(fixture.root, newTask.id);
  assert.equal(chat.draft.text, 'Keep this task draft');
  await eventually(() => chat.surface.ready);
  await vscode.commands.executeCommand('warden.expandChat');
  assert.equal(chat.surface.location, 'editor');
  assert(chat.panel, 'expanding creates a native editor webview');
  assert(otherChat.panel, 'different tasks can keep separate editor chats');
  assert.equal(conversations.sidebarEntry, undefined, 'a task has only one editable chat surface');
  const expandedSession = chat.session.snapshot().record.sessionId;
  await eventually(() => chat.surface.ready);
  await conversations.handle(chat, { type: 'open-sidebar' });
  assert.equal(chat.panel, undefined);
  assert.equal(chat.surface.location, 'sidebar');
  assert.equal(chat.session.snapshot().record.sessionId, expandedSession, 'moving a chat does not reconnect');
  assert.equal((await journal()).filter((row) => row.method === 'initialize' && row.cwd === chat.binding.workspace).length, 1);
  if (process.env.WARDEN_VSCODE_SCREENSHOT && process.platform === 'linux') {
    await eventually(() => chat.surface.ready);
    await new Promise((resolve) => setTimeout(resolve, 500));
    execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', process.env.WARDEN_VSCODE_SCREENSHOT.replace('.png', '-chat.png')]);
  }

  await conversations.handle(chat, { type: 'draft', ...edit('permission') });
  assert.notEqual(chat.panelId, previousPanel, 'reopening retains the running session in a fresh panel');
  await conversations.handle(chat, { type: 'permission', requestId: permission.id, optionId: 'reject-once' });
  await asking;
  assert.equal(chat.draft.text, 'permission', 'completion preserves a new draft typed during a view move');
  assert.match(
    await fs.readFile(path.join(chat.binding.workspace, 'agent-output.txt'), 'utf8'),
    /^Task context edited by /,
    'rejection does not authorize the requested edit',
  );
  const typedDraft = edit('Edited task');
  await conversations.handle(chat, { type: 'draft', ...typedDraft });
  await conversations.append(fixture.root, newTask.id, 'Selected source');
  assert.equal(chat.draft.text, 'Edited task\n\nSelected source');
  await assert.rejects(conversations.handle(chat, { type: 'send', profileId: 'fixture', ...typedDraft }), /The draft was updated/);
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
  await conversations.show(fixture.root, otherTask.id);
  const gitFile = path.join(chat.binding.workspace, '.git');
  await fs.copyFile(gitFile, `${gitFile}.replacement`);
  await fs.rename(`${gitFile}.replacement`, gitFile);
  await conversations.show(fixture.root, newTask.id);
  assert.equal(chat.surface.location, 'sidebar', 'a replaced checkout still allows reopening the original connection to stop it');
  assert.equal(chat.session.snapshot().status, 'connected');
  await assert.rejects(conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('wrong allocation') }), /was replaced/);
  await conversations.handle(chat, { type: 'disconnect' });
  await conversations.show(fixture.root, newTask.id);
  const replacement = [...conversations.entries.values()].find((entry) => entry.binding.taskId === newTask.id);
  assert.notEqual(replacement, chat, 'reopening a disconnected replaced allocation creates a fresh binding');
  assert.equal(replacement.session.snapshot().record.sessionId, undefined);
  assert.equal(
    (await workbench.backend.execute('workflow.get', undefined)).workflow.changes.find((task) => task.id === newTask.id).deliveries?.length ?? 0,
    0,
    'ACP responses never deliver code',
  );
};
exports.checkChats = checkChats;

// A focused packaged-host entry point for agent setup and conversation changes.
exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const extension = vscode.extensions.getExtension('xbghc.warden');
  const workbench = await extension.activate();
  const eventually = async (condition) => {
    const deadline = Date.now() + 15_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for task chat state');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    await workbench.open(fixture.unconfigured);
    await checkAgentSetup(workbench, extension, fixture, eventually);
    await checkAgentPresets(workbench, fixture, eventually);
    await workbench.open(fixture.root);
    await checkAgentSetup(workbench, extension, fixture, eventually);
    await checkChats(workbench, extension, fixture, eventually);
    console.log(
      'Packaged agent flows passed: preset configuration, cancellation, profile preservation, sidebar placement, editor transfers, background permissions, stale routing, draft preservation and same-session reuse.',
    );
  } finally {
    await workbench.close();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};
