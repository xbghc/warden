const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.checkBranches = async (workbench, root, eventually) => {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const branch = () => workbench.model('task').workflow?.workflow?.developmentBranch;
  const follow = (name) => eventually(() => branch() === name && !workbench.branchTransition, 30_000);
  const create = async (label) => {
    await workbench.backend.execute('task.create', { title: `${label} first` });
    const plan = await workbench.backend.execute('task.create', { title: `${label} selected` });
    const task = await workbench.backend.execute('task.start', { taskId: plan.id });
    await workbench.refresh(true);
    await workbench.selectTask({ kind: 'task', task }, false);
    await fs.writeFile(path.join(task.worktree, 'unfinished.txt'), `${label} unsaved delivery\n`);
    return task;
  };
  const head = git('rev-parse', 'HEAD');
  const draft = (message) => ({ head, start: head, commits: [{ sha: head, message }] });
  const save = (message) => workbench.handleAction({ type: 'history.draft', draft: draft(message) }, workbench.session);
  const a = await create('A');
  await workbench.rememberExpansion({ kind: 'task', task: a }, true);
  await save('A history draft');
  await workbench.showRebase({ kind: 'task', task: a });
  const sessionA = workbench.session;
  workbench.historyPreview = { id: 'old-candidate', canApply: true, head };

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
    await follow('feature/other');
  } finally {
    release();
  }
  assert.deepEqual(await oldFiles, [], 'a file list read begun on the old branch cannot populate the new tree');
  assert.equal(workbench.data.developmentHead, head, 'a branch identity change matters even at the same commit');
  assert.equal(workbench.history.branch, 'feature/other');
  assert.deepEqual(await workbench.getChildren({ kind: 'tasks' }), []);
  assert.deepEqual(workbench.model('workspaces').workspaces, []);
  assert.deepEqual(await workbench.getChildren({ kind: 'task', task: a }), [], 'old task nodes cannot reveal the previous branch');
  assert.equal(workbench.model('task').task, undefined);
  assert.equal(workbench.historyDraft, undefined);
  assert.equal(workbench.historyPreview, undefined);
  assert.equal(workbench.rebaseSelection, undefined);
  assert.deepEqual(workbench.checks.checks, []);
  assert.notEqual(workbench.session, sessionA);
  await assert.rejects(workbench.handleAction({ type: 'task.create', title: 'Stale A action' }, sessionA), /主开发分支已切换/);

  const b = await create('B');
  await save('B history draft');
  assert.notEqual(a.worktree, b.worktree, 'switching requirements never reallocates another branch workspace');
  const file = (await workbench.getChildren({ kind: 'task', task: b }))[0];
  await workbench.openDiff(file);
  const pendingCommit = workbench.promptDelivery({ kind: 'task', task: b });
  await eventually(() => workbench.commitInput);
  workbench.commitInput.value = 'B commit draft';
  git('switch', '--detach');
  await workbench.refresh(true);
  assert.equal(branch(), 'feature/other', 'detached HEAD does not create a requirement');
  assert.equal(workbench.model('task').task.id, b.id);
  git('switch', 'main');
  await follow('main');
  await pendingCommit;
  assert.equal(workbench.commitInput, undefined, 'a branch switch closes the previous branch commit input without submitting');
  assert.equal(workbench.messages[b.id], 'B commit draft');
  assert.equal(workbench.history.branch, 'main');
  assert.equal(workbench.model('task').task.id, a.id, 'returning to a branch restores its chosen task');
  await eventually(() =>
    workbench
      .model('workspaces')
      .workspaces.find((row) => row.task.id === a.id)
      ?.files?.some((file) => file.path === 'unfinished.txt'),
  );
  assert.deepEqual(workbench.historyDraft, draft('A history draft'));
  assert.deepEqual(
    workbench.checks.checks.map((check) => check.changeId),
    [a.id],
  );
  assert((await workbench.getChildren({ kind: 'tasks' })).every((node) => node.task.developmentBranch === 'main'));

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
  assert.equal(workbench.model('task').task.id, a.id, 'the branch selection survives reopening the repository');
  assert.deepEqual(workbench.historyDraft, draft('A history draft'));

  await workbench.api('preview.connect', { connectedIds: [a.id] });
  await workbench.refresh(true);
  const preview = workbench.preview.worktree;
  const composed = await fs.readFile(path.join(preview, 'unfinished.txt'), 'utf8');
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
  assert.equal(workbench.model('task').task.id, b.id);
  assert.deepEqual(workbench.historyDraft, draft('B history draft'));
  assert.deepEqual(
    workbench.checks.checks.map((check) => check.changeId),
    [b.id],
  );
  assert.equal(workbench.preview.worktree, preview, 'the preview directory persists across requirements');

  // Finish the synchronous Git sequence before allowing an observer to follow the new branch.
  const originalBranch = branch();
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
  assert.equal(branch(), originalBranch, 'an unfinished merge does not select a new requirement');
  assert.equal(workbench.model('task').task.id, b.id, 'the previous requirement selection stays visible during a merge');
  git('merge', '--abort');
  await follow('guard/merging');
  assert.deepEqual(workbench.model('workspaces').workspaces, [], 'following resumes after the Git operation ends');
};
