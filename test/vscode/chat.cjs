const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { checkAgentPresets, checkAgentSetup } = require('./agent-setup.cjs');

const checkChats = async (workbench, extension, fixture, eventually) => {
  const connected = async (entry) => {
    try {
      // Session startup and restoration include Git validation and process cleanup on Windows.
      await eventually(() => entry.session.snapshot().status === 'connected', 30_000);
    } catch (error) {
      const snapshot = entry.session.snapshot();
      throw new Error(
        `Task chat did not connect: ${JSON.stringify({ status: snapshot.status, error: entry.error ?? snapshot.error, connecting: !!entry.connecting })}`,
        { cause: error },
      );
    }
  };
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
  const reported = [];
  const report = workbench.output.error;
  assert.equal(typeof workbench.output.logLevel, 'number', 'Warden uses the native log channel with level controls');
  workbench.output.error = (error) => {
    reported.push(String(error));
    report.call(workbench.output, error);
  };
  await Promise.all([conversations.show(fixture.root, newTask.id), conversations.show(fixture.root, newTask.id)]);
  const chat = [...conversations.entries.values()].find((entry) => entry.binding.taskId === newTask.id);
  const journal = () => fs.readFile(fixture.journal, 'utf8').then((text) => text.trim().split('\n').map(JSON.parse));
  assert.equal(chat?.surface?.location, 'sidebar', 'task command opens the sidebar conversation');
  assert(conversations.sidebar.visible, 'task chat is visible without opening an editor');
  assert.equal(chat.panel, undefined);
  assert.equal(chat.draft.text, '', 'new task chats start with an empty composer');
  await conversations.handle(chat, { type: 'insert-brief' });
  assert.match(chat.draft.text, /# Task chat/);
  assert(!chat.draft.text.includes(chat.binding.workspace), 'task context omits the workspace path already bound to the session');
  await eventually(() => chat.surface.ready);
  const settingsOpening = conversations.handle(chat, { type: 'configure' });
  await settingsOpening;
  await eventually(() => workbench.settings.view.visible);
  assert.equal(workbench.agentSetup.picker, undefined, 'chat configuration reveals Settings before choosing a preset');
  assert.equal(workbench.views.panels.has('settings'), false, 'chat and sidebar use the native Settings view');
  assert(extension.packageJSON.contributes.viewsContainers.secondarySidebar.some((item) => item.id === 'warden-chat'));
  const edit = (text) => {
    const current = chat.draft.snapshot();
    return { text, version: current.draftVersion, revision: current.draftRevision + 1 };
  };
  await connected(chat);
  assert.equal(conversations.defaultProfileId(), 'fixture', 'new chats use the verified agent, not settings order');
  assert.equal(chat.session.snapshot().record.profileId, 'fixture');
  await assert.rejects(conversations.handle(chat, { type: 'connect', profileId: 'other', resume: false }), /The agent changed/);
  assert.equal((await journal()).filter((row) => row.method === 'session/new').length, 1, 'repeated opens create only one session');
  assert.equal((await journal()).filter((row) => row.method === 'session/prompt').length, 0, 'opening a panel never sends its draft');
  await fs.writeFile(path.join(chat.binding.workspace, 'context.txt'), 'Task context\n');
  await conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('own-edit') });
  assert.match(await fs.readFile(path.join(chat.binding.workspace, 'agent-output.txt'), 'utf8'), /^Task context edited by /);
  await assert.rejects(fs.access(path.join(fixture.root, 'agent-output.txt')));
  await assert.rejects(fs.access(path.join(preview.worktree, 'agent-output.txt')));
  await conversations.handle(chat, { type: 'open-file', reference: 'agent-output.txt:1' });
  assert(
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.label.includes('agent-output.txt')),
    'a task file reference opens its native reviewed diff',
  );
  await conversations.handle(chat, { type: 'open-file', reference: 'README.md#L1' });
  assert.equal(vscode.window.activeTextEditor.document.uri.scheme, 'warden-review', 'unchanged task files open as readonly snapshots');
  await assert.rejects(conversations.handle(chat, { type: 'open-file', reference: '../fixture.json' }), /inside this task workspace/);
  await assert.rejects(
    conversations.handle(chat, { type: 'open-file', reference: 'command:workbench.action.closeWindow' }),
    /Invalid workspace file reference/,
  );
  const initialized = (await journal()).find((row) => row.method === 'initialize');
  assert.deepEqual(initialized.params.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    _meta: { terminal_output_delta: true },
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
  void asking.catch(() => {});
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
  await connected(otherChat);
  assert.equal(
    otherChat.session.snapshot().controls.configOptions.find((option) => option.id === 'model').currentValue,
    'deep',
    'new tasks reuse the profile model preference',
  );
  await conversations.handle(otherChat, { type: 'set-config', configId: 'model', value: 'fast' });
  await eventually(() => otherChat.surface.ready);
  await conversations.expand();
  assert(otherChat.panel);
  const editorSession = otherChat.session.snapshot().record.sessionId;
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(fixture.root, 'README.md')), { viewColumn: otherChat.panel.viewColumn });
  await eventually(() => !otherChat.panel.visible);
  await conversations.handle(otherChat, { type: 'disconnect' });
  otherChat.panel.reveal(otherChat.panel.viewColumn);
  await connected(otherChat);
  assert.equal(otherChat.session.snapshot().record.sessionId, editorSession, 'revealing the existing editor resumes its session');
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
  void held.catch(() => {});
  await eventually(async () => (await journal()).some((row) => row.method === 'session/prompt' && row.params.prompt[0].text === 'hold'));
  await conversations.handle(chat, { type: 'draft', ...edit('hold') });
  await conversations.handle(chat, { type: 'cancel' });
  await held;
  assert.equal(chat.draft.text, 'hold', 'cancelling preserves a new draft even when its text is identical to the submitted prompt');
  const savedSession = chat.session.snapshot().record.sessionId;
  await conversations.handle(chat, { type: 'disconnect' });
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await eventually(() => !conversations.sidebar.visible);
  await vscode.commands.executeCommand('warden.taskChat.focus');
  await connected(chat);
  assert.equal(chat.session.snapshot().record.sessionId, savedSession);
  assert.equal(
    chat.session.snapshot().controls.configOptions.find((option) => option.id === 'model').currentValue,
    'deep',
    'resuming keeps this task model despite a changed profile default',
  );
  assert.equal(chat.draft.text, 'hold', 'automatic resume preserves the unsent draft');
  assert.equal((await journal()).filter((row) => row.method === 'session/load' && row.cwd === chat.binding.workspace).length, 1);
  assert.equal((await journal()).filter((row) => row.method === 'session/prompt').length, 3, 'resume never resends a prompt');
  await conversations.handle(chat, { type: 'disconnect' });
  await conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('session-updates') });
  assert.equal(chat.session.snapshot().record.sessionId, savedSession, 'sending after disconnect resumes the original session');
  assert.equal(chat.session.snapshot().controls.title, '测试会话标题');
  assert.equal(chat.session.snapshot().controls.usage.used, 1200);
  assert(
    chat.session.snapshot().record.messages.some((item) => item.role === 'thought'),
    'the packaged host retains streamed thoughts',
  );
  await workbench.open(fixture.root);
  assert.equal(chat.binding.taskId, newTask.id, 'workbench navigation does not retarget the conversation');
  assert.equal(chat.session.snapshot().status, 'connected');
  await conversations.handle(chat, { type: 'new' });
  assert.equal(chat.session.snapshot().status, 'connected', 'an explicit new conversation also connects automatically');
  assert.notEqual(chat.session.snapshot().record.sessionId, savedSession);
  assert.equal(
    chat.session.snapshot().controls.configOptions.find((option) => option.id === 'model').currentValue,
    'fast',
    'explicit new sessions use the latest profile model preference',
  );
  await conversations.show(fixture.root, otherTask.id);
  const otherSession = otherChat.session.snapshot().record.sessionId;
  await conversations.handle(otherChat, { type: 'draft', text: 'Saved across reopening', version: 0, revision: 1 });
  await conversations.release(otherChat);
  await otherChat.session.close();
  await otherChat.draftSave;
  conversations.entries.delete(conversations.key(fixture.root, otherTask.id));
  await conversations.show(fixture.root, otherTask.id);
  const restoredChat = conversations.sidebarEntry;
  await connected(restoredChat);
  assert.notEqual(restoredChat, otherChat, 'reopening reads a fresh conversation object from saved state');
  assert.equal(restoredChat.session.snapshot().record.sessionId, otherSession, 'saved sessions restore automatically');
  assert.equal(
    restoredChat.session.snapshot().controls.configOptions.find((option) => option.id === 'model').currentValue,
    'fast',
    'reopening restores the saved task model',
  );
  assert.equal(restoredChat.draft.text, 'Saved across reopening');
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
  await connected(replacement);
  assert.notEqual(replacement.session.snapshot().record.sessionId, chat.session.snapshot().record.sessionId);
  const interruptedSession = replacement.session.snapshot().record.sessionId;
  const replacementDraft = replacement.draft.snapshot();
  await conversations
    .handle(replacement, {
      type: 'send',
      profileId: 'fixture',
      text: 'crash',
      version: replacementDraft.draftVersion,
      revision: replacementDraft.draftRevision + 1,
    })
    .catch(() => {});
  await eventually(() => replacement.session.snapshot().status === 'error');
  await conversations.show(fixture.root, newTask.id);
  await connected(replacement);
  assert.equal(replacement.session.snapshot().record.sessionId, interruptedSession, 'reopening a failed session resumes without a manual disconnect');
  assert.equal(replacement.draft.text, 'crash');
  assert(
    reported.some((entry) => entry.includes(`[ACP Task Chat]`) && entry.includes(`task=${newTask.id}`) && /(?:process|session\/prompt) failed/.test(entry)),
    'task connection failures reach the native Warden log channel',
  );
  const logFile = path.join(workbench.context.logUri.fsPath, 'Warden.log');
  await eventually(async () => {
    const output = await fs.readFile(logFile, 'utf8');
    return output.includes('"event":"acp.failure"') && output.includes(`"task":"${newTask.id}"`);
  });
  const logs = await fs.readFile(logFile, 'utf8');
  assert(logs.includes('"event":"acp.turn.end"'), 'the native channel persists successful and failed turn outcomes');
  if (workbench.output.logLevel === vscode.LogLevel.Info)
    assert(!logs.includes('"event":"acp.update"'), 'streaming trace metadata does not flood the default log level');
  assert.equal(
    (await journal()).filter((row) => row.method === 'session/prompt' && row.params.prompt[0].text === 'crash').length,
    1,
    'automatic recovery never replays the interrupted prompt',
  );
  assert.equal(
    (await workbench.backend.execute('workflow.get', undefined)).workflow.changes.find((task) => task.id === newTask.id).deliveries?.length ?? 0,
    0,
    'ACP responses never deliver code',
  );

  const externalJournal = `${fixture.journal}.external`;
  const externalAgent = { ...selectedAgent, id: 'external', args: [fixture.agent, externalJournal, 'auth-external'] };
  await fs.writeFile(`${externalJournal}.auth`, 'fixture login');
  await configuration.update('acpAgents', [otherAgent, selectedAgent, externalAgent], vscode.ConfigurationTarget.Global);
  await workbench.agentSetup.check(externalAgent.id);
  assert.equal(workbench.agentSetup.readiness.snapshot().status, 'ready');
  await fs.rm(`${externalJournal}.auth`);
  const externalTask = await workbench.backend.execute('task.create', { title: 'External login' });
  await conversations.show(fixture.root, externalTask.id);
  const externalChat = conversations.sidebarEntry;
  await eventually(() => externalChat.session.snapshot().status === 'error');
  assert.equal(externalChat.session.snapshot().authMethods[0].id, 'login');
  const externalRecord = externalChat.session.snapshot().record.id;
  const externalDraft = externalChat.draft.text;
  await fs.writeFile(`${externalJournal}.auth`, 'fixture login');
  await conversations.handle(externalChat, { type: 'connect', profileId: externalAgent.id, resume: false });
  assert.equal(externalChat.session.snapshot().status, 'connected');
  assert.equal(externalChat.session.snapshot().record.id, externalRecord);
  assert.equal(externalChat.draft.text, externalDraft);
  assert.deepEqual(externalChat.session.snapshot().authMethods, []);
  const externalRequests = (await fs.readFile(externalJournal, 'utf8')).trim().split('\n').map(JSON.parse);
  assert(!externalRequests.some((row) => ['authenticate', 'session/prompt'].includes(row.method)), 'external login reconnect starts no login flow or prompt');
  const missingJournal = `${fixture.journal}.missing`;
  const missingAgent = { ...selectedAgent, id: 'missing', args: [fixture.agent, missingJournal, 'missing-rollout'] };
  await configuration.update('acpAgents', [selectedAgent, missingAgent], vscode.ConfigurationTarget.Global);
  await workbench.agentSetup.check(missingAgent.id);
  const emptyTask = await workbench.backend.execute('task.create', { title: 'Unpersisted empty session' });
  await conversations.show(fixture.root, emptyTask.id);
  const emptyChat = conversations.sidebarEntry;
  await connected(emptyChat);
  const emptyRecord = emptyChat.session.snapshot().record;
  const emptyDraft = emptyChat.draft.text;
  await conversations.handle(emptyChat, { type: 'disconnect' });
  await conversations.show(fixture.root, emptyTask.id);
  assert(conversations.sidebarEntry === emptyChat, 'reopening an unchanged allocation keeps its conversation entry');
  try {
    // Recovery validates the workspace and performs both session/load and session/new.
    await eventually(() => emptyChat.session.snapshot().status === 'connected', 30_000);
  } catch (error) {
    const snapshot = emptyChat.session.snapshot();
    throw new Error(
      `Empty-session recovery did not connect: ${JSON.stringify({ status: snapshot.status, error: emptyChat.error ?? snapshot.error, connecting: !!emptyChat.connecting })}`,
      { cause: error },
    );
  }
  assert.equal(emptyChat.session.snapshot().record.id, emptyRecord.id);
  assert.notEqual(emptyChat.session.snapshot().record.sessionId, emptyRecord.sessionId);
  assert.equal(emptyChat.draft.text, emptyDraft, 'recreating an unpersisted empty session retains the task draft');
  assert.deepEqual(emptyChat.session.snapshot().authMethods, []);
  const emptyRequests = (await fs.readFile(missingJournal, 'utf8')).trim().split('\n').map(JSON.parse);
  assert(!emptyRequests.some((row) => ['authenticate', 'session/prompt'].includes(row.method)), 'empty-session recovery starts no login flow or prompt');
  workbench.output.error = report;
};
exports.checkChats = checkChats;

// A focused packaged-host entry point for agent setup and conversation changes.
exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const extension = vscode.extensions.getExtension('xbghc.warden');
  const workbench = await extension.activate();
  const eventually = async (condition, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
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
