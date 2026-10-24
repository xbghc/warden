import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRepo, StateStore, WorkflowService } from './compat/index.js';
import { GitSandbox, oid } from '../packages/engine/src/git-sandbox.js';
import { PreviewService } from '../packages/engine/src/preview.js';
import { sharedRepositoryPath } from '../packages/engine/src/shared-repository.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let store: StateStore;
const timeout = process.platform === 'win32' ? 90_000 : 30_000;
const common = (directory: string) => path.resolve(directory, fx.git('-C', directory, 'rev-parse', '--git-common-dir').trim());

async function replaceGitfile(location: string, contents: Buffer) {
  // Git marks this file hidden on Windows, which refuses opening it with 'w'.
  const file = await open(location, 'r+');
  try {
    await file.truncate(0);
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
}

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-shared-preview-');
  data = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-shared-preview-data-')));
  store = new StateStore(path.join(data, 'state.json'), fx.root);
});

afterEach(async () => {
  for (const slot of [1, 2]) await rm(`${fx.root}-${slot}`, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
  await rm(path.dirname(sharedRepositoryPath(fx.root)), { recursive: true, force: true });
  await fx.cleanup();
});

describe('shared preview worktrees', () => {
  it('keeps concurrent trial heads separate and removes only the finished trial', { timeout }, async () => {
    const head = fx.git('rev-parse', 'HEAD').trim();
    const [a, b] = await Promise.all([GitSandbox.create(store, fx.root, head), GitSandbox.create(store, fx.root, head)]);
    expect(common(a.path)).toBe(common(b.path));
    const changed = await a.commit('First trial');
    expect(changed).not.toBe(head);
    expect(await oid(b.path, 'HEAD')).toBe(head);
    await a.dispose();
    expect(await oid(b.path, 'HEAD')).toBe(head);
    await b.commit('Second trial');
    await b.dispose();
    expect(await readdir(path.join(data, 'operations'))).toEqual([]);
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(head);
  });

  it('rejects operation paths linked to the primary repository', { timeout }, async () => {
    const operations = path.join(data, 'operations');
    await mkdir(operations);
    const location = path.join(operations, 'git-foreign');
    fx.git('worktree', 'add', '-q', '--detach', location, 'HEAD');
    const foreign = GitSandbox.open(store, location);
    await expect(foreign.commit()).rejects.toThrow('Invalid operation repository');
    await expect(foreign.dispose()).rejects.toThrow('Invalid operation repository');
    expect(await readFile(path.join(location, 'README.md'), 'utf8')).toBe('# fixture\n');
    fx.git('worktree', 'remove', location);
  });

  it('rejects a sandbox gitfile redirected to another worktree private metadata', { timeout }, async () => {
    const head = fx.git('rev-parse', 'HEAD').trim();
    const a = await GitSandbox.create(store, fx.root, head);
    const b = await GitSandbox.create(store, fx.root, head);
    const original = await readFile(path.join(a.path, '.git'));
    const otherHead = await b.commit('Preserve the other worktree');
    const indexPath = path.resolve(b.path, fx.git('-C', b.path, 'rev-parse', '--git-path', 'index').trim());
    const index = await readFile(indexPath);
    await replaceGitfile(path.join(a.path, '.git'), await readFile(path.join(b.path, '.git')));
    try {
      await expect(a.write(['update-ref', 'HEAD', head])).rejects.toThrow('Invalid operation repository');
      await expect(a.apply('', true)).rejects.toThrow('Invalid operation repository');
      await expect(a.dispose()).rejects.toThrow('Invalid operation repository');
      expect(await oid(b.path, 'HEAD')).toBe(otherHead);
      expect(await readFile(indexPath)).toEqual(index);
    } finally {
      await replaceGitfile(path.join(a.path, '.git'), original);
      await a.dispose();
      await b.dispose();
    }
  });

  it('shares task objects while keeping internal hooks and cleanup local to the sandbox', { timeout }, async () => {
    const head = fx.git('rev-parse', 'HEAD').trim();
    const sandbox = await GitSandbox.create(store, fx.root, head);
    const repository = sharedRepositoryPath(fx.root);
    const task = `${fx.root}-1`;
    fx.git('-C', repository, 'worktree', 'add', '-qb', 'agent/task', task, head);
    await writeFile(path.join(task, 'agent.txt'), 'Agent code\n');
    fx.git('-C', task, 'add', 'agent.txt');
    fx.git('-C', task, 'commit', '-qm', 'Agent source');
    const source = fx.git('-C', task, 'rev-parse', 'HEAD').trim();
    expect(common(task)).toBe(repository);
    expect(common(sandbox.path)).toBe(repository);
    expect(common(fx.root)).not.toBe(repository);
    expect(await oid(sandbox.path, source)).toBe(source);
    expect(() => fx.git('cat-file', '-e', `${source}^{commit}`)).toThrow();

    const hooks = path.join(data, 'hooks');
    await mkdir(hooks);
    await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    await chmod(path.join(hooks, 'pre-commit'), 0o755);
    fx.git('-C', task, 'config', 'core.hooksPath', hooks);
    fx.git('-C', task, 'config', 'rebase.updateRefs', 'true');
    await sandbox.fetch(task, source);
    await sandbox.write(['cherry-pick', source]);
    const composed = await sandbox.commit();
    expect(await readFile(path.join(sandbox.path, 'agent.txt'), 'utf8')).toBe('Agent code\n');
    expect(fx.git('-C', task, 'config', '--get', 'core.hooksPath').trim()).toBe(hooks);
    expect(fx.git('-C', task, 'config', '--get', 'rebase.updateRefs').trim()).toBe('true');
    expect(() => fx.git('-C', task, 'commit', '--allow-empty', '-qm', 'Task hook still runs')).toThrow();
    expect(fx.git('-C', task, 'rev-parse', 'HEAD').trim()).toBe(source);
    expect(() => fx.git('cat-file', '-e', `${composed}^{commit}`)).toThrow();

    await sandbox.dispose();
    const registered = fx
      .git('-C', repository, 'worktree', 'list', '--porcelain', '-z')
      .split('\0')
      .filter((field) => field.startsWith('worktree '))
      .map((field) => path.resolve(field.slice('worktree '.length)));
    expect(registered).not.toContain(sandbox.path);
    expect(fx.git('-C', task, 'rev-parse', 'HEAD').trim()).toBe(source);
    expect(await readdir(path.join(data, 'operations'))).toEqual([]);
  });

  it('publishes dirty primary and task content through a shared preview and preserves its last coherent version', { timeout }, async () => {
    const repo = await resolveRepo(fx.root);
    const workflow = new WorkflowService(repo, store);
    await workflow.configure('main');
    const a = await workflow.start((await workflow.create({ title: 'A' })).id, { kind: 'shared' });
    const b = await workflow.start((await workflow.create({ title: 'B' })).id, { kind: 'shared' });
    await fx.write('mock.txt', 'Human mock\n');
    await writeFile(path.join(a.worktree, 'src/b.ts'), 'export const b = 10;\n');
    await writeFile(path.join(b.worktree, 'src/b.ts'), 'export const b = 20;\n');
    const index = await readFile(path.join(fx.root, '.git', 'index'));
    const head = fx.git('rev-parse', 'HEAD');
    const refs = fx.git('show-ref');
    const aIndex = await readFile(path.resolve(a.worktree, fx.git('-C', a.worktree, 'rev-parse', '--git-path', 'index').trim()));
    const preview = new PreviewService(repo, store);
    const first = await preview.set([a.id]);
    expect(common(first.worktree!)).toBe(common(a.worktree));
    expect(common(first.worktree!)).toBe(common(b.worktree));
    expect(await readFile(path.join(first.worktree!, 'mock.txt'), 'utf8')).toBe('Human mock\n');
    expect(await readFile(path.join(first.worktree!, 'src/b.ts'), 'utf8')).toBe('export const b = 10;\n');
    await expect(preview.set([a.id, b.id])).rejects.toMatchObject({ code: 'preview_conflict' });
    expect((await preview.get()).connectedIds).toEqual([a.id]);
    expect(await readFile(path.join(first.worktree!, 'src/b.ts'), 'utf8')).toBe('export const b = 10;\n');
    expect(await readFile(path.join(fx.root, '.git', 'index'))).toEqual(index);
    expect(await readFile(path.resolve(a.worktree, fx.git('-C', a.worktree, 'rev-parse', '--git-path', 'index').trim()))).toEqual(aIndex);
    expect(fx.git('rev-parse', 'HEAD')).toBe(head);
    expect(fx.git('show-ref')).toBe(refs);
    expect(await readdir(path.join(data, 'operations'))).toEqual([path.basename(first.worktree!)]);

    const previewGitfile = path.join(first.worktree!, '.git');
    const original = await readFile(previewGitfile);
    const sourceHead = fx.git('-C', a.worktree, 'rev-parse', 'HEAD');
    await replaceGitfile(previewGitfile, await readFile(path.join(a.worktree, '.git')));
    try {
      await preview.tick();
      expect(await preview.get()).toMatchObject({ status: 'stale', syncStatus: 'error' });
      expect(fx.git('-C', a.worktree, 'rev-parse', 'HEAD')).toBe(sourceHead);
      expect(await readFile(path.resolve(a.worktree, fx.git('-C', a.worktree, 'rev-parse', '--git-path', 'index').trim()))).toEqual(aIndex);
    } finally {
      await replaceGitfile(previewGitfile, original);
    }
    expect((await preview.refresh()).syncStatus).toBe('synced');
  });

  it('refreshes an existing standalone preview without moving its runtime or replacing ignored dependencies', { timeout }, async () => {
    const repo = await resolveRepo(fx.root);
    const workflow = new WorkflowService(repo, store);
    await workflow.configure('main');
    const operations = path.join(data, 'operations');
    await mkdir(operations);
    const runtime = await mkdtemp(path.join(operations, 'git-'));
    const head = fx.git('rev-parse', 'HEAD').trim();
    const tree = fx.git('rev-parse', 'HEAD^{tree}').trim();
    fx.git('init', '-q', '--template=', runtime);
    fx.git('-C', runtime, 'fetch', '-q', '--no-tags', fx.root, head);
    fx.git('-C', runtime, 'checkout', '-q', '--detach', head);
    await mkdir(path.join(runtime, '.git', 'info'));
    await writeFile(path.join(runtime, '.git', 'info', 'exclude'), 'runtime-cache.txt\n');
    await writeFile(path.join(runtime, 'runtime-cache.txt'), 'Keep environment\n');
    await store.update((state) => {
      state.connectionPreview = {
        connectedIds: [],
        files: [],
        status: 'disconnected',
        syncStatus: 'synced',
        developmentBranch: 'main',
        developmentHead: head,
        worktree: runtime,
        directory: runtime,
        baselineTree: tree,
        tree,
        snapshot: head,
      };
    });
    await fx.write('human.txt', 'Saved human content\n');
    const preview = new PreviewService(repo, store);
    const result = await preview.refresh();
    expect(result).toMatchObject({ worktree: runtime, status: 'disconnected', syncStatus: 'synced' });
    expect(common(runtime)).toBe(path.join(runtime, '.git'));
    expect(await readFile(path.join(runtime, 'human.txt'), 'utf8')).toBe('Saved human content\n');
    expect(await readFile(path.join(runtime, 'runtime-cache.txt'), 'utf8')).toBe('Keep environment\n');
    expect(await readdir(operations)).toEqual([path.basename(runtime)]);
  });
});
