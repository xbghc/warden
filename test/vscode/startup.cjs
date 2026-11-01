const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

exports.checkStartup = async (workbench, fixture, eventually) => {
  while (workbench.checkReading) await workbench.checkReading;
  const prototype = workbench.backend.constructor.prototype;
  const execute = prototype.execute;
  await workbench.agentSetup.disconnect();
  workbench.agentSetup.started = false;
  let entered = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  prototype.execute = async function (command, ...args) {
    if (command === 'repository.get') {
      entered = true;
      await gate;
    }
    return execute.call(this, command, ...args);
  };
  let finished = false;
  const opening = workbench.initialize().then(() => {
    finished = true;
  });
  try {
    await eventually(() => entered, 30_000);
    assert.equal(workbench.agentSetupRequired, false, 'automatic startup never exposes setup during repository loading');
    await eventually(() => workbench.agentSetup.readiness.snapshot().status === 'ready', 30_000);
    assert.equal(finished, false, 'ACP becomes ready while repository observation is still blocked');
    assert.equal(workbench.model('workspaces').repositoryState, 'loading');
    assert.deepEqual(await workbench.getChildren(), [], 'agent readiness alone does not expose a loading repository');
    const wire = (await fs.readFile(`${fixture.journal}.check`, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(wire.filter((row) => row.method === 'session/new').at(-1).params.cwd, fixture.root);
    assert(!wire.some((row) => row.method === 'session/prompt'), 'parallel startup sends no work prompt');
  } finally {
    prototype.execute = execute;
    release();
    await opening;
  }

  while (workbench.checkReading) await workbench.checkReading;
  let checked = false;
  let releaseCheck;
  const checkGate = new Promise((resolve) => {
    releaseCheck = resolve;
  });
  prototype.execute = async function (command, ...args) {
    const result = await execute.call(this, command, ...args);
    if (command === 'rebase.check') {
      checked = true;
      await checkGate;
    }
    return result;
  };
  let loaded = false;
  const loading = workbench.open(fixture.root).then(() => {
    loaded = true;
  });
  try {
    await eventually(() => checked && loaded, 30_000);
    assert.equal(workbench.model('workspaces').checkingRebase, true);
    const nodes = await workbench.sidebar.getChildren();
    assert.equal(nodes.length, 1, 'task navigation is available before synchronization checks finish');
    assert.equal(workbench.sidebar.getTreeItem(nodes[0]).iconPath.id, 'sync~spin');
    assert.equal(workbench.checks.checks[0].status, 'unknown');
    assert.match(workbench.checks.checks[0].message, /Checking synchronization/);
    await vscode.commands.executeCommand('warden.task.focus');
    if (process.env.WARDEN_VSCODE_STARTUP_SCREENSHOT && process.platform === 'linux') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', process.env.WARDEN_VSCODE_STARTUP_SCREENSHOT]);
    }
    await workbench.open(fixture.unconfigured);
    releaseCheck();
    while (workbench.checkReading) await workbench.checkReading;
    assert.equal(workbench.checks, undefined, 'late checks cannot populate a different repository');
    assert.equal(workbench.model('workspaces').checkingRebase, false);
  } finally {
    prototype.execute = execute;
    releaseCheck();
    await loading;
    while (workbench.checkReading) await workbench.checkReading;
    await workbench.open(fixture.root);
  }

  while (workbench.checkReading) await workbench.checkReading;
  let calls = 0;
  let waiting = false;
  let releaseOld;
  const oldCheck = new Promise((resolve) => {
    releaseOld = resolve;
  });
  prototype.execute = async function (command, ...args) {
    const result = await execute.call(this, command, ...args);
    if (command === 'rebase.check' && ++calls === 1) {
      waiting = true;
      await oldCheck;
      return { checks: result.checks.map((check) => ({ ...check, status: 'conflict', message: 'Obsolete check' })) };
    }
    return result;
  };
  let initialCheck;
  let rechecking;
  try {
    initialCheck = workbench.refreshChecks();
    await eventually(() => waiting);
    rechecking = workbench.refreshChecks();
    await eventually(() => !!workbench.pendingCheck);
    assert.equal(calls, 1, 'a replacement check queues behind the running check');
    releaseOld();
    await rechecking;
    assert.equal(calls, 2, 'an explicit check gets a fresh observation after the old one');
    assert.equal(workbench.checkingRebase, false);
    assert(
      workbench.checks.checks.every((check) => check.message !== 'Obsolete check'),
      'old results cannot satisfy a newer check request',
    );
  } finally {
    prototype.execute = execute;
    releaseOld();
    await initialCheck;
    await rechecking;
    while (workbench.checkReading) await workbench.checkReading;
  }

  const oldEngine = workbench.backend;
  let observed = false;
  let obsoleteChecks = 0;
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  oldEngine.execute = async function (command, ...args) {
    // Count newly scheduled work, not an earlier check completing after the switch began.
    if (command === 'rebase.check' && workbench.switching) obsoleteChecks++;
    const result = await execute.call(this, command, ...args);
    if (command === 'repository.get') {
      observed = true;
      await readGate;
    }
    return result;
  };
  const reading = workbench.refresh();
  let switching;
  try {
    await eventually(() => observed);
    switching = workbench.open(fixture.unconfigured);
    await eventually(() => workbench.switching);
    releaseRead();
    await switching;
    assert.equal(obsoleteChecks, 0, 'a refresh superseded by repository switching cannot schedule old checks');
    assert.equal(workbench.checks, undefined);
  } finally {
    oldEngine.execute = execute;
    releaseRead();
    await reading;
    await switching;
    await workbench.open(fixture.root);
  }
};
