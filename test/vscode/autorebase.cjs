const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const { verifyAgent } = require('./agent-setup.cjs');

// A focused packaged-host entry point for automatic rebase.
exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const workbench = await vscode.extensions.getExtension('xbghc.warden').activate();
  const eventually = async (condition, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for automatic rebase state');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    await verifyAgent(workbench, fixture);
    await workbench.open(fixture.root);
    await exports.checkAutoRebase(workbench, fixture.root, eventually);
    console.log('Packaged automatic rebase passed: idle tasks, uncertain cancellation, queued reservations, once per check, setting off');
  } finally {
    await workbench.close();
  }
};

/** Automatic rebase in the packaged host: idle Can Rebase tasks only, once per check, off by setting. */
exports.checkAutoRebase = async (workbench, root, eventually) => {
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const configuration = vscode.workspace.getConfiguration('warden');
  assert.equal(configuration.get('autoRebase'), false, 'packaged suites start with automatic rebase off');
  const commit = async (cwd, file, text) => {
    await fs.writeFile(path.join(cwd, file), text);
    git(cwd, 'add', '--', file);
    git(cwd, 'commit', '-qm', text.trim());
  };
  const task = async (title, file) => {
    const created = await workbench.backend.execute('task.create', { title });
    await commit(created.worktree, file, `${title}\n`);
    return created;
  };
  const parent = (row) => git(row.worktree, 'rev-parse', 'HEAD^');
  const advance = async (file) => {
    await commit(root, file, `Primary ${file}\n`);
    const head = git(root, 'rev-parse', 'HEAD');
    await workbench.refresh(true);
    return head;
  };
  // Scheduling publishes Unknown placeholders for the new head before the isolated checks finish.
  const checked = (head) =>
    !workbench.checkingRebase &&
    workbench.checks?.checks.length &&
    workbench.checks.checks.every((row) => row.developmentHead === head && row.status !== 'unknown');

  const idle = await task('Idle automatic rebase', 'idle.txt');
  const busy = await task('Busy automatic rebase', 'busy.txt');
  const isBusy = workbench.conversations.isBusy;
  const run = workbench.api;
  const requests = [];
  let liveChat;
  workbench.api = function (command, request) {
    if (command === 'rebase.run') requests.push(request);
    return run.call(this, command, request);
  };
  // Task Chat reports the second task's agent as mid-turn.
  workbench.conversations.isBusy = (repository, taskId) => taskId === busy.id || isBusy.call(workbench.conversations, repository, taskId);
  try {
    await configuration.update('autoRebase', true, vscode.ConfigurationTarget.Global);
    const first = await advance('auto-1.txt');
    // Every eligible task in the repository is rebased in one request; allow for several replays.
    await eventually(() => parent(idle) === first && !workbench.autoRebasing, 120_000).catch((error) => {
      throw new Error(
        `Automatic rebase did not run: ${JSON.stringify({
          first,
          checks: workbench.checks,
          checking: workbench.checkingRebase,
          requests,
          errors: [...workbench.errors.values()],
          ready: workbench.agentReady,
          branch: workbench.branch,
        })}`,
        { cause: error },
      );
    });
    assert.notEqual(parent(busy), first, 'a task with an agent turn in progress is skipped');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].automatic, true, 'automatic requests are marked so an unpredicted conflict is undone');
    const firstIds = requests[0].items.map((item) => item.changeId);
    assert(firstIds.includes(idle.id) && !firstIds.includes(busy.id), 'only idle tasks are requested');
    assert.equal(git(idle.worktree, 'status', '--porcelain'), '', 'automatic rebase leaves the workspace clean');

    // When the turn ends, the skipped task qualifies from the same check; the idle task's
    // check result is never acted on twice.
    await eventually(() => checked(first) && !workbench.autoRebasing, 60_000);
    workbench.conversations.isBusy = isBusy;
    workbench.resumeAutoRebase();
    await eventually(() => parent(busy) === first && !workbench.autoRebasing, 60_000);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests[1].items.map((item) => item.changeId),
      [busy.id],
      'the idle task is not rebased again for an unchanged primary HEAD',
    );

    // Turning the setting off stops automatic rebase on the next primary change.
    await configuration.update('autoRebase', false, vscode.ConfigurationTarget.Global);
    const second = await advance('auto-2.txt');
    await eventually(() => checked(second), 60_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(requests.length, 2, 'disabled automatic rebase sends no request');
    assert.equal(parent(idle), first);
    assert.equal(workbench.checks.checks.find((row) => row.changeId === idle.id)?.status, 'ready', 'the manual Can Rebase action remains');

    const unopened = await task('Unopened reserved task', 'unopened.txt');
    const reservation = workbench.conversations.reserveRebase(root, [unopened.id]);
    try {
      assert.deepEqual(reservation.items, [{ taskId: unopened.id }]);
      await assert.rejects(workbench.conversations.ensure(root, unopened.id), /being rebased automatically/);
    } finally {
      reservation.release();
    }

    // A real ACP turn remains active when cancellation times out, even though its label is Error.
    const live = await task('Uncertain agent turn', 'live.txt');
    liveChat = await workbench.conversations.ensure(root, live.id);
    await workbench.conversations.connect(liveChat);
    liveChat.session.options.timeoutMs = 1000;
    let turnSettled = false;
    const turn = liveChat.session
      .send('neverfinish')
      .catch(() => {})
      .finally(() => {
        turnSettled = true;
      });
    await eventually(() => liveChat.session.turn?.sent);
    const third = await advance('auto-3.txt');
    await eventually(() => checked(third), 60_000);
    await configuration.update('autoRebase', true, vscode.ConfigurationTarget.Global);
    await workbench.autoRebase(workbench.session, workbench.checks);
    assert.notEqual(parent(live), third, 'a live turn cannot be rebased');
    await assert.rejects(liveChat.session.cancel(), /has not ended this turn/);
    await workbench.autoRebasing;
    assert.equal(liveChat.session.currentStatus(), 'error');
    assert.equal(turnSettled, false);
    assert.equal(workbench.conversations.isBusy(root, live.id), true, 'uncertain cancellation keeps the workspace busy');
    await workbench.autoRebase(workbench.session, workbench.checks);
    assert.notEqual(parent(live), third, 'the error label cannot authorize an automatic rebase');

    await configuration.update('autoRebase', false, vscode.ConfigurationTarget.Global);
    await liveChat.session.disconnect();
    await turn;
    liveChat.session.options.timeoutMs = 15_000;
    await workbench.conversations.connect(liveChat);
    const fourth = await advance('auto-4.txt');
    await eventually(() => checked(fourth), 60_000);
    await workbench.autoRebasing;
    const selectedCheck = workbench.checks.checks.find((row) => row.changeId === live.id);
    assert.equal(selectedCheck.status, 'ready');
    const dispatch = workbench.api;
    let unqueue;
    let queued;
    const waiting = new Promise((resolve) => {
      queued = resolve;
    });
    const gate = new Promise((resolve) => {
      unqueue = resolve;
    });
    workbench.api = async function (command, request) {
      if (command === 'rebase.run') {
        queued();
        await gate;
      }
      return dispatch.call(this, command, request);
    };
    let rebasing;
    try {
      await configuration.update('autoRebase', true, vscode.ConfigurationTarget.Global);
      rebasing = workbench.autoRebase(workbench.session, { checks: [selectedCheck] });
      await waiting;
      await assert.rejects(liveChat.session.send('must not run during queued rebase'), /being rebased automatically/);
      await assert.rejects(workbench.conversations.ensure(root, live.id), /being rebased automatically/);
    } finally {
      unqueue();
      await rebasing;
      workbench.api = dispatch;
    }
    assert.equal(parent(live), fourth, 'a reserved idle connection still permits automatic rebase');
    assert.equal(workbench.conversations.isBusy(root, live.id), false, 'the reservation is released after Git finishes');
    assert(
      requests.some((request) => request.items.some((item) => item.changeId === live.id && item.connectionToken)),
      'the shipped host passes its claim token',
    );
  } finally {
    workbench.conversations.isBusy = isBusy;
    workbench.api = run;
    await configuration.update('autoRebase', false, vscode.ConfigurationTarget.Global);
    await liveChat?.session.disconnect();
  }
};
