import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';
import { Backend } from '../packages/vscode/src/backend.ts';
import { stateFilePath } from '../packages/server/src/state.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'warden-vscode-test-'));
const root = path.join(directory, 'repo');
await mkdir(root);
const git = (...args) =>
  execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: 'pipe' });
let backend;
try {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(root, 'README.md'), 'Baseline\n');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  process.env.XDG_DATA_HOME = path.join(directory, 'data');
  const state = stateFilePath(root);
  backend = await Backend.open(root, state);
  await backend.request('/workflow', 'PUT', { developmentBranch: 'main' });
  await backend.request('/workspace/config', 'PUT', { hooks: {}, previewSetup: 'mkdir -p node_modules; echo setup > node_modules/ready' });
  const plan = await backend.request('/workflow/changes', 'POST', { title: 'Agent task' });
  const task = await backend.request(`/workflow/changes/${plan.id}/start`, 'POST', {});
  await writeFile(path.join(task.worktree, 'agent.txt'), 'Agent addition\n');
  await backend.close();
  backend = undefined;
  const fixture = path.join(directory, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ root, state }));
  await runTests({
    ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : { version: '1.95.3' }),
    extensionDevelopmentPath: process.env.WARDEN_EXTENSION_PATH ?? path.resolve('packages/vscode'),
    extensionTestsPath: path.resolve('test/vscode/suite.cjs'),
    extensionTestsEnv: { XDG_DATA_HOME: process.env.XDG_DATA_HOME, WARDEN_VSCODE_FIXTURE: fixture },
    launchArgs: [
      root,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      path.join(directory, 'user'),
      '--extensions-dir',
      path.join(directory, 'extensions'),
      ...(process.env.WARDEN_VSCODE_HEADLESS ? ['--ozone-platform=headless'] : []),
    ],
  });
} finally {
  await backend?.close();
  await rm(directory, { recursive: true, force: true });
}
