const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

exports.checkRepositoryLoading = async (workbench, extension, fixture, eventually) => {
  const welcome = extension.packageJSON.contributes.viewsWelcome;
  assert.equal(welcome.find((row) => row.contents.includes('command:warden.selectRepository')).when, 'warden.repositoryState == unselected');
  assert.equal(welcome.find((row) => row.contents === 'Opening repository…').when, 'warden.repositoryState != ready && warden.repositoryState != unselected');
  assert(welcome.find((row) => row.contents.includes('command:warden.configure')).when.includes('warden.repositoryState == ready'));
  const selector = extension.packageJSON.contributes.menus['view/title'].find((item) => item.command === 'warden.selectRepository');
  assert(selector.when.includes('warden.repositoryState == ready && warden.multipleRoots'), 'multi-root repository switching remains available');

  const Engine = workbench.backend.constructor;
  for (const operation of ['initialize', 'switch']) {
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
      for (const surface of ['workspaces', 'task', 'preview', 'rebase', 'settings']) {
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
    assert.equal(workbench.model('preview').repositoryState, 'ready');
    assert.equal(workbench.model('preview').repository, operation === 'initialize' ? fixture.root : fixture.unconfigured);
  }

  await assert.rejects(workbench.open(path.join(fixture.root, 'missing-repository')));
  assert.equal(workbench.model('preview').repositoryState, 'unselected', 'failed opening exits loading and restores the selection action');
  assert.deepEqual(await workbench.sidebar.getChildren(), []);
  await workbench.open(fixture.root);
  assert.equal(workbench.model('preview').repositoryState, 'ready', 'a later successful open recovers normally');
};
