import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '@warden/engine';
import { resolveAcpBinding, validateAcpBinding } from '../packages/vscode/src/acp/binding.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fixture: FixtureRepo;
let directory: string;
let engine: Engine;
const timeout = process.platform === 'win32' ? 90_000 : 30_000;

beforeEach(async () => {
  fixture = await makeFixtureRepo('warden-acp-binding-');
  directory = await mkdtemp(path.join(os.tmpdir(), 'warden-acp-binding-data-'));
  engine = await Engine.open(fixture.root, path.join(directory, 'state.json'));
  await engine.execute('workflow.configure', { branch: 'main' });
});

afterEach(async () => {
  await engine.close();
  for (const slot of [1, 2]) await rm(`${fixture.root}-${slot}`, { recursive: true, force: true });
  await fixture.cleanup();
  await rm(directory, { recursive: true, force: true });
});

async function allocate(title = 'Task', kind: 'shared' | 'clone' = 'shared') {
  const plan = await engine.execute('task.create', { title });
  return engine.execute('task.start', { taskId: plan.id, kind });
}

describe('ACP task binding', () => {
  it.each(['shared', 'clone'] as const)(
    'binds an allocated %s task and preserves its identity across ordinary commits and note edits',
    { timeout },
    async (kind) => {
      const task = await allocate('Original title', kind);
      const binding = await resolveAcpBinding(engine, task.id);
      expect(binding).toMatchObject({ repository: fixture.root, taskId: task.id, title: task.title, workspace: task.worktree, branch: task.branch });
      expect(binding.workspace).not.toBe(binding.repository);
      expect(binding.identity).toMatch(/^[0-9a-f]{64}$/);
      await writeFile(path.join(task.worktree, 'agent.txt'), 'Agent work\n');
      await validateAcpBinding(engine, binding);
      fixture.git('-C', task.worktree, 'add', 'agent.txt');
      fixture.git('-C', task.worktree, 'commit', '-qm', 'Agent progress');
      await engine.execute('task.update', { taskId: task.id, title: 'Updated title', body: 'Clarified scope' });
      const updated = await resolveAcpBinding(engine, task.id);
      expect(updated.title).toBe('Updated title');
      expect(updated.identity).toBe(binding.identity);
      await validateAcpBinding(engine, binding);
      expect(fixture.git('status', '--porcelain')).toBe('');
    },
  );

  it.each(['merge', 'cherry-pick', 'rebase-merge', 'rebase-apply'] as const)(
    'keeps the task conversation bound while %s awaits conflict repair',
    { timeout },
    async (operation) => {
      const task = await allocate();
      const binding = await resolveAcpBinding(engine, task.id);
      const git = (...args: string[]) => fixture.git('-C', task.worktree, ...args);
      await writeFile(path.join(task.worktree, 'src/a.ts'), 'Agent version\n');
      git('add', 'src/a.ts');
      git('commit', '-qm', 'Task change');
      await fixture.write('src/a.ts', 'Human version\n');
      fixture.git('add', 'src/a.ts');
      fixture.git('commit', '-qm', 'Primary change');
      git('fetch', '--quiet', fixture.root, 'main');
      const command = operation.startsWith('rebase-')
        ? ['rebase', operation === 'rebase-merge' ? '--merge' : '--apply', 'FETCH_HEAD']
        : operation === 'merge'
          ? ['merge', '--no-edit', 'FETCH_HEAD']
          : ['cherry-pick', 'FETCH_HEAD'];
      expect(() => git(...command)).toThrow();
      const checkout = (await engine.execute('workspaces.list', undefined)).worktrees.find((row) => row.path === task.worktree)!;
      expect(checkout.busy).toBe(operation.startsWith('rebase-') ? 'rebase' : operation);
      expect((await resolveAcpBinding(engine, task.id)).identity).toBe(binding.identity);
      await validateAcpBinding(engine, binding);
      if (operation.startsWith('rebase-')) {
        expect(checkout.detached).toBe(true);
        const gitDir = git('rev-parse', '--absolute-git-dir').trim();
        const headName = path.join(gitDir, operation, 'head-name');
        const original = await readFile(headName, 'utf8');
        await writeFile(headName, 'refs/heads/unrelated-task\n');
        await expect(validateAcpBinding(engine, binding)).rejects.toThrow('任务工作区已变化');
        await writeFile(headName, original);
        await validateAcpBinding(engine, binding);
      } else expect(checkout.branch).toBe(task.branch);
    },
  );

  it('refuses planned tasks and a persisted association that points to primary', { timeout }, async () => {
    const plan = await engine.execute('task.create', { title: 'Not allocated' });
    await expect(resolveAcpBinding(engine, plan.id)).rejects.toThrow('请先为此任务创建工作区');
    await expect(resolveAcpBinding(engine, 'missing-task')).rejects.toThrow('请先为此任务创建工作区');
    const task = await allocate();
    // Historical/corrupt state must not turn a task chat into a primary-directory agent.
    await engine.store.update((state) => {
      state.workflow!.changes = state.workflow!.changes.map((row) => (row.id === task.id ? { ...task, worktree: fixture.root, branch: 'main' } : row));
    });
    await expect(resolveAcpBinding(engine, task.id)).rejects.toThrow('Agent 会话必须使用任务工作区');
    expect(fixture.git('status', '--porcelain')).toBe('');
  });

  it('rejects a detached allocation and does not transfer an old conversation to a newly allocated task at the same path', { timeout }, async () => {
    const task = await allocate('Old task');
    const binding = await resolveAcpBinding(engine, task.id);
    fixture.git('-C', task.worktree, 'switch', '--detach');
    await expect(validateAcpBinding(engine, binding)).rejects.toThrow('任务工作区已变化');
    // The desktop UI does not release active tasks. Simulate an externally retired allocation,
    // then exercise the real Engine's normal allocation into the free physical directory.
    await engine.store.update((state) => {
      state.workflow!.changes = state.workflow!.changes.filter((row) => row.id !== task.id);
    });
    const next = await allocate('New task');
    const current = await resolveAcpBinding(engine, next.id);
    expect(next.worktree).toBe(task.worktree);
    expect(current.taskId).not.toBe(binding.taskId);
    expect(current.identity).not.toBe(binding.identity);
    await expect(validateAcpBinding(engine, binding)).rejects.toThrow('请先为此任务创建工作区');
  });

  it('invalidates a changed branch and a recreated Git registration even when the task path and branch are restored', { timeout }, async () => {
    const task = await allocate();
    const binding = await resolveAcpBinding(engine, task.id);
    fixture.git('-C', task.worktree, 'switch', '-qc', 'another-task');
    await expect(validateAcpBinding(engine, binding)).rejects.toThrow('任务工作区已变化');
    fixture.git('-C', task.worktree, 'switch', '-q', task.branch);
    await validateAcpBinding(engine, binding);
    const repository = fixture.git('-C', task.worktree, 'rev-parse', '--git-common-dir').trim();
    fixture.git('-C', repository, 'worktree', 'remove', task.worktree);
    fixture.git('-C', repository, 'worktree', 'add', '-q', task.worktree, task.branch);
    const replacement = await resolveAcpBinding(engine, task.id);
    expect(replacement.workspace).toBe(binding.workspace);
    expect(replacement.branch).toBe(binding.branch);
    expect(replacement.identity).not.toBe(binding.identity);
    await expect(validateAcpBinding(engine, binding)).rejects.toThrow('工作区已被替换');
  });

  it('rejects a copied Git pointer to another task instead of binding that task private index and HEAD', { timeout }, async () => {
    const a = await allocate('A');
    const b = await allocate('B');
    const binding = await resolveAcpBinding(engine, a.id);
    const gitfile = path.join(a.worktree, '.git');
    const original = await readFile(gitfile);
    await writeFile(gitfile, await readFile(path.join(b.worktree, '.git')));
    try {
      await expect(validateAcpBinding(engine, binding)).rejects.toThrow('任务工作区已变化');
    } finally {
      await writeFile(gitfile, original);
    }
    await validateAcpBinding(engine, binding);
  });
});
