const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { checkStartup } = require('./startup.cjs');

exports.checkRepositoryLoading = async (workbench, extension, fixture, eventually) => {
  const timings = [];
  const appendLine = workbench.output.appendLine;
  workbench.output.appendLine = function (line) {
    if (line.startsWith('[performance] ')) timings.push(JSON.parse(line.slice('[performance] '.length)));
    return appendLine.call(this, line);
  };
  try {
    await checkRepositoryLoading(workbench, extension, fixture, eventually, timings);
    await checkStartup(workbench, fixture, eventually);
  } finally {
    workbench.output.appendLine = appendLine;
  }
};

async function checkRepositoryLoading(workbench, extension, fixture, eventually, timings) {
  const welcome = extension.packageJSON.contributes.viewsWelcome;
  assert.equal(
    welcome.find((row) => row.contents.includes('command:warden.selectRepository')).when,
    'warden.agentReady && (warden.repositoryState == unselected)',
  );
  assert.equal(
    welcome.find((row) => row.contents === 'Opening repository…').when,
    'warden.agentReady && (warden.repositoryState != ready && warden.repositoryState != unselected)',
  );
  assert(welcome.find((row) => row.contents.includes('command:warden.configure)')).when.includes('warden.repositoryState == ready'));
  const selector = extension.packageJSON.contributes.menus['view/title'].find((item) => item.command === 'warden.selectRepository');
  assert(selector.when.includes('warden.repositoryState == ready && warden.multipleRoots'), 'multi-root repository switching remains available');

  const Engine = workbench.backend.constructor;
  for (const operation of ['initialize', 'switch']) {
    const first = timings.length;
    const open = Engine.open;
    let entered = false;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    Engine.open = async function (...args) {
      entered = true;
      await gate;
      return open.apply(this, args);
    };
    const pending = operation === 'initialize' ? workbench.initialize() : workbench.open(fixture.unconfigured);
    try {
      await eventually(() => entered, 30_000);
      const opening = timings.slice(first).find((row) => row.stage === 'engine.open');
      assert.equal(opening?.event, 'start', 'a blocked startup phase is visible before it finishes');
      assert(!timings.slice(first).some((row) => row.stage === 'engine.open' && row.event === 'end'));
      for (const surface of ['workspaces', 'task', 'rebase', 'settings']) {
        const model = workbench.model(surface);
        assert.equal(model.repositoryState, 'loading', `${operation} keeps ${surface} in its loading state`);
        assert.equal(model.repository, '');
        assert.equal(model.workflow, undefined, 'previous repository setup state must not leak into loading views');
      }
      assert.deepEqual(await workbench.sidebar.getChildren(), [], 'loading never exposes previous task navigation');
      assert.equal(workbench.sidebar.view.message, undefined, 'native welcome content owns loading feedback');
      await assert.rejects(workbench.handleAction({ type: 'setup.repository' }, workbench.session), /changed/, 'loading cannot open another picker');
      await vscode.commands.executeCommand('warden.task.focus');
      await eventually(() => workbench.sidebar.view.visible);
      if (operation === 'initialize' && process.env.WARDEN_VSCODE_REPOSITORY_SCREENSHOT && process.platform === 'linux') {
        await new Promise((resolve) => setTimeout(resolve, 500));
        execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', process.env.WARDEN_VSCODE_REPOSITORY_SCREENSHOT]);
      }
    } finally {
      Engine.open = open;
      release();
      await pending;
    }
    assert.equal(workbench.model('workspaces').repositoryState, 'ready');
    assert.equal(workbench.model('workspaces').repository, operation === 'initialize' ? fixture.root : fixture.unconfigured);
    while (workbench.checkReading) await workbench.checkReading;
    const completed = timings.slice(first).filter((row) => row.event === 'end');
    for (const stage of ['repository.open', 'repository.wait', 'engine.open', 'repository.refresh', 'repository.get', 'context.update']) {
      assert(
        completed.some((row) => row.stage === stage && row.outcome === 'ok'),
        `${stage} is measured in the packaged extension`,
      );
    }
    if (operation === 'initialize') {
      assert(completed.some((row) => row.stage === 'activation' && row.outcome === 'ok'));
      assert(completed.some((row) => row.stage === 'rebase.check' && row.outcome === 'ok'));
    }
    for (const row of completed) {
      assert(row.durationMs >= 0 && row.elapsedMs >= row.durationMs);
      assert(timings.some((start) => start.event === 'start' && start.run === row.run && start.span === row.span));
    }
  }

  const beforeFailure = timings.length;
  await assert.rejects(workbench.open(path.join(fixture.root, 'missing-repository')));
  for (const stage of ['engine.open', 'repository.open'])
    assert(timings.slice(beforeFailure).some((row) => row.stage === stage && row.event === 'end' && row.outcome === 'error'));
  assert.equal(workbench.model('workspaces').repositoryState, 'unselected', 'failed opening exits loading and restores the selection action');
  assert.deepEqual(await workbench.sidebar.getChildren(), []);
  await workbench.open(fixture.root);
  assert.equal(workbench.model('workspaces').repositoryState, 'ready', 'a later successful open recovers normally');
  await workbench.agentSetup.check();
  for (const stage of ['acp.connect', 'acp.cleanup', 'acp.spawn', 'acp.initialize', 'acp.session.new'])
    assert(
      timings.some((row) => row.stage === stage && row.event === 'end' && row.outcome === 'ok'),
      `${stage} reaches the Warden output channel`,
    );
  assert(!JSON.stringify(timings).includes(fixture.root), 'performance records omit repository paths');
  while (workbench.checkReading) await workbench.checkReading;
  const beforeRefresh = timings.length;
  await workbench.refresh();
  assert.equal(timings.length, beforeRefresh, 'ordinary refreshes do not flood startup diagnostics');
}
