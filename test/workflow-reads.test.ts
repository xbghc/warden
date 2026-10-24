import os from 'node:os';
import path from 'node:path';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentChange } from '@warden/shared';
import { resolveRepo, StateStore, WorkflowService } from './compat/index.js';
import { GitSandbox } from '../packages/engine/src/git-sandbox.js';
import * as git from '../packages/engine/src/git.js';
import * as worktrees from '../packages/engine/src/worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let store: StateStore;
let workflow: WorkflowService;
let checkouts: string[];
const longGitTimeout = process.platform === 'win32' ? 90_000 : 30_000;

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-workflow-reads-');
  fx.git('switch', '-qc', 'feature/order');
  data = await mkdtemp(path.join(os.tmpdir(), 'warden-workflow-reads-data-'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(data, 'config'));
  // Git for Windows ships a system attributes file independently of its system config.
  // Cache fixtures explicitly exclude it while still testing changes to global attributes.
  vi.stubEnv('GIT_ATTR_NOSYSTEM', '1');
  store = new StateStore(path.join(data, 'state.json'), fx.root);
  workflow = new WorkflowService(await resolveRepo(fx.root), store);
  checkouts = [];
  await workflow.configure('feature/order');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(checkouts.map((checkout) => rm(checkout, { recursive: true, force: true })));
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

async function task(kind: 'clone' | 'worktree' | 'shared' = 'worktree') {
  const change = await workflow.start((await workflow.create({ title: 'Read checks' })).id, { kind });
  checkouts.push(change.worktree);
  return change;
}

async function commit(cwd: string, file: string, content: string) {
  await writeFile(path.join(cwd, file), content);
  fx.git('-C', cwd, 'add', '--', file);
  fx.git('-C', cwd, 'commit', '-qm', `Change ${file}`);
}

async function behind(kind: 'clone' | 'worktree' | 'shared' = 'worktree', conflict = false) {
  const change = await task(kind);
  await commit(change.worktree, conflict ? 'src/b.ts' : 'task.txt', 'Task change\n');
  await commit(fx.root, conflict ? 'src/b.ts' : 'primary.txt', 'Primary change\n');
  return change;
}

const check = async (change: DevelopmentChange) => (await workflow.rebaseChecks()).checks.find((row) => row.changeId === change.id)!;

describe('shared workflow reads', () => {
  it('keeps unsupported attribute lookups uncached even when system attributes are disabled', { timeout: longGitTimeout }, async () => {
    const change = await behind();
    const create = vi.spyOn(GitSandbox, 'create');
    const run = git.runGit;
    vi.spyOn(git, 'runGit').mockImplementation((args, options) => {
      if (args[0] === 'var' && args[1] === 'GIT_ATTR_GLOBAL') return Promise.reject(new git.GitError('Unsupported Git variable', 1, ''));
      return run(args, options);
    });
    expect((await check(change)).status).toBe('ready');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reads one checkout inventory per request for several linked and clone workspaces', { timeout: longGitTimeout }, async () => {
    await task();
    await task();
    await task('clone');
    const list = vi.spyOn(worktrees, 'listWorktreesDetailed');
    expect((await workflow.get()).workflow?.changes).toHaveLength(3);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockClear();
    expect((await workflow.rebaseChecks()).checks.map((row) => row.status)).toEqual(['current', 'current', 'current']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('reuses a trial while still detecting edits, commits, branch switches and unfinished operations', { timeout: longGitTimeout }, async () => {
    const change = await behind();
    const create = vi.spyOn(GitSandbox, 'create');
    const originalHead = fx.git('-C', change.worktree, 'rev-parse', 'HEAD').trim();
    const indexPath = path.resolve(change.worktree, fx.git('-C', change.worktree, 'rev-parse', '--git-path', 'index').trim());
    const index = await readFile(indexPath);
    expect((await check(change)).status).toBe('ready');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(1);
    expect(await readFile(indexPath)).toEqual(index);
    expect(fx.git('-C', change.worktree, 'rev-parse', 'HEAD').trim()).toBe(originalHead);

    await writeFile(path.join(change.worktree, 'task.txt'), 'Unsaved work\n');
    expect((await check(change)).status).toBe('blocked');
    expect(create).toHaveBeenCalledTimes(1);
    fx.git('-C', change.worktree, 'restore', 'task.txt');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(1);

    await commit(change.worktree, 'task.txt', 'Another source commit\n');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(2);
    await commit(fx.root, 'primary.txt', 'Another primary commit\n');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(3);

    fx.git('-C', change.worktree, 'switch', '-qc', 'different-branch');
    expect(await check(change)).toMatchObject({ status: 'blocked', message: expect.stringContaining('切换分支') });
    fx.git('-C', change.worktree, 'switch', '-q', change.branch);
    const mergeHead = path.resolve(change.worktree, fx.git('-C', change.worktree, 'rev-parse', '--git-path', 'MERGE_HEAD').trim());
    await writeFile(mergeHead, `${originalHead}\n`);
    expect(await check(change)).toMatchObject({ status: 'blocked', message: expect.stringContaining('未完成的 merge') });
    await rm(mergeHead);
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('shares concurrent trials and discards transient sandbox failures', { timeout: longGitTimeout }, async () => {
    const change = await behind();
    const create = vi.spyOn(GitSandbox, 'create').mockRejectedValueOnce(new Error('Temporary sandbox failure'));
    expect(await check(change)).toMatchObject({ status: 'blocked', message: 'Temporary sandbox failure' });
    const responses = await Promise.all([check(change), check(change), check(change)]);
    expect(responses.map((row) => row.status)).toEqual(['ready', 'ready', 'ready']);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rechecks live source files after replay and the target after a cache hit', { timeout: longGitTimeout }, async () => {
    const change = await behind();
    const originalCreate = GitSandbox.create;
    const create = vi.spyOn(GitSandbox, 'create').mockImplementationOnce(async (...args) => {
      const sandbox = await originalCreate(...args);
      const write = sandbox.write.bind(sandbox);
      vi.spyOn(sandbox, 'write').mockImplementation(async (args) => {
        const result = await write(args);
        if (args[0] === 'rebase') await writeFile(path.join(change.worktree, 'task.txt'), 'Changed during replay\n');
        return result;
      });
      return sandbox;
    });
    expect((await check(change)).status).toBe('unknown');
    expect(await readFile(path.join(change.worktree, 'task.txt'), 'utf8')).toBe('Changed during replay\n');
    fx.git('-C', change.worktree, 'restore', 'task.txt');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(2);

    const validate = worktrees.checkoutState;
    vi.spyOn(worktrees, 'checkoutState').mockImplementationOnce((repo, checkout) => {
      fx.git('commit', '--allow-empty', '-qm', 'Primary changed during validation');
      return validate(repo, checkout);
    });
    expect((await check(change)).status).toBe('unknown');
    expect(create).toHaveBeenCalledTimes(2);
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('keys conflict verdicts by the delivery boundary even when both heads stay the same', { timeout: longGitTimeout }, async () => {
    const change = await behind('worktree', true);
    const create = vi.spyOn(GitSandbox, 'create');
    const first = await check(change);
    expect(first).toMatchObject({ status: 'conflict', files: ['src/b.ts'] });
    first.files!.push('Not a real conflict');
    expect(await check(change)).toMatchObject({ status: 'conflict', files: ['src/b.ts'] });
    expect(create).toHaveBeenCalledTimes(1);
    await store.update((state) => {
      (state.workflow!.changes.find((row) => row.id === change.id)! as DevelopmentChange).sourceBase = first.sourceHead;
    });
    expect(await check(change)).toMatchObject({ sourceHead: first.sourceHead, developmentHead: first.developmentHead, status: 'ready' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('invalidates source and inherited sandbox config and does not reuse conditional includes', { timeout: longGitTimeout }, async () => {
    const change = await behind();
    const create = vi.spyOn(GitSandbox, 'create');
    expect((await check(change)).status).toBe('ready');
    fx.git('-C', change.worktree, 'config', 'rebase.backend', 'apply');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(2);

    const global = path.join(data, 'gitconfig');
    await writeFile(global, '[merge]\n\tconflictStyle = diff3\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    expect((await check(change)).status).toBe('ready');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(3);

    await writeFile(global, '[includeIf "gitdir:never-matches"]\n\tpath = missing-config\n');
    expect((await check(change)).status).toBe('ready');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(5);
  });

  it('invalidates replay checks when shared repository configuration or attributes change', { timeout: longGitTimeout }, async () => {
    const change = await behind('shared', true);
    const create = vi.spyOn(GitSandbox, 'create');
    expect((await check(change)).status).toBe('conflict');
    expect((await check(change)).status).toBe('conflict');
    expect(create).toHaveBeenCalledTimes(1);

    const common = path.resolve(change.worktree, fx.git('-C', change.worktree, 'rev-parse', '--git-common-dir').trim());
    fx.git('-C', common, 'config', 'merge.conflictStyle', 'diff3');
    expect((await check(change)).status).toBe('conflict');
    expect(create).toHaveBeenCalledTimes(2);
    await mkdir(path.join(common, 'info'), { recursive: true });
    await writeFile(path.join(common, 'info', 'attributes'), '*.ts merge=union\n');
    expect((await check(change)).status).toBe('ready');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('notices a newly created global attributes file that resolves a previously cached conflict', { timeout: longGitTimeout }, async () => {
    const change = await behind('worktree', true);
    const create = vi.spyOn(GitSandbox, 'create');
    expect((await check(change)).status).toBe('conflict');
    expect((await check(change)).status).toBe('conflict');
    expect(create).toHaveBeenCalledTimes(1);
    const attributes = path.join(data, 'config', 'git', 'attributes');
    await mkdir(path.dirname(attributes), { recursive: true });
    await writeFile(attributes, '*.ts merge=union\n');
    expect((await check(change)).status).toBe('ready');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it.each(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])(
    'does not infer sandbox configuration from the parent when %s is relative',
    { timeout: longGitTimeout },
    async (variable) => {
      const change = await behind('worktree', true);
      const name = `${path.basename(data)}.gitconfig`;
      vi.stubEnv(variable, `../${name}`);
      const create = vi.spyOn(GitSandbox, 'create');
      expect((await check(change)).status).toBe('conflict');
      expect((await check(change)).status).toBe('conflict');
      expect(create).toHaveBeenCalledTimes(2);

      const attributes = path.join(data, 'union-attributes');
      await writeFile(attributes, '*.ts merge=union\n');
      // Only generated sandboxes resolve this relative config path to the operations
      // directory. Neither the source checkout nor the parent config probe sees it.
      await writeFile(path.join(data, 'operations', name), `[core]\n\tattributesFile = ${JSON.stringify(attributes.replaceAll('\\', '/'))}\n`);
      expect((await check(change)).status).toBe('ready');
      expect(create).toHaveBeenCalledTimes(3);
    },
  );

  it('reruns a trial after a clone directory is replaced with the same branch and commits', { timeout: longGitTimeout }, async () => {
    const change = await behind('clone');
    const create = vi.spyOn(GitSandbox, 'create');
    const first = await check(change);
    expect(first.status).toBe('ready');
    const previous = `${change.worktree}-previous`;
    checkouts.push(previous);
    await rename(change.worktree, previous);
    fx.git('clone', '-q', '--no-hardlinks', previous, change.worktree);
    await copyFile(path.join(previous, '.git', 'config'), path.join(change.worktree, '.git', 'config'));
    expect(await check(change)).toMatchObject({ sourceHead: first.sourceHead, developmentHead: first.developmentHead, status: 'ready' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('keeps checks available when Git cannot reveal attribute paths', { timeout: longGitTimeout }, async () => {
    const change = await behind();
    const run = git.runGit;
    vi.spyOn(git, 'runGit').mockImplementation((args, options) => {
      if (args[0] === 'var') return Promise.reject(new Error('Unsupported Git variable'));
      return run(args, options);
    });
    const create = vi.spyOn(GitSandbox, 'create');
    expect((await check(change)).status).toBe('ready');
    expect((await check(change)).status).toBe('ready');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
