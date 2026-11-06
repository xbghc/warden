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
  // Task processes are ended from Settings › Agent Processes; the chat webview has no disconnect action.
  const processRows = () => workbench.settings.getChildren()[0].children.find((row) => row.id === 'agent-processes').children ?? [];
  const processRow = (entry) => processRows().find((row) => row.process?.kind === 'task' && row.process.binding.identity === entry.binding.identity);
  const endProcess = async (entry) => {
    const row = processRow(entry);
    assert(row, 'a live task chat appears under Settings › Agent Processes');
    await vscode.commands.executeCommand('warden.endAgentProcess', row);
    assert.equal(entry.session.snapshot().status, 'disconnected');
    assert.equal(processRow(entry), undefined, 'an ended process leaves the list');
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
  // Renaming a task with a live conversation updates its process row in place.
  const renaming = vscode.commands.executeCommand('warden.renameTask', chatTask);
  await eventually(() => !!workbench.renameInput);
  workbench.renameInput.value = 'Renamed chat task';
  await eventually(async () => {
    if (!workbench.renameInput) return true;
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    return !workbench.renameInput;
  });
  await renaming;
  assert.equal(chat.binding.title, 'Renamed chat task', 'a rename updates the live conversation title');
  const acpRow = workbench.settings.getChildren().find((node) => node.id === 'acp');
  const renamedRows = workbench.settings.getChildren(acpRow).find((node) => node.id === 'agent-processes')?.children ?? [];
  assert(
    renamedRows.some((row) => row.label === 'Renamed chat task'),
    'Agent Processes shows the renamed task',
  );
  assert.equal(conversations.defaultProfileId(), 'fixture', 'new chats use the verified agent, not settings order');
  assert.equal(chat.session.snapshot().record.profileId, 'fixture');
  await assert.rejects(conversations.handle(chat, { type: 'connect', profileId: 'other', resume: false }), /The agent changed/);
  assert.equal((await journal()).filter((row) => row.method === 'session/new').length, 1, 'repeated opens create only one session');
  const environment = (await journal()).find((row) => row.method === 'session/new').params.systemPrompt;
  assert.equal(environment.mode, 'append', 'task context preserves the agent default instructions');
  assert.equal(environment.content.length, 1);
  assert.equal(chat.binding.baseBranch, newTask.developmentBranch);
  for (const value of [chat.binding.workspace, fixture.root, chat.binding.branch, newTask.developmentBranch])
    assert(environment.content[0].text.includes(JSON.stringify(value)), 'the shipped host supplies the task assignment');
  assert(!environment.content[0].text.includes('Task chat'), 'user-authored task text is not promoted to system instructions');
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
  console.log('Checking automatic repository read approvals');
  const readRoots = await workbench.backend.execute('repository.readRoots', undefined);
  assert(readRoots.some((root) => root.path === fixture.root));
  assert(readRoots.some((root) => root.path === chat.binding.workspace));
  assert(readRoots.some((root) => root.path === preview.worktree));
  assert(readRoots.length >= 4, 'the scope includes another allocated task');
  let readPrompts = 0;
  for (const root of readRoots) {
    await chat.session.send(`read-permission ${JSON.stringify({ path: path.join(root.path, 'README.md') })}`);
    ++readPrompts;
    assert.match(chat.session.snapshot().record.messages.at(-1).text, /"optionId":"read-once"/);
    assert.equal(chat.session.snapshot().permissions.length, 0);
  }
  await configuration.update('acpAutoApproveReads', false, vscode.ConfigurationTarget.Global);
  await assert.rejects(configuration.update('acpAutoApproveReads', true, vscode.ConfigurationTarget.Workspace), /only into User settings/);
  try {
    const read = chat.session.send(`read-permission ${JSON.stringify({ path: path.join(fixture.root, 'README.md') })}`);
    ++readPrompts;
    await eventually(() => chat.session.snapshot().permissions.length === 1);
    assert.equal(chat.session.snapshot().status, 'waiting_permission', 'workspace settings cannot override the user read policy');
    await chat.session.respondPermission(chat.session.snapshot().permissions[0].id, 'reject-read');
    await read;
  } finally {
    await configuration.update('acpAutoApproveReads', undefined, vscode.ConfigurationTarget.Global);
  }
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
  await endProcess(otherChat);
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
  await endProcess(chat);
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
  assert.equal((await journal()).filter((row) => row.method === 'session/prompt').length, 3 + readPrompts, 'resume never resends a prompt');
  await endProcess(chat);
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
  // Clone workspaces hold a `.git` directory, linked worktrees a `.git` file; both get a new identity.
  await fs.cp(gitFile, `${gitFile}.replacement`, { recursive: true });
  await fs.rm(gitFile, { recursive: true, force: true });
  await fs.rename(`${gitFile}.replacement`, gitFile);
  await conversations.show(fixture.root, newTask.id);
  assert.equal(chat.surface.location, 'sidebar', 'a replaced checkout still allows reopening the original connection to stop it');
  assert.equal(chat.session.snapshot().status, 'connected');
  await assert.rejects(conversations.handle(chat, { type: 'send', profileId: 'fixture', ...edit('wrong allocation') }), /was replaced/);
  await endProcess(chat);
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

  console.log('Checking visible workspace context with an agent without system prompt support');
  const fallbackJournal = `${fixture.journal}.context-fallback`;
  const fallbackAgent = { ...selectedAgent, id: 'context-fallback', args: [fixture.agent, fallbackJournal, 'no-system-prompt'] };
  await configuration.update('acpAgents', [selectedAgent, otherAgent, fallbackAgent], vscode.ConfigurationTarget.Global);
  await workbench.agentSetup.check(fallbackAgent.id);
  const fallbackTask = await workbench.backend.execute('task.create', { title: 'Context fallback' });
  await conversations.show(fixture.root, fallbackTask.id);
  const fallbackChat = conversations.sidebarEntry;
  await connected(fallbackChat);
  const fallbackWire = () => fs.readFile(fallbackJournal, 'utf8').then((text) => text.trim().split('\n').map(JSON.parse));
  assert(!(await fallbackWire()).some((row) => row.method === 'session/prompt'), 'fallback setup sends no work prompt');
  const fallbackDraft = fallbackChat.draft.snapshot();
  await conversations.handle(fallbackChat, {
    type: 'send',
    profileId: fallbackAgent.id,
    text: 'Explain this workspace',
    version: fallbackDraft.draftVersion,
    revision: fallbackDraft.draftRevision + 1,
  });
  const fallbackPrompt = (await fallbackWire()).find((row) => row.method === 'session/prompt').params.prompt;
  assert.equal(fallbackPrompt[0].text, 'Explain this workspace');
  assert.match(fallbackPrompt[1].text, /provided by Warden as user-level context/);
  assert(fallbackPrompt[1].text.includes(JSON.stringify(fallbackChat.binding.workspace)));
  const fallbackText = fallbackPrompt.map((block) => block.text).join('');
  assert.equal(fallbackChat.session.snapshot().record.messages.find((message) => message.role === 'user').text, fallbackText);
  assert.equal(fallbackChat.draft.text, '', 'automatic context does not alter the composer draft');
  await endProcess(fallbackChat);
  await conversations.show(fixture.root, fallbackTask.id);
  await connected(fallbackChat);
  assert.equal(fallbackChat.session.snapshot().record.messages.find((message) => message.role === 'user').text, fallbackText);
  for (const row of (await fallbackWire()).filter((row) => row.method === 'session/new' || row.method === 'session/load'))
    assert.equal(row.params.systemPrompt, undefined, 'unsupported agents never receive the draft field');
  assert.equal((await fallbackWire()).filter((row) => row.method === 'session/prompt').length, 1, 'restoration does not replay work');

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
  // Authentication errors follow the same Git validation and process startup as successful connections.
  await eventually(() => externalChat.session.snapshot().status === 'error', 30_000);
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
  await endProcess(emptyChat);
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

  const workbenchProcess = processRows().find((row) => row.process?.kind === 'workbench');
  assert.equal(workbenchProcess?.process.pid, workbench.agentSetup.readiness.process().pid, 'the workbench connection is listed with its PID');
  const emptyProcess = processRow(emptyChat);
  assert.equal(emptyProcess.label, 'Unpersisted empty session');
  assert.match(emptyProcess.description, / · Idle · PID \d+$/);
  assert.equal(emptyProcess.contextValue, 'wardenAgentProcess');
  const confirmEnd = workbench.confirmProcessEnd;
  const confirmations = [];
  let acceptEnd = false;
  workbench.confirmProcessEnd = async (title, button) => {
    confirmations.push(title);
    return acceptEnd ? button : undefined;
  };
  try {
    const draft = emptyChat.draft.snapshot();
    const holding = conversations.handle(emptyChat, {
      type: 'send',
      profileId: emptyChat.session.snapshot().record.profileId,
      text: 'hold',
      version: draft.draftVersion,
      revision: draft.draftRevision + 1,
    });
    void holding.catch(() => {});
    await eventually(async () => (await fs.readFile(missingJournal, 'utf8')).includes('"session/prompt"'));
    await eventually(() => processRow(emptyChat)?.description.includes('Responding'));
    await vscode.commands.executeCommand('warden.endAgentProcess', processRow(emptyChat));
    assert.deepEqual(confirmations, ['Unpersisted empty session'], 'ending a responding process asks first');
    assert.equal(emptyChat.session.snapshot().status, 'running', 'declining keeps the responding process');
    acceptEnd = true;
    const ending = processRow(emptyChat);
    await vscode.commands.executeCommand('warden.endAgentProcess', ending);
    await holding.catch(() => {});
    assert.equal(emptyChat.session.snapshot().status, 'disconnected');
    assert.equal(emptyChat.session.snapshot().record.interrupted, true, 'ending mid-response marks the turn interrupted');
    assert.equal(processRow(emptyChat), undefined);
    // This fixture cannot load a prompted session, so a new session starts the replacement process.
    await conversations.handle(emptyChat, { type: 'new' });
    await connected(emptyChat);
    // A row captured before reconnecting must not end the replacement process.
    await vscode.commands.executeCommand('warden.endAgentProcess', ending);
    assert.equal(emptyChat.session.snapshot().status, 'connected', 'a stale row cannot end a newer process');
    assert.notEqual(processRow(emptyChat).process.pid, ending.process.pid);
    // Task processes keep their own connections, so they stay controllable after Disconnect ACP.
    const workbenchProfile = workbench.agentSetup.readiness.snapshot().profile?.id;
    await workbench.agentSetup.disconnect();
    assert.notEqual(workbench.agentSetup.readiness.snapshot().status, 'ready');
    await endProcess(emptyChat);
    assert.equal(confirmations.length, 2, 'idle processes end without confirmation');
    await workbench.agentSetup.check(workbenchProfile);
    assert.equal(workbench.agentSetup.readiness.snapshot().status, 'ready');
  } finally {
    workbench.confirmProcessEnd = confirmEnd;
  }
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
