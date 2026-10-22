import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'warden-package-'));
const targets = ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-x64', 'darwin-arm64', 'win32-x64-msvc'];
const allTargets = process.argv.includes('--all-targets') || process.env.WARDEN_NATIVE_EXPECT_ALL === '1';
const host = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;
const npmCli = [
  process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : undefined,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidate) => candidate && existsSync(candidate));
if (!npmCli) throw new Error('Cannot locate the npm CLI shipped with Node.js.');

let server;
let stopped;
let output = '';
let failure;

async function waitForExit(timeoutMs) {
  let timeout;
  try {
    return await Promise.race([stopped.then(() => true), new Promise((resolve) => (timeout = setTimeout(() => resolve(false), timeoutMs)))]);
  } finally {
    clearTimeout(timeout);
  }
}
try {
  // Exercise the actual npm allowlist and unpacked layout. Ignoring lifecycle scripts avoids
  // recursion when this check is invoked by prepublishOnly; nothing is sent to the registry.
  // npm 12 keys its pack results by package name; earlier versions return an array.
  const packs = Object.values(
    JSON.parse(
      execFileSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      }),
    ),
  );
  assert.equal(packs.length, 1, 'The smoke test must pack exactly one package.');
  const [packed] = packs;
  const paths = new Set(packed.files.map((file) => file.path));
  assert(paths.has('dist/cli.js'), 'The npm tarball must contain the CLI.');
  assert(paths.has('dist/web/index.html'), 'The npm tarball must contain the web assets.');
  for (const target of allTargets ? targets : [host]) {
    assert(paths.has(`dist/native/warden.${target}.node`), `The npm tarball is missing the ${target} native module.`);
  }
  assert(![...paths].some((path) => path.endsWith('.rs')), 'Consumers must receive prebuilt artifacts, not Rust sources to compile.');
  execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);

  const fixture = join(temporary, 'fixture');
  const templates = join(temporary, 'templates');
  mkdirSync(fixture);
  mkdirSync(templates);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.toUpperCase().startsWith('GIT_')));
  Object.assign(environment, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    XDG_DATA_HOME: join(temporary, 'state'),
    WARDEN_NATIVE: 'required',
    CI: '1',
  });
  const git = (...args) => execFileSync('git', args, { cwd: fixture, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main', `--template=${templates}`);
  git('config', 'user.name', 'Warden package test');
  git('config', 'user.email', 'package-test@warden.invalid');
  writeFileSync(join(fixture, 'tracked.txt'), 'before\n');
  git('add', '--', 'tracked.txt');
  git('commit', '-m', 'Initial fixture');
  writeFileSync(join(fixture, 'tracked.txt'), 'after\n');

  const packageRoot = join(temporary, 'package');
  server = spawn(process.execPath, [join(packageRoot, 'dist', 'cli.js'), fixture, '--no-open', '--no-update-check'], {
    cwd: packageRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stopped = new Promise((resolve) => server.once('close', resolve));
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Packaged CLI did not start:\n${output}`)), 30_000);
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Packaged CLI exited with ${code}:\n${output}`));
    });
    const append = (chunk) => {
      output += chunk.toString();
      const match = output.match(/\burl:\s+(http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    server.stdout.on('data', append);
    server.stderr.on('data', append);
  });
  // Exercise the bundled loader in its own process. Keeping a .node library mapped in this
  // parent process would prevent Windows from deleting the unpacked package during cleanup.
  const response = await fetch(new URL('/api/worktrees', url), { signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const listing = JSON.parse(body);
  assert.equal(listing.worktrees.length, 1);
  assert.equal(listing.worktrees[0].dirty, 1, 'The packaged CLI must read worktree state through its native module.');
  console.log(`Package smoke passed: ${host}; ${allTargets ? targets.length : 1} native target(s) checked.`);
} catch (error) {
  failure = error;
}

try {
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  if (stopped && !(await waitForExit(5000))) {
    server.kill('SIGKILL');
    if (!(await waitForExit(5000))) throw new Error(`Packaged CLI did not exit:\n${output}`);
  }
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
} catch (error) {
  if (failure) throw new AggregateError([failure, error], 'Package smoke and cleanup both failed.');
  throw error;
}
if (failure) throw failure;
