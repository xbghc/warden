const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

exports.checkBranchChats = async (workbench, root, eventually) => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const configuration = vscode.workspace.getConfiguration('warden');
  const profiles = configuration.inspect('acpAgents').globalValue;
  const conversations = workbench.conversations;
  const previousProfile = conversations.defaultProfileId();
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const originalBranch = git('branch', '--show-current');
  const follow = (branch) => {
    const checkoutBranch = git('branch', '--show-current') || undefined;
    return eventually(
      () => workbench.data?.workflow?.developmentBranch === branch && workbench.checkoutBranch === checkoutBranch && !workbench.branchTransition,
      30_000,
    );
  };
  const profile = { id: 'branch-chat', label: 'Branch chat fixture', command: fixture.node, args: [fixture.agent, `${fixture.journal}.branches`] };
  const journal = async () => (await fs.readFile(profile.args[1], 'utf8')).trim().split('\n').map(JSON.parse);
  const history = (entry) => entry.session.snapshot().record.messages.map(({ role, text }) => ({ role, text }));
  const edit = (entry, text) => {
    const draft = entry.draft.snapshot();
    return { text, version: draft.draftVersion, revision: draft.draftRevision + 1 };
  };
  let chat;
  const connected = async () => {
    try {
      // Restoring a session validates Git state and reclaims its connection before loading it.
      await eventually(() => chat.surface?.ready && chat.session.snapshot().status === 'connected', 30_000);
    } catch (error) {
      const snapshot = chat.session.snapshot();
      throw new Error(
        `Branch chat did not connect: ${JSON.stringify({ status: snapshot.status, error: chat.error ?? snapshot.error, connecting: !!chat.connecting })}`,
        { cause: error },
      );
    }
  };
  console.log('Checking running task conversations across primary branch changes');
  try {
    await configuration.update('acpAgents', [profile], vscode.ConfigurationTarget.Global);
    await workbench.agentSetup.check(profile.id);
    git('switch', '-c', 'chat/base');
    await workbench.backend.execute('workflow.configure', { branch: 'chat/base' });
    await follow('chat/base');
    const task = await workbench.backend.execute('task.create', { title: 'Chat on the original branch' });
    await workbench.refresh(true);
    await workbench.selectTask({ kind: 'task', task }, 'select');
    await conversations.show(root, task.id);
    chat = conversations.sidebarEntry;
    await connected();
    const sessionId = chat.session.snapshot().record.sessionId;
    const identity = chat.binding.identity;
    const asking = conversations.handle(chat, { type: 'send', profileId: profile.id, ...edit(chat, 'permission') });
    void asking.catch(() => {});
    await eventually(() => chat.session.snapshot().permissions.length === 1);
    const permission = chat.session.snapshot().permissions[0];
    await conversations.handle(chat, { type: 'draft', ...edit(chat, 'Unsent original-branch follow-up') });

    git('switch', '-c', 'chat/other');
    await workbench.backend.execute('workflow.configure', { branch: 'chat/other' });
    await follow('chat/other');
    const other = await workbench.backend.execute('task.create', { title: 'Another branch task' });
    await workbench.refresh(true);
    await workbench.selectTask({ kind: 'task', task: other }, 'select');
    assert.equal(workbench.selected, other.id);
    assert.equal(conversations.sidebarEntry, chat, 'selecting another requirement never retargets the open conversation');
    assert((await workbench.getChildren()).every((node) => node.task.developmentBranch === 'chat/other'));
    for (const args of [
      ['switch', '-c', 'chat/untracked'],
      ['switch', '--detach'],
    ]) {
      git(...args);
      await follow(undefined);
      assert.deepEqual(await workbench.getChildren(), []);
      assert.equal(chat.session.snapshot().status, 'waiting_permission');
      assert.equal(chat.session.snapshot().permissions[0].id, permission.id);
      assert.equal(chat.session.snapshot().record.sessionId, sessionId);
      assert.equal(chat.draft.text, 'Unsent original-branch follow-up');
      assert.equal(chat.binding.identity, identity);
    }
    await workbench.open(root);
    await follow(undefined);
    assert.equal(chat.session.snapshot().status, 'waiting_permission', 'reopening an inactive workbench retains the live task connection');
    await conversations.handle(chat, { type: 'permission', requestId: permission.id, optionId: 'allow-once' });
    await asking;
    assert.equal(await fs.readFile(path.join(task.worktree, 'agent-output.txt'), 'utf8'), 'Permission granted\n');
    await assert.rejects(fs.access(path.join(root, 'agent-output.txt')));
    await assert.rejects(fs.access(path.join(other.worktree, 'agent-output.txt')));
    assert.equal(chat.draft.text, 'Unsent original-branch follow-up');
    assert.equal((await journal()).filter((row) => row.method === 'session/new' && row.cwd === task.worktree).length, 1);
    const previousHistory = history(chat);

    // Discard the in-memory conversation so this assertion depends on saved records and drafts.
    await conversations.release(chat);
    await chat.session.close();
    await chat.draftSave;
    conversations.entries.delete(conversations.key(root, task.id));
    const previous = chat;
    await conversations.show(root, task.id);
    chat = conversations.sidebarEntry;
    await connected();
    assert.notEqual(chat, previous);
    assert.equal(chat.session.snapshot().record.sessionId, sessionId);
    assert.deepEqual(history(chat), previousHistory);
    assert.equal(chat.draft.text, 'Unsent original-branch follow-up');
    assert.equal((await journal()).filter((row) => row.method === 'session/load' && row.cwd === task.worktree).length, 1);
    assert.equal((await journal()).filter((row) => row.method === 'session/prompt').length, 1, 'branch changes and reopening never resend prompts');
    git('switch', 'chat/base');
    await follow('chat/base');
    assert.equal(workbench.selected, task.id, 'returning restores the selected task independently of the chat');

    const waiting = conversations.handle(chat, { type: 'send', profileId: profile.id, ...edit(chat, 'permission') });
    void waiting.catch(() => {});
    await eventually(() => chat.session.snapshot().permissions.length === 1);
    const invalidPermission = chat.session.snapshot().permissions[0];
    git('-C', task.worktree, 'switch', '-c', 'chat/wrong-task');
    await conversations.show(root, task.id);
    assert.equal(conversations.sidebarEntry, chat, 'an invalid workspace retains the original chat and its stop controls');
    await assert.rejects(
      conversations.handle(chat, { type: 'permission', requestId: invalidPermission.id, optionId: 'allow-once' }),
      /The task workspace changed/,
    );
    await conversations.handle(chat, { type: 'cancel' });
    await waiting;
    await assert.rejects(
      conversations.handle(chat, { type: 'send', profileId: profile.id, ...edit(chat, 'Do not send to another task branch') }),
      /The task workspace changed/,
    );
    assert.equal((await journal()).filter((row) => row.method === 'session/prompt').length, 2);
    assert.equal(chat.draft.text, 'Do not send to another task branch');
    git('-C', task.worktree, 'switch', task.branch);
    await conversations.show(root, task.id);
    await connected();
    assert.equal(chat.session.snapshot().record.sessionId, sessionId, 'restoring the task branch resumes its original session');
    assert.equal(chat.draft.text, 'Do not send to another task branch');
    assert.equal((await journal()).filter((row) => row.method === 'session/prompt').length, 2);
  } finally {
    if (chat) {
      await conversations.release(chat);
      await chat.session.close();
      await chat.draftSave;
      conversations.entries.delete(conversations.key(root, chat.binding.taskId));
    }
    git('switch', originalBranch);
    await follow(originalBranch);
    await configuration.update('acpAgents', profiles, vscode.ConfigurationTarget.Global);
    await workbench.agentSetup.check(previousProfile);
  }
};
