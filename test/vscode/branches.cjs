const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { verifyAgent } = require('./agent-setup.cjs');
const { checkStartup } = require('./startup.cjs');
const { checkBranchChats } = require('./branch-chats.cjs');

exports.run = async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WARDEN_VSCODE_FIXTURE, 'utf8'));
  const workbench = await vscode.extensions.getExtension('xbghc.warden').activate();
  const eventually = async (condition, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for branch state');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    await verifyAgent(workbench, fixture);
    await checkStartup(workbench, fixture, eventually);
    await exports.checkBranches(workbench, fixture.root, eventually);
    console.log(
      'Packaged branch flows passed: explicit tracking, quiet inactive branches, retained preview and agent connections, chat recovery and obsolete observer rejection',
    );
  } finally {
    await workbench.close();
  }
};

exports.checkBranches = async (workbench, root, eventually) => {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const branch = () => workbench.model('workspaces').workflow?.workflow?.developmentBranch;
  const follow = (name) => eventually(() => branch() === name && !workbench.branchTransition, 30_000);
  const configure = async (name) => {
    const api = workbench.api;
    let listed = false;
    workbench.api = async function (command, ...args) {
      const result = await api.call(this, command, ...args);
      if (command === 'workspaces.list' && !listed) {
        listed = true;
        // Exercise native confirmation without depending on renderer search timing.
        if (name) return { ...result, branches: result.branches.filter((branch) => branch.name === name) };
      }
      return result;
    };
    const choosing = workbench.configure();
    try {
      await eventually(() => listed);
      await vscode.commands.executeCommand(name ? 'workbench.action.acceptSelectedQuickOpenItem' : 'workbench.action.closeQuickOpen');
      await choosing;
    } finally {
      workbench.api = api;
    }
  };
  const screenshot = async (name) => {
    const directory = process.env.WARDEN_VSCODE_BRANCH_SCREENSHOTS;
    if (!directory || process.platform !== 'linux') return;
    await fs.mkdir(directory, { recursive: true });
    await vscode.commands.executeCommand('warden.task.focus');
    await eventually(() => workbench.sidebar.view.visible);
    await new Promise((resolve) => setTimeout(resolve, 300));
    execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', path.join(directory, `${name}.png`)]);
  };
  const inactive = async () => {
    await follow(undefined);
    await workbench.reading;
    assert.deepEqual(await workbench.sidebar.getChildren(), []);
    assert.equal(workbench.sidebar.view.description, undefined);
    assert.equal(workbench.sidebar.view.message, undefined);
    assert.equal(workbench.model('workspaces').preview, undefined);
    assert.equal(workbench.checks, undefined);
    assert.equal(workbench.contextValues.get('warden.hasDevelopmentBranch'), false);
    assert.equal(workbench.contextValues.get('warden.previewNeedsSync'), false);
    assert.equal(workbench.contextValues.get('warden.previewSetupFailed'), false);
    const status = workbench.status;
    const show = status.show;
    const hide = status.hide;
    let visible;
    status.show = () => {
      visible = true;
      show.call(status);
    };
    status.hide = () => {
      visible = false;
      hide.call(status);
    };
    try {
      workbench.render();
      assert.equal(visible, false, 'untracked branches hide the native preview status');
    } finally {
      status.show = show;
      status.hide = hide;
    }
  };
  const create = async (label) => {
    await workbench.backend.execute('task.create', { title: `${label} first` });
    const task = await workbench.backend.execute('task.create', { title: `${label} selected` });
    // A recoverable allocation failure returns the task without a workspace; name the reason here.
    assert.ok(task.worktree, `workspace allocation failed: ${JSON.stringify(task.workspaceError)}`);
    await workbench.refresh(true);
    await workbench.selectTask({ kind: 'task', task }, 'select');
    await fs.writeFile(path.join(task.worktree, 'unfinished.txt'), `${label} unsaved delivery\n`);
    return task;
  };
  const head = git('rev-parse', 'HEAD');
  const a = await create('A');
  const oldSidebarNode = (await workbench.sidebar.getChildren()).find((node) => node.task.id === a.id);
  const oldSidebarId = workbench.sidebar.getTreeItem(oldSidebarNode).id;
  await workbench.rememberExpansion({ kind: 'task', task: a }, true);
  await workbench.showRebase({ kind: 'task', task: a });
  const sessionA = workbench.session;

  let release;
  let ready;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reading = new Promise((resolve) => {
    ready = resolve;
  });
  const readReview = workbench.readReview.bind(workbench);
  let first = true;
  workbench.readReview = async (id) => {
    const delay = first;
    first = false;
    const review = await readReview(id);
    if (delay) {
      ready();
      await gate;
    }
    return review;
  };
  const oldFiles = workbench.getChildren({ kind: 'task', task: a });
  await reading;
  workbench.readReview = readReview;
  // Neither configure nor refresh is called here: the packaged observer must follow Git itself.
  try {
    git('switch', '-c', 'feature/other');
    await inactive();
  } finally {
    release();
  }
  assert.deepEqual(await oldFiles, [], 'a file list read begun on the old branch cannot populate the new tree');
  assert.equal(workbench.data.developmentHead, undefined, 'untracked branches expose no previous base-branch state even at the same commit');
  assert.deepEqual(await workbench.getChildren(), []);
  assert.deepEqual(workbench.model('workspaces').workspaces, []);
  assert.deepEqual(await workbench.getChildren({ kind: 'task', task: a }), [], 'old task nodes cannot reveal the previous branch');
  assert.equal(workbench.model('workspaces').task, undefined);
  assert.equal(workbench.rebaseSelection, undefined);
  assert.equal(workbench.checks, undefined);
  assert.notEqual(workbench.session, sessionA);
  assert.equal(workbench.sidebar.getTreeItem(oldSidebarNode).id, oldSidebarId, 'retained tree nodes keep their identity across branch switches');
  await assert.rejects(workbench.handleAction({ type: 'task.create', title: 'Stale A action' }, sessionA), /base branch changed/);
  await assert.rejects(workbench.api('task.create', { title: 'Untracked branch task' }), (error) => error.code === 'requirement_changed');
  await assert.rejects(workbench.ensurePreview(), /Select a base branch/);
  const retained = (await workbench.backend.execute('workflow.get')).workflow;
  assert.equal(retained.developmentBranch, 'main');
  assert(!retained.trackedBranches.includes('feature/other'), 'visiting a Git branch does not enroll it');
  await workbench.open(root);
  await inactive();
  await screenshot('untracked-branch');
  await workbench.api('config.save', (await workbench.backend.execute('workflow.get')).workspaceConfig);
  await configure(undefined);
  await inactive();
  await configure('feature/other');
  await follow('feature/other');
  git('switch', 'main');
  await follow('main');
  git('switch', 'feature/other');
  await follow('feature/other');
  assert.deepEqual(workbench.tasks(), [], 'an explicitly tracked branch is restored even before its first task');
  await screenshot('tracked-empty-branch');

  const b = await create('B');
  assert.notEqual(a.worktree, b.worktree, 'switching requirements never reallocates another branch workspace');
  const file = (await workbench.getChildren({ kind: 'task', task: b }))[0];
  await workbench.openDiff(file);
  const pendingCommit = workbench.promptDelivery({ kind: 'task', task: b });
  await eventually(() => workbench.commitInput);
  workbench.commitInput.value = 'B commit draft';
  git('switch', '--detach');
  await workbench.refresh(true);
  await inactive();
  assert.equal(workbench.model('workspaces').task, undefined, 'detached HEAD hides the previous requirement');
  git('switch', 'main');
  await follow('main');
  await pendingCommit;
  assert.equal(workbench.commitInput, undefined, 'a branch switch closes the previous branch commit input without submitting');
  assert.equal(workbench.messages[b.id], 'B commit draft');
  assert.equal(workbench.model('workspaces').task.id, a.id, 'returning to a branch restores its chosen task');
  await eventually(() =>
    workbench
      .model('workspaces')
      .workspaces.find((row) => row.task.id === a.id)
      ?.files?.some((file) => file.path === 'unfinished.txt'),
  );
  assert.deepEqual(
    workbench.checks.checks.map((check) => check.changeId),
    workbench
      .tasks()
      .filter((task) => task.worktree)
      .map((task) => task.id),
  );
  assert((await workbench.getChildren()).every((node) => node.task.developmentBranch === 'main'));

  for (const [task, label] of [
    [a, 'A'],
    [b, 'B'],
  ]) {
    assert.equal(git('-C', task.worktree, 'branch', '--show-current'), task.branch);
    assert.equal(git('-C', task.worktree, 'rev-parse', 'HEAD'), head, 'branch following must not rebase a task');
    assert.equal(await fs.readFile(path.join(task.worktree, 'unfinished.txt'), 'utf8'), `${label} unsaved delivery\n`);
    const saved = workbench.data.workflow.changes.find((row) => row.id === task.id);
    assert.equal(saved.base, task.base);
    assert.equal(saved.sourceBase, task.sourceBase);
  }
  await workbench.open(root);
  assert.equal(workbench.model('workspaces').task.id, a.id, 'the branch selection survives reopening the repository');

  await workbench.api('preview.connect', { connectedIds: [a.id] });
  await workbench.refresh(true);
  const preview = workbench.preview.worktree;
  const composed = await fs.readFile(path.join(preview, 'unfinished.txt'), 'utf8');
  const savedPreview = (await workbench.backend.execute('preview.get')).connectedIds;
  git('switch', '-c', 'unrelated');
  await inactive();
  await workbench.backend.preview.tick();
  assert.deepEqual((await workbench.backend.execute('preview.get')).connectedIds, savedPreview, 'leaving tracking preserves preview connections');
  assert.equal(await fs.readFile(path.join(preview, 'unfinished.txt'), 'utf8'), composed);
  assert.equal(workbench.errors.has('branch'), false, 'ordinary development outside Warden needs no switch warning');
  const inactiveSession = workbench.session;
  git('switch', '-c', 'another-unrelated');
  await eventually(() => workbench.session !== inactiveSession);
  await inactive();
  await workbench.open(root);
  await inactive();
  git('switch', 'main');
  await follow('main');
  assert.equal(workbench.model('workspaces').task.id, a.id);
  assert.deepEqual(workbench.preview.connectedIds, [a.id]);
  await screenshot('tracked-restored-branch');
  git('switch', 'feature/other');
  await eventually(() => workbench.errors.get('branch')?.code === 'development_in_use', 30_000);
  assert.equal(branch(), 'main', 'an active preview connection must not silently move to another requirement');
  assert.deepEqual(workbench.preview.connectedIds, [a.id]);
  assert.equal(await fs.readFile(path.join(preview, 'unfinished.txt'), 'utf8'), composed);
  assert(workbench.model('workspaces').errors.some((error) => error.message.includes('feature/other') && error.message.includes('main')));
  git('switch', 'main');
  await eventually(() => !workbench.errors.has('branch'), 30_000);
  await workbench.api('preview.connect', { connectedIds: [] });
  git('switch', 'feature/other');
  await follow('feature/other');
  assert.equal(workbench.model('workspaces').task.id, b.id);
  assert.deepEqual(
    workbench.checks.checks.map((check) => check.changeId),
    workbench
      .tasks()
      .filter((task) => task.worktree)
      .map((task) => task.id),
  );
  assert.equal(workbench.preview.worktree, preview, 'the preview directory persists across requirements');

  // Finish the synchronous Git sequence before allowing an observer to follow the new branch.
  const originalHead = git('rev-parse', 'HEAD');
  git('switch', '-c', 'guard/conflicting');
  writeFileSync(path.join(root, 'branch-conflict.txt'), 'Side content\n');
  git('add', 'branch-conflict.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Create conflicting branch');
  git('switch', '-c', 'guard/merging', originalHead);
  writeFileSync(path.join(root, 'branch-conflict.txt'), 'Target content\n');
  git('add', 'branch-conflict.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Create merge target');
  assert.throws(() => git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', 'guard/conflicting'));
  await workbench.refresh(true);
  assert.equal(workbench.checkouts.worktrees.find((row) => row.isMain).busy, 'merge');
  await inactive();
  assert.equal(workbench.model('workspaces').task, undefined, 'an untracked branch remains quiet during a merge');
  git('merge', '--abort');
  await workbench.refresh(true);
  await inactive();
  assert.equal((await workbench.backend.execute('workflow.get')).workflow.developmentBranch, 'feature/other');
  await configure('guard/merging');
  await follow('guard/merging');
  await checkBranchChats(workbench, root, eventually);
};
