import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { runTests } from '@vscode/test-electron';
import { Engine } from '../packages/engine/src/engine.ts';
import { stateFilePath } from '../packages/engine/src/state.ts';

// Git resolves macOS temporary-directory symlinks before deriving the repository's state path.
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-vscode-test-')));
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
  const unconfigured = path.join(directory, 'unconfigured');
  git('clone', '--no-hardlinks', root, unconfigured);
  process.env.XDG_DATA_HOME = path.join(directory, 'data');
  const state = stateFilePath(root);
  backend = await Engine.open(root, state);
  await backend.execute('workflow.configure', { branch: 'main' });
  await backend.execute('config.save', { hooks: {}, previewSetup: 'mkdir -p node_modules; echo setup > node_modules/ready' });
  const task = await backend.execute('task.create', { title: 'Agent task' });
  if (!task.worktree) throw new Error(task.workspaceError?.message ?? 'Task allocation failed');
  await writeFile(path.join(task.worktree, 'agent.txt'), 'Agent addition\n');
  await backend.close();
  backend = undefined;
  const fixture = path.join(directory, 'fixture.json');
  await writeFile(
    fixture,
    JSON.stringify({
      root,
      state,
      unconfigured,
      node: process.execPath,
      agent: path.resolve('test/fixtures/acp-agent.mjs'),
      journal: path.join(directory, 'acp.jsonl'),
    }),
  );
  const manifest = JSON.parse(await readFile('packages/vscode/package.json', 'utf8'));
  const archive = unzipSync(await readFile(`packages/vscode/warden-${manifest.version}.vsix`));
  const unpacked = path.join(directory, 'vsix');
  for (const [name, bytes] of Object.entries(archive)) {
    if (!name.startsWith('extension/') || name.endsWith('/')) continue;
    const destination = path.resolve(unpacked, name);
    if (!destination.startsWith(`${unpacked}${path.sep}`)) throw new Error('Invalid VSIX path');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  await runTests({
    ...(process.env.VSCODE_EXECUTABLE_PATH
      ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH }
      : { version: process.env.WARDEN_VSCODE_VERSION ?? '1.106.0' }),
    extensionDevelopmentPath: path.join(unpacked, 'extension'),
    extensionTestsPath: path.resolve(
      process.env.WARDEN_VSCODE_SUITE === 'deletion'
        ? 'test/vscode/deletion.cjs'
        : process.env.WARDEN_VSCODE_SUITE === 'chat'
          ? 'test/vscode/chat.cjs'
          : process.env.WARDEN_VSCODE_SUITE === 'tree-refresh'
            ? 'test/vscode/tree-refresh.cjs'
            : process.env.WARDEN_VSCODE_SUITE === 'settings'
              ? 'test/vscode/settings.cjs'
              : process.env.WARDEN_VSCODE_SUITE === 'branches'
                ? 'test/vscode/branches.cjs'
                : 'test/vscode/suite.cjs',
    ),
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
  let rendererLogs = 0;
  const inspectLogs = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspectLogs(file);
      else if (entry.name === 'renderer.log') {
        rendererLogs++;
        const log = await readFile(file, 'utf8');
        if (process.env.WARDEN_VSCODE_ARTIFACTS) {
          await mkdir(process.env.WARDEN_VSCODE_ARTIFACTS, { recursive: true });
          await writeFile(path.join(process.env.WARDEN_VSCODE_ARTIFACTS, `${path.basename(directory)}-renderer.log`), log);
        }
        if (/TreeError \[warden\./.test(log)) throw new Error('Native Warden tree errors were reported in renderer.log');
      }
    }
  };
  await inspectLogs(path.join(directory, 'user', 'logs'));
  if (!rendererLogs) throw new Error('Renderer logs were not available for native tree verification');
} finally {
  await backend?.close();
  await rm(directory, { recursive: true, force: true });
}
