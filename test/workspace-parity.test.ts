import os from 'node:os';
import path from 'node:path';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRepo, StateStore, WorkflowService } from './compat/index.js';
import { PreviewService } from '../packages/engine/src/preview.js';
import { sharedRepositoryPath } from '../packages/engine/src/shared-repository.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

type Kind = 'worktree' | 'shared' | 'clone';

let fx: FixtureRepo;
let data: string;
let store: StateStore;
const timeout = process.platform === 'win32' ? 90_000 : 60_000;

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-parity-');
  data = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-parity-data-')));
  store = new StateStore(path.join(data, 'state.json'), fx.root);
});

afterEach(async () => {
  for (const slot of [1, 2, 3]) await rm(`${fx.root}-${slot}`, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
  await rm(path.dirname(sharedRepositoryPath(fx.root)), { recursive: true, force: true });
  await fx.cleanup();
});

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * Primary-local Git setup that is not part of the tracked tree: a commit hook, commit and
 * line-ending configuration, local ignore rules and local attributes.
 */
async function configurePrimary(hookLog: string) {
  const hook = path.join(fx.root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, `#!/bin/sh\necho "$(basename "$PWD")" >> '${hookLog.replaceAll('\\', '/')}'\n`);
  await chmod(hook, 0o755);
  fx.git('config', 'commit.gpgsign', 'false');
  fx.git('config', 'core.autocrlf', 'input');
  fx.git('config', 'warden-parity.local', 'primary');
  await writeFile(path.join(fx.root, '.git', 'info', 'exclude'), 'local-only.log\n');
  await writeFile(path.join(fx.root, '.git', 'info', 'attributes'), '*.dat binary\n');
}

async function observe(kind: Kind, workflow: WorkflowService, preview: PreviewService, hookLog: string) {
  const task = await workflow.start((await workflow.create({ title: kind })).id, { kind });
  const wt = task.worktree;
  const config = (key: string) => {
    try {
      return fx.git('-C', wt, 'config', '--get', key).trim();
    } catch {
      return null;
    }
  };
  await writeFile(path.join(wt, 'local-only.log'), 'Local log\n');
  await writeFile(path.join(wt, 'tracked.txt'), `Change from ${kind}\n`);
  const status = fx.git('-C', wt, 'status', '--porcelain', '--untracked-files=all').trim().split('\n').sort();
  const attribute = fx.git('-C', wt, 'check-attr', 'binary', '--', 'payload.dat').trim().split(': ').at(-1);
  // Preview composes saved workspace content, including untracked files Git does not ignore.
  const composed = await preview.set([task.id]);
  const previewHasLocalLog = await exists(path.join(composed.worktree!, 'local-only.log'));
  await preview.set([]);
  await rm(path.join(wt, 'local-only.log'));
  fx.git('-C', wt, 'add', 'tracked.txt');
  fx.git('-C', wt, 'commit', '-qm', `Agent commit in ${kind}`);
  const hookRan = (await readFile(hookLog, 'utf8').catch(() => '')).split('\n').includes(path.basename(wt));
  const branchVisibleInPrimary = fx.git('branch', '--list', task.branch!).trim() !== '';
  return {
    hookRan,
    autocrlf: config('core.autocrlf'),
    gpgsign: config('commit.gpgsign'),
    customLocal: config('warden-parity.local'),
    localLogUntracked: status.includes('?? local-only.log'),
    previewHasLocalLog,
    localAttribute: attribute,
    branchVisibleInPrimary,
  };
}

describe('task workspace parity across checkout kinds', () => {
  // Branches stay in the clone, and unrelated local settings are not copied.
  it('gives independent clones the local Git setup of linked worktrees', { timeout }, async () => {
    const hookLog = path.join(data, 'hooks.log');
    await configurePrimary(hookLog);
    const repo = await resolveRepo(fx.root);
    const workflow = new WorkflowService(repo, store);
    const preview = new PreviewService(repo, store);
    await workflow.configure('main');
    const observed: Record<string, Awaited<ReturnType<typeof observe>>> = {};
    for (const kind of ['worktree', 'shared', 'clone'] as const) observed[kind] = await observe(kind, workflow, preview, hookLog);

    // A primary-linked worktree shares the primary repository's hooks, config and info files.
    expect(observed.worktree).toEqual({
      hookRan: true,
      autocrlf: 'input',
      gpgsign: 'false',
      customLocal: 'primary',
      localLogUntracked: false,
      previewHasLocalLog: false,
      localAttribute: 'set',
      branchVisibleInPrimary: true,
    });
    // Warden's external repository mirrors what decides which files Git sees and how their bytes
    // are stored, so preview agrees with primary. Hooks, signing and other settings stay out.
    expect(observed.shared).toEqual({
      hookRan: false,
      autocrlf: 'input',
      gpgsign: null,
      customLocal: null,
      localLogUntracked: false,
      previewHasLocalLog: false,
      localAttribute: 'set',
      branchVisibleInPrimary: false,
    });
    // Independent clones copy primary's hooks, local settings and info files when they are made.
    expect(observed.clone).toEqual({ ...observed.worktree, customLocal: null, branchVisibleInPrimary: false });
  });

  it('copies settings by value and keeps a configured hooks directory live', { timeout }, async () => {
    const hookLog = path.join(data, 'hooks.log');
    // A tracked hooks directory, as husky sets up, is reached through the copied relative setting.
    await mkdir(path.join(fx.root, '.githooks'));
    const hook = path.join(fx.root, '.githooks', 'pre-commit');
    await writeFile(hook, `#!/bin/sh\necho tracked >> '${hookLog.replaceAll('\\', '/')}'\n`);
    await chmod(hook, 0o755);
    fx.git('add', '.githooks');
    fx.git('commit', '-qm', 'Track hooks');
    fx.git('config', 'core.hooksPath', '.githooks');
    // A default-directory hook is ignored while core.hooksPath is set, so it is not copied either.
    await writeFile(path.join(fx.root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nexit 0\n');
    fx.git('config', '--add', 'filter.parity.clean', 'cat');
    fx.git('config', 'filter.parity.smudge', 'line one\nline two');
    fx.git('config', '--add', 'gpg.ssh.allowedSignersFile', 'first');
    fx.git('config', '--add', 'gpg.ssh.allowedSignersFile', 'second');
    fx.git('config', 'commit.template', '.gitmessage');
    const repo = await resolveRepo(fx.root);
    const workflow = new WorkflowService(repo, store);
    await workflow.configure('main');
    const task = await workflow.start((await workflow.create({ title: 'Clone' })).id, { kind: 'clone' });
    const at = (...args: string[]) => fx.git('-C', task.worktree, ...args).trim();

    expect(at('config', '--get', 'core.hooksPath')).toBe('.githooks');
    expect(at('config', '--get', 'filter.parity.smudge')).toBe('line one\nline two');
    expect(at('config', '--get-all', 'gpg.ssh.allowedSignersFile').split('\n')).toEqual(['first', 'second']);
    expect(() => at('config', '--get', 'commit.template')).toThrow();
    expect(await exists(path.join(task.worktree, '.git', 'hooks', 'post-commit'))).toBe(false);
    await writeFile(path.join(task.worktree, 'tracked.txt'), 'Clone change\n');
    at('add', 'tracked.txt');
    at('commit', '-qm', 'Agent commit');
    expect(await readFile(hookLog, 'utf8')).toBe('tracked\n');
  });

  it.skipIf(process.platform === 'win32')('copies a symlinked hook as its content', { timeout }, async () => {
    const hookLog = path.join(data, 'hooks.log');
    const script = path.join(data, 'managed-hook');
    await writeFile(script, `#!/bin/sh\necho managed >> '${hookLog}'\n`);
    await chmod(script, 0o755);
    await symlink(script, path.join(fx.root, '.git', 'hooks', 'pre-commit'));
    await symlink(path.join(data, 'missing'), path.join(fx.root, '.git', 'hooks', 'commit-msg'));
    const repo = await resolveRepo(fx.root);
    const workflow = new WorkflowService(repo, store);
    await workflow.configure('main');
    const task = await workflow.start((await workflow.create({ title: 'Clone' })).id, { kind: 'clone' });

    // A dangling link in primary's hooks does not block allocation; the clone just lacks that hook.
    expect(await exists(path.join(task.worktree, '.git', 'hooks', 'commit-msg'))).toBe(false);
    await writeFile(path.join(task.worktree, 'tracked.txt'), 'Clone change\n');
    fx.git('-C', task.worktree, 'add', 'tracked.txt');
    fx.git('-C', task.worktree, 'commit', '-qm', 'Agent commit');
    expect(await readFile(hookLog, 'utf8')).toBe('managed\n');
  });
});
