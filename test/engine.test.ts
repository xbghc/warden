import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, PreviewService, WardenError, WorkflowService } from '@warden/engine';
import { DiagnosticLog } from '@warden/shared';
import type { DevelopmentChange } from '@warden/shared';
import * as worktrees from '../packages/engine/src/worktrees.js';
import * as git from '../packages/engine/src/git.js';
import { checkoutWorktree } from '../packages/engine/src/worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fixture: FixtureRepo;
let directory: string;
let engine: Engine;
const engines: Engine[] = [];
beforeEach(async () => {
  fixture = await makeFixtureRepo('warden-engine-');
  directory = await mkdtemp(path.join(os.tmpdir(), 'warden-engine-data-'));
  engine = await Engine.open(fixture.root, path.join(directory, 'state.json'));
  engines.push(engine);
  await engine.execute('workflow.configure', { branch: 'main' });
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((instance) => instance.close()));
  vi.restoreAllMocks();
  for (const slot of [1, 2, 3]) await rm(`${fixture.root}-${slot}`, { recursive: true, force: true });
  await fixture.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe('desktop engine', () => {
  it('logs operation outcomes and codes without task or repository contents', async () => {
    const rows: Array<{ level: string; [key: string]: unknown }> = [];
    const log = new DiagnosticLog((level, line) => rows.push({ level, ...JSON.parse(line.slice('[diagnostic] '.length)) }));
    const logged = await Engine.open(fixture.root, engine.store.file, log);
    engines.push(logged);
    await logged.execute('config.save', { hooks: {}, previewSetup: 'private-script-value' });
    await logged.execute('workflow.get', undefined);
    await expect(logged.execute('task.update', { taskId: '', title: 'private-title' })).rejects.toMatchObject({ code: 'invalid_request' });
    await logged.close();
    expect(rows).toContainEqual(expect.objectContaining({ event: 'engine.execute.start', method: 'config.save', level: 'info' }));
    expect(rows).toContainEqual(expect.objectContaining({ event: 'engine.execute.end', method: 'workflow.get', level: 'trace', outcome: 'ok' }));
    expect(rows).toContainEqual(expect.objectContaining({ event: 'engine.execute.end', method: 'task.update', level: 'error', code: 'invalid_request' }));
    expect(rows).toContainEqual(expect.objectContaining({ event: 'engine.close.end', outcome: 'ok' }));
    expect(new Set(rows.map((row) => row.engine)).size).toBe(1);
    for (const value of ['private-script-value', 'private-title', fixture.root]) expect(JSON.stringify(rows)).not.toContain(value);
  });
  it('shares one workspace inventory per repository read and observes later external edits', async () => {
    const task = await engine.execute('task.create', { title: 'Observed task' });
    const inventory = vi.spyOn(worktrees, 'listWorktreesDetailed');
    const checks = vi.spyOn(WorkflowService.prototype, 'rebaseChecks');
    const first = await engine.execute('repository.get', undefined);
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(checks).not.toHaveBeenCalled();
    expect(first.workflow.workflow?.changes).toContainEqual(expect.objectContaining({ id: task.id }));
    expect(first.workspaces.worktrees).toContainEqual(expect.objectContaining({ path: task.worktree, dirty: 0 }));
    expect(first.preview.status).toBe('disconnected');

    await writeFile(path.join(task.worktree!, 'external.txt'), 'External edit\n');
    const second = await engine.execute('repository.get', undefined);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(second.workspaces.worktrees).toContainEqual(expect.objectContaining({ path: task.worktree, dirty: 1 }));
    expect(first.workspaces.worktrees).toContainEqual(expect.objectContaining({ path: task.worktree, dirty: 0 }));
    expect((await engine.execute('rebase.check', undefined)).checks).toContainEqual(expect.objectContaining({ changeId: task.id, status: 'blocked' }));
    expect(inventory).toHaveBeenCalledTimes(3);
  });

  it('does not retain a failed or concurrent repository inventory for another read', async () => {
    await engine.execute('task.create', { title: 'Retained task' });
    const inventory = vi.spyOn(worktrees, 'listWorktreesDetailed');
    inventory.mockRejectedValueOnce(new Error('Inventory unavailable'));
    await expect(engine.execute('repository.get', undefined)).rejects.toThrow('Inventory unavailable');
    const [first, second] = await Promise.all([engine.execute('repository.get', undefined), engine.execute('repository.get', undefined)]);
    expect(inventory).toHaveBeenCalledTimes(3);
    expect(first.workflow.error).toBeUndefined();
    expect(second.workflow.workflow?.changes).toHaveLength(1);
  });

  it('reads workspace safety and rebase state without retired management-page graph comparisons', async () => {
    const workflow = new WorkflowService(engine.repo, engine.store);
    const shared = await workflow.start((await workflow.create({ title: 'Shared task' })).id, { kind: 'shared' });
    const clone = await engine.execute('task.create', { title: 'Clone task' });
    await writeFile(path.join(shared.worktree!, 'pending.txt'), 'Pending edit\n');
    const reads = vi.spyOn(git, 'runGit');
    const list = await engine.execute('workspaces.list', undefined);
    expect(list.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: shared.worktree, shared: true, dirty: 1, free: false }),
        expect.objectContaining({ path: clone.worktree, clone: true, dirty: 0, free: false }),
      ]),
    );
    expect(list.branches).toContainEqual(expect.objectContaining({ name: 'main', worktree: fixture.root }));
    expect((await engine.execute('workflow.get', undefined)).workflow?.changes).toHaveLength(2);
    expect((await engine.execute('rebase.check', undefined)).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ changeId: shared.id, status: 'blocked' }),
        expect.objectContaining({ changeId: clone.id, status: 'current' }),
      ]),
    );
    expect(
      reads.mock.calls.filter(([args]) => args.some((arg) => arg.includes('%(upstream:track)')) || (args[0] === 'rev-list' && args.includes('--left-right'))),
    ).toEqual([]);
  });

  it('composes default clone tasks into preview and follows their later commits without touching primary', async () => {
    const primaryHead = fixture.git('rev-parse', 'HEAD').trim();
    const primaryRefs = fixture.git('show-ref');
    const a = await engine.execute('task.create', { title: 'Clone A' });
    const b = await engine.execute('task.create', { title: 'Clone B' });
    for (const task of [a, b]) expect(fixture.git('-C', task.worktree!, 'rev-parse', '--git-dir').trim()).toBe('.git');
    await writeFile(path.join(a.worktree!, 'a.txt'), 'Committed A\n');
    fixture.git('-C', a.worktree!, 'add', 'a.txt');
    fixture.git('-C', a.worktree!, 'commit', '-qm', 'Add A');
    await writeFile(path.join(a.worktree!, 'draft.txt'), 'Uncommitted A\n');
    await writeFile(path.join(b.worktree!, 'b.txt'), 'Uncommitted B\n');
    const preview = await engine.execute('preview.connect', { connectedIds: [a.id, b.id] });
    expect(preview).toMatchObject({ connectedIds: [a.id, b.id], syncStatus: 'synced' });
    expect(await readFile(path.join(preview.worktree!, 'a.txt'), 'utf8')).toBe('Committed A\n');
    expect(await readFile(path.join(preview.worktree!, 'draft.txt'), 'utf8')).toBe('Uncommitted A\n');
    expect(await readFile(path.join(preview.worktree!, 'b.txt'), 'utf8')).toBe('Uncommitted B\n');

    // A later agent commit in one clone replaces its earlier contribution on the next refresh.
    await writeFile(path.join(a.worktree!, 'a.txt'), 'Second A\n');
    fixture.git('-C', a.worktree!, 'add', '.');
    fixture.git('-C', a.worktree!, 'commit', '-qm', 'Revise A');
    const later = fixture.git('-C', a.worktree!, 'rev-parse', 'HEAD').trim();
    expect(await engine.execute('preview.refresh', undefined)).toMatchObject({ worktree: preview.worktree, syncStatus: 'synced' });
    expect(await readFile(path.join(preview.worktree!, 'a.txt'), 'utf8')).toBe('Second A\n');
    expect(await readFile(path.join(preview.worktree!, 'b.txt'), 'utf8')).toBe('Uncommitted B\n');

    const disconnected = await engine.execute('preview.connect', { connectedIds: [b.id] });
    expect(await readdir(disconnected.worktree!)).not.toContain('a.txt');
    expect(await readFile(path.join(disconnected.worktree!, 'b.txt'), 'utf8')).toBe('Uncommitted B\n');
    expect(() => fixture.git('cat-file', '-e', later)).toThrow();
    expect(fixture.git('rev-parse', 'HEAD').trim()).toBe(primaryHead);
    expect(fixture.git('show-ref')).toBe(primaryRefs);
    expect(fixture.git('status', '--porcelain')).toBe('');
  });

  it('initializes and recovers a CRLF preview while protecting real preview edits', async () => {
    const original = '@echo off\r\necho Original\r\n';
    await fixture.write('gradlew.bat', original);
    fixture.git('-c', 'core.autocrlf=false', 'add', 'gradlew.bat');
    fixture.git('commit', '-qm', 'Keep a CRLF wrapper');
    const config = path.join(directory, 'global.gitconfig');
    await writeFile(config, '[core]\n\tautocrlf = input\n\tsafecrlf = true\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    try {
      await fixture.write('README.md', 'Saved primary edit\n');
      const index = await readFile(path.join(fixture.root, '.git', 'index'));
      const head = fixture.git('rev-parse', 'HEAD');
      const first = await engine.execute('preview.refresh', undefined);
      expect(first).toMatchObject({ syncStatus: 'synced', connectedIds: [] });
      expect(await readFile(path.join(first.worktree!, 'gradlew.bat'), 'utf8')).toBe(original);
      expect(await readFile(path.join(first.worktree!, 'README.md'), 'utf8')).toBe('Saved primary edit\n');
      await engine.store.update((state) => {
        state.connectionPreview!.status = 'stale';
        state.connectionPreview!.syncStatus = 'error';
        state.connectionPreview!.message = 'The preview folder has unexpected changes. Sync stopped; edit code in the primary folder.';
      });
      expect(await engine.execute('preview.refresh', undefined)).toMatchObject({ worktree: first.worktree, syncStatus: 'synced' });
      await writeFile(path.join(first.worktree!, 'gradlew.bat'), '@echo off\r\necho Preview edit\r\n');
      await expect(engine.execute('preview.connect', { connectedIds: [] })).rejects.toMatchObject({ code: 'preview_dirty' });
      expect(await readFile(path.join(first.worktree!, 'gradlew.bat'), 'utf8')).toContain('Preview edit');
      await writeFile(path.join(first.worktree!, 'gradlew.bat'), original);
      expect(await engine.execute('preview.refresh', undefined)).toMatchObject({ worktree: first.worktree, syncStatus: 'synced' });
      expect(await readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
      expect(fixture.git('rev-parse', 'HEAD')).toBe(head);
      expect(await readFile(path.join(fixture.root, 'README.md'), 'utf8')).toBe('Saved primary edit\n');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads long committed file names without treating revision expressions as disk paths', async () => {
    // The file itself fits each filesystem; the additional object ID can exceed its path limit.
    const file = `${'long'.repeat(process.platform === 'win32' ? 40 : 55)}.txt`;
    await fixture.write(file, 'Committed content\n');
    fixture.git('add', file);
    fixture.git('commit', '-qm', 'Add a long file name');
    const key = `commit:${fixture.git('rev-parse', 'HEAD').trim()}`;
    expect((await engine.execute('review.file', { key, file, side: 'new' })).content).toBe('Committed content\n');
    await fixture.write(file, 'Staged content\n');
    fixture.git('add', file);
    expect((await engine.execute('review.file', { key: 'staged', file, side: 'old' })).content).toBe('Committed content\n');
    expect((await engine.execute('review.file', { key: 'staged', file, side: 'new' })).content).toBe('Staged content\n');
  });

  it('reviews submodule versions without requiring their objects in the primary repository', async () => {
    const before = '1'.repeat(40);
    const after = '2'.repeat(40);
    fixture.git('update-index', '--add', '--cacheinfo', `160000,${before},dependency`);
    fixture.git('commit', '-qm', 'Record external submodule version');
    fixture.git('update-index', '--cacheinfo', `160000,${after},dependency`);
    fixture.git('commit', '-qm', 'Update external submodule version');
    const key = `commit:${fixture.git('rev-parse', 'HEAD').trim()}`;
    expect((await engine.execute('review.files', { key })).files.map((file) => file.path)).toEqual(['dependency']);
    expect((await engine.execute('review.file', { key, file: 'dependency', side: 'old' })).content).toBe(`Subproject commit ${before}\n`);
    expect((await engine.execute('review.file', { key, file: 'dependency', side: 'new' })).content).toBe(`Subproject commit ${after}\n`);
  });

  it('refreshes the persistent preview and its setup environment across branches at the same commit', async () => {
    await fixture.write('.gitignore', 'node_modules/\n');
    fixture.git('add', '.gitignore');
    fixture.git('commit', '-qm', 'Ignore runtime dependencies');
    fixture.git('branch', 'feature/other');
    await engine.execute('config.save', {
      hooks: {},
      previewSetup: 'mkdir -p node_modules; printf "%s" "$WARDEN_DEVELOPMENT_BRANCH" > node_modules/branch',
    });
    const first = await engine.execute('preview.refresh', undefined);
    expect(first.setup?.status).toBe('succeeded');
    expect(await readFile(path.join(first.worktree!, 'node_modules/branch'), 'utf8')).toBe('main');
    await writeFile(path.join(first.worktree!, 'node_modules/retained'), 'dependency cache');
    fixture.git('switch', 'feature/other');
    await engine.execute('workflow.configure', { branch: 'feature/other' });
    expect((await engine.execute('preview.get', undefined)).syncStatus).toBe('pending');
    const next = await engine.execute('preview.refresh', undefined);
    expect(next.developmentBranch).toBe('feature/other');
    expect(next.developmentHead).toBe(first.developmentHead);
    expect(next.worktree).toBe(first.worktree);
    expect(next.syncStatus).toBe('synced');
    expect(next.setup?.status).toBe('succeeded');
    expect(await readFile(path.join(next.worktree!, 'node_modules/branch'), 'utf8')).toBe('feature/other');
    expect(await readFile(path.join(next.worktree!, 'node_modules/retained'), 'utf8')).toBe('dependency cache');
  });

  it('remembers explicitly selected branches without tasks and leaves unrelated checkouts untracked', async () => {
    fixture.git('switch', '-c', 'feature/empty');
    await engine.execute('workflow.configure', { branch: 'feature/empty' });
    fixture.git('switch', 'main');
    await engine.execute('workflow.configure', { branch: 'main' });
    await engine.close();
    const reopened = await Engine.open(fixture.root, engine.store.file);
    engines.push(reopened);
    fixture.git('switch', '-c', 'unrelated');
    const state = await readFile(engine.store.file, 'utf8');
    const result = await reopened.execute('repository.get', undefined);
    expect(result.workflow.workflow).toMatchObject({ developmentBranch: 'main', trackedBranches: ['main', 'feature/empty'], changes: [] });
    expect(await readFile(engine.store.file, 'utf8')).toBe(state);
  });

  it('requires explicit selection before reactivating a legacy empty branch and its preview', async () => {
    await engine.execute('preview.refresh', undefined);
    await engine.store.update((state) => {
      delete state.workflow!.trackedBranches;
    });
    const state = await readFile(engine.store.file, 'utf8');
    await fixture.write('later.txt', 'Primary changes after migration\n');
    await new PreviewService(engine.repo, engine.store, 0).tick();
    expect((await engine.execute('workflow.get', undefined)).workflow?.trackedBranches).toEqual([]);
    expect(await readFile(engine.store.file, 'utf8')).toBe(state);
    await engine.execute('workflow.configure', { branch: 'main' });
    expect((await engine.execute('workflow.get', undefined)).workflow?.trackedBranches).toEqual(['main']);
    await new PreviewService(engine.repo, engine.store, 0).tick();
    const preview = await engine.execute('preview.get', undefined);
    expect(await readFile(path.join(preview.worktree!, 'later.txt'), 'utf8')).toBe('Primary changes after migration\n');
  });

  it('suspends automatic preview updates away from the base branch and resumes retained connections on return', async () => {
    const task = await engine.execute('task.create', { title: 'Retained connection' });
    await writeFile(path.join(task.worktree!, 'connected.txt'), 'First task edit\n');
    const preview = await engine.execute('preview.connect', { connectedIds: [task.id] });
    const observer = new PreviewService(engine.repo, engine.store, 0);
    const saved = await readFile(engine.store.file, 'utf8');
    fixture.git('switch', '-c', 'unrelated');
    await fixture.write('unrelated.txt', 'Unrelated work\n');
    await writeFile(path.join(task.worktree!, 'connected.txt'), 'Later task edit\n');
    await observer.tick();
    await observer.tick();
    expect(await readFile(engine.store.file, 'utf8')).toBe(saved);
    expect(await readFile(path.join(preview.worktree!, 'connected.txt'), 'utf8')).toBe('First task edit\n');
    await expect(readFile(path.join(preview.worktree!, 'unrelated.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    fixture.git('switch', '--detach');
    await observer.tick();
    expect(await readFile(engine.store.file, 'utf8')).toBe(saved);
    await rm(path.join(fixture.root, 'unrelated.txt'));
    fixture.git('switch', 'main');
    await observer.tick();
    expect(await readFile(path.join(preview.worktree!, 'connected.txt'), 'utf8')).toBe('Later task edit\n');
    expect(await engine.execute('preview.get', undefined)).toMatchObject({ connectedIds: [task.id], syncStatus: 'synced' });
  });

  it('rejects an old branch request after it waits behind another window switching requirements', async () => {
    fixture.git('branch', 'feature/other');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = engine.store.withRepositoryLock(async () => {
      entered();
      await gate;
    });
    await held;
    let waiting!: () => void;
    const attempted = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const lock = engine.store.withRepositoryLock.bind(engine.store);
    vi.spyOn(engine.store, 'withRepositoryLock').mockImplementation((fn) => {
      waiting();
      return lock(fn);
    });
    const rejected = expect(engine.execute('task.create', { title: 'Stale A task' }, { developmentBranch: 'main' })).rejects.toMatchObject({
      code: 'requirement_changed',
    });
    try {
      await attempted;
      await engine.store.update((state) => {
        state.workflow!.developmentBranch = 'feature/other';
      });
    } finally {
      release();
      await holding;
    }
    await rejected;
    expect((await engine.execute('workflow.get', undefined)).workflow!.changes).toHaveLength(0);
    const current = await engine.execute('task.create', { title: 'Current B task' }, { developmentBranch: 'feature/other' });
    expect(current.developmentBranch).toBe('feature/other');
    expect((await engine.execute('task.create', { title: 'Unscoped task' })).developmentBranch).toBe('feature/other');
  });

  it('allocates a fresh logical workspace in a clean free directory without inheriting an old branch', async () => {
    const base = fixture.git('rev-parse', 'HEAD').trim();
    const old = await checkoutWorktree(engine.repo, { slot: 1, branch: 'old-task', base, kind: 'clone' });
    await writeFile(path.join(old.worktree.path, 'old.txt'), 'Old work\n');
    fixture.git('-C', old.worktree.path, 'add', '.');
    fixture.git('-C', old.worktree.path, 'commit', '-qm', 'Old task');
    fixture.git('-C', old.worktree.path, 'switch', '--detach');
    const task = await engine.execute('task.create', { title: 'New workspace' });
    expect(task.status).toBe('working');
    if (!task.worktree) throw new Error('Task creation must allocate a workspace');
    expect(task.worktree).toBe(old.worktree.path);
    expect(task.branch).not.toBe('old-task');
    expect(task.base).toBe(base);
    expect(task.deliveries).toBeUndefined();
    expect(fixture.git('-C', task.worktree, 'rev-parse', 'HEAD').trim()).toBe(base);
    await expect(readFile(path.join(task.worktree, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await engine.execute('task.create', { title: 'Another workspace' });
    expect(next.worktree).toBeTruthy();
    expect(next.worktree).not.toBe(task.worktree);
    expect((await engine.execute('task.start', { taskId: task.id })).worktree).toBe(task.worktree);
    expect(fixture.git('status', '--porcelain')).toBe('');
  });

  it('keeps a failed allocation on its task and retries once across concurrent requests', async () => {
    const allocation = vi.spyOn(worktrees, 'checkoutWorktree').mockRejectedValueOnce(new WardenError(409, 'Allocation unavailable', 'checkout_unavailable'));
    const task = await engine.execute('task.create', { title: 'Retained task' });
    expect(task).toMatchObject({ status: 'planned', workspaceError: { message: 'Allocation unavailable', code: 'checkout_unavailable' } });
    expect(task.worktree).toBeUndefined();
    const persisted = (await engine.execute('workflow.get', undefined)).workflow!.changes;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(task);
    const [first, second] = await Promise.all([engine.execute('task.start', { taskId: task.id }), engine.execute('task.start', { taskId: task.id })]);
    expect(first).toMatchObject({ id: task.id, title: task.title, status: 'working' });
    expect(second.worktree).toBe(first.worktree);
    expect(first.workspaceError).toBeUndefined();
    expect(allocation).toHaveBeenCalledTimes(2);
    expect((await engine.execute('workflow.get', undefined)).workflow!.changes).toHaveLength(1);
  });

  it('resumes a task workspace whose allocation was interrupted after checkout', async () => {
    const real = worktrees.checkoutWorktree;
    let orphan: string | undefined;
    vi.spyOn(worktrees, 'checkoutWorktree').mockImplementationOnce(async (...args) => {
      const created = await real(...args);
      orphan = created.worktree.path;
      // The checkout exists, but nothing recorded it before the failure.
      throw new WardenError(500, 'Interrupted after checkout', 'git_failed');
    });
    const task = await engine.execute('task.create', { title: 'Interrupted allocation' });
    expect(task).toMatchObject({ status: 'planned', workspaceError: { code: 'git_failed' } });
    expect(orphan).toBeTruthy();
    const resumed = await engine.execute('task.start', { taskId: task.id });
    expect(resumed).toMatchObject({ id: task.id, status: 'working', worktree: orphan, ownsBranch: true });
    expect(resumed.workspaceError).toBeUndefined();
    expect(fixture.git('-C', orphan!, 'branch', '--show-current').trim()).toBe(resumed.branch);
    // A different task never takes over that workspace.
    const other = await engine.execute('task.create', { title: 'Other task' });
    expect(other.worktree).not.toBe(orphan);
  });

  it('runs initialization during creation and preserves its workspace when the script fails', async () => {
    await engine.execute('config.save', { hooks: { create: 'echo retained > hook.txt; exit 1' } });
    const task = await engine.execute('task.create', { title: 'Script failure' });
    expect(task.status).toBe('working');
    if (!task.worktree) throw new Error('Script failure must retain the assigned workspace');
    expect(task.workspaceHook?.status).toBe('failed');
    expect(task.workspaceError).toBeUndefined();
    expect(await readFile(path.join(task.worktree, 'hook.txt'), 'utf8')).toContain('retained');
    await engine.execute('config.save', { hooks: { create: 'echo retried >> hook.txt' } });
    const retried = await engine.execute('task.hook', { taskId: task.id });
    expect(retried.worktree).toBe(task.worktree);
    expect(retried.workspaceHook?.status).toBe('succeeded');
    expect(await readFile(path.join(task.worktree, 'hook.txt'), 'utf8')).toMatch(/retained\s+retried/);
  });

  it('reports a setup script interrupted by its exited process as retryable', async () => {
    const task = await engine.execute('task.create', { title: 'Interrupted script' });
    const running = { event: 'create' as const, command: 'pnpm install', status: 'running' as const };
    const exited = { pid: 2 ** 31 - 2, hostname: os.hostname() };
    await engine.store.update((state) => {
      const row = state.workflow!.changes.find((change): change is DevelopmentChange => change.id === task.id && !!change.worktree)!;
      row.workspaceHook = { ...running, owner: exited };
      // Older records without an owner, and live owners, may still be running elsewhere.
      state.workflow!.changes.push({ ...row, id: 'live', workspaceHook: { ...running, owner: { pid: process.pid, hostname: os.hostname() } } });
      state.workflow!.changes.push({ ...row, id: 'legacy', workspaceHook: running });
    });
    const rows = (await engine.execute('workflow.get', undefined)).workflow!.changes as DevelopmentChange[];
    const interrupted = rows.find((row) => row.id === task.id)!.workspaceHook!;
    expect(interrupted).toMatchObject({ status: 'failed', exitCode: null, command: 'pnpm install', output: expect.stringContaining('interrupted') });
    expect(interrupted.owner).toBeUndefined();
    expect(rows.find((row) => row.id === 'live')!.workspaceHook!.status).toBe('running');
    expect(rows.find((row) => row.id === 'legacy')!.workspaceHook!.status).toBe('running');
    await engine.store.update((state) => {
      state.workflow!.changes = state.workflow!.changes.filter((change) => change.id === task.id);
    });
    await engine.execute('config.save', { hooks: { create: 'echo retried > hook.txt' } });
    const retried: DevelopmentChange = await engine.execute('task.hook', { taskId: task.id });
    expect(retried.workspaceHook).toEqual({ event: 'create', command: 'echo retried > hook.txt', status: 'succeeded', exitCode: 0, output: '' });
  });

  it('allocates legacy plans on demand and preserves archived plans until restoration', async () => {
    const workflow = new WorkflowService(engine.repo, engine.store);
    const plan = await workflow.create({ title: 'Legacy plan' });
    expect((await engine.execute('workflow.get', undefined)).workflow!.changes[0]!.worktree).toBeUndefined();
    await engine.execute('task.update', { taskId: plan.id, status: 'archived' });
    await expect(engine.execute('task.start', { taskId: plan.id })).rejects.toMatchObject({ code: 'change_not_planned' });
    await engine.execute('task.update', { taskId: plan.id, status: 'planned' });
    const ready = await engine.execute('task.start', { taskId: plan.id });
    expect(ready.worktree).toBeTruthy();
    expect(ready.id).toBe(plan.id);
    fixture.git('branch', 'feature/other');
    await engine.execute('workflow.configure', { branch: 'feature/other' });
    await expect(engine.execute('task.start', { taskId: plan.id })).rejects.toMatchObject({ code: 'requirement_changed' });
  });

  it('preserves structured errors and rejects adoption through the desktop API', async () => {
    await expect(engine.execute('task.create', { title: '' })).rejects.toMatchObject({ code: 'invalid_title' });
    const plan = await engine.execute('task.create', { title: 'Task' });
    await expect(engine.execute('task.start', { taskId: plan.id, worktree: fixture.root } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await engine.execute('workflow.get', undefined)).workflow?.changes[0]?.worktree).toBe(plan.worktree);
    expect(fixture.git('status', '--porcelain')).toBe('');
  });

  it('keeps state-only observers out of preview ownership across workbench replacement', async () => {
    const observer = await Engine.open(fixture.root, engine.store.file);
    engines.push(observer);
    const claims = vi.spyOn(observer.store, 'acquirePreviewLease');
    const owners = new Set<PreviewService>();
    const ticks = vi.spyOn(PreviewService.prototype, 'tick').mockImplementation(async function (this: PreviewService) {
      owners.add(this);
    });
    const errors: unknown[] = [];
    let titles: string[] = [];
    const starting = observer.start(
      async () => {
        titles = (await observer.store.load()).workflow?.changes.map((task) => task.title) ?? [];
      },
      (error) => errors.push(error),
      'state',
    );
    // A concurrent start must not widen the original scope or replace its callback.
    const repeated = observer.start(
      async () => {
        throw new Error('The state observer was replaced');
      },
      (error) => errors.push(error),
    );
    await Promise.all([starting, repeated]);
    const task = await engine.execute('task.create', { title: 'Observed state' });
    await vi.waitFor(() => expect(titles).toContain('Observed state'));
    await observer.execute('repository.get', undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(claims).not.toHaveBeenCalled();
    expect(ticks).not.toHaveBeenCalled();
    expect((await engine.execute('preview.get', undefined)).worktree).toBeUndefined();

    await engine.start(
      async () => {},
      (error) => errors.push(error),
    );
    await vi.waitFor(() => expect(owners.size).toBe(1), { timeout: 3000 });
    await engine.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(claims).not.toHaveBeenCalled();
    expect(owners.size).toBe(1);

    const replacement = await Engine.open(fixture.root, observer.store.file);
    engines.push(replacement);
    await replacement.start(
      async () => {},
      (error) => errors.push(error),
    );
    await vi.waitFor(() => expect(owners.size).toBe(2), { timeout: 3000 });
    await replacement.execute('task.update', { taskId: task.id, title: 'Updated after replacement' });
    await vi.waitFor(() => expect(titles).toEqual(['Updated after replacement']));
    expect(claims).not.toHaveBeenCalled();
    expect(owners.size).toBe(2);
    expect(errors).toEqual([]);
  });

  it('drains an in-flight state-only notification and stops observing after close', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const errors: unknown[] = [];
    let calls = 0;
    await engine.start(
      async () => {
        calls++;
        entered();
        await gate;
      },
      (error) => errors.push(error),
      'state',
    );
    await running;
    let closed = false;
    const closing = engine.close().then(() => {
      closed = true;
    });
    const writer = await Engine.open(fixture.root, engine.store.file);
    engines.push(writer);
    try {
      await writer.execute('task.create', { title: 'While the observer drains' });
      expect(closed).toBe(false);
    } finally {
      release();
      await closing;
    }
    await writer.execute('config.save', { hooks: {}, previewSetup: 'echo state changed' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(1);
    expect(errors).toEqual([]);
  });

  it('waits for state-only observer initialization when closed during startup', async () => {
    const update = vi.fn(async () => {});
    const errors: unknown[] = [];
    let initialized = false;
    const starting = engine
      .start(update, (error) => errors.push(error), 'state')
      .then(() => {
        initialized = true;
      });
    await engine.close();
    try {
      expect(initialized).toBe(true);
    } finally {
      await starting;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(update).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('keeps one background preview owner and transfers ownership when its session closes', async () => {
    const second = await Engine.open(fixture.root, engine.store.file);
    engines.push(second);
    const owners = new Set<PreviewService>();
    vi.spyOn(PreviewService.prototype, 'tick').mockImplementation(async function (this: PreviewService) {
      owners.add(this);
    });
    const errors: unknown[] = [];
    await engine.start(
      async () => {},
      (error) => errors.push(error),
    );
    await vi.waitFor(() => expect(owners.size).toBe(1), { timeout: 3000 });
    // Close both in turn: only a live session may retain the observer lease.
    const ownerFile = path.join(`${engine.store.file}.preview-owner.lock`, 'v2', 'active');
    const ownerEntries = await readdir(ownerFile);
    expect(ownerEntries).toHaveLength(1);
    expect(await readFile(path.join(ownerFile, ownerEntries[0]!), 'utf8')).toContain(`${process.pid}:`);
    await second.start(
      async () => {},
      (error) => errors.push(error),
    );
    await engine.close();
    await vi.waitFor(() => expect(owners.size).toBe(2), { timeout: 3000 });
    await second.close();
    await expect(readdir(ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(engine.execute('workflow.get', undefined)).rejects.toMatchObject({ code: 'session_closed' });
    expect(errors).toEqual([]);
  });

  it('lets a requested write wait for its own slow preview without consuming the repository lock timeout', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(PreviewService.prototype, 'tick').mockImplementation(async () => {
      await engine.store.withRepositoryLock(async () => {
        entered();
        await gate;
      });
    });
    const errors: unknown[] = [];
    await engine.start(
      async () => {},
      (error) => errors.push(error),
    );
    await running;
    const requested = engine.execute('task.create', { title: 'After preview' }).then(
      (task) => ({ task }),
      (error) => ({ error }),
    );
    try {
      // A legitimate local composition can exceed the cross-window lock wait on Windows.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect((await engine.execute('workflow.context', undefined)).developmentBranch).toBe('main');
      expect((await engine.store.load()).workflow!.changes).toHaveLength(0);
    } finally {
      release();
    }
    expect(await requested).toMatchObject({ task: { title: 'After preview' } });
    expect(errors).toEqual([]);
  });

  it('drains an in-flight mutation before closing and keeps the saved plan available to the next session', async () => {
    const creating = engine.execute('task.create', { title: 'Persist across reload' });
    await engine.close();
    const task = await creating;
    const reopened = await Engine.open(fixture.root, engine.store.file);
    engines.push(reopened);
    expect((await reopened.execute('workflow.get', undefined)).workflow?.changes.some((row) => row.id === task.id)).toBe(true);
  });
});
