import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentChange } from '@warden/shared';
import { createApp, resolveRepo, StateStore, WorkflowService } from './compat/index.js';
import { GitSandbox, applyPatch, oid, patchBetween } from '../packages/engine/src/git-sandbox.js';
import { PreviewService } from '../packages/engine/src/preview.js';
import { HistoryService } from '../packages/engine/src/history.js';
import { listSafetyBackups } from '../packages/engine/src/backups.js';
import { listWorktreesDetailed } from '../packages/engine/src/worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let store: StateStore;
let workflow: WorkflowService;
let preview: PreviewService;
let history: HistoryService;
const sourceHead = (c: DevelopmentChange) => fx.git('-C', c.worktree, 'rev-parse', 'HEAD').trim();
const head = () => fx.git('rev-parse', 'HEAD').trim();
const file = (root: string, name: string) => readFile(path.join(root, name), 'utf8');
// Complete delivery and replay scenarios repeatedly start Git in several repositories.
// Keep their Windows startup allowance local so other failures are still detected quickly.
const longGitTimeout = process.platform === 'win32' ? 90_000 : 30_000;
// The combined delivery, history replay and rebase path exceeds 30 seconds on Intel macOS runners.
const historyRebaseTimeout = process.platform === 'darwin' ? 60_000 : longGitTimeout;

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-workbench-');
  fx.git('switch', '-qc', 'feature/order');
  data = await mkdtemp(path.join(os.tmpdir(), 'warden-workbench-data-'));
  store = new StateStore(path.join(data, 'state.json'), fx.root);
  const repo = await resolveRepo(fx.root);
  workflow = new WorkflowService(repo, store);
  preview = new PreviewService(repo, store);
  history = new HistoryService(repo, store);
  await workflow.configure('feature/order');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const w of await listWorktreesDetailed(await resolveRepo(fx.root))) if (w.slot !== undefined) await rm(w.path, { recursive: true, force: true });
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});
async function task(title: string) {
  return workflow.start((await workflow.create({ title })).id);
}
async function edit(c: DevelopmentChange, name: string, content: string, commit = false) {
  await writeFile(path.join(c.worktree, name), content);
  if (commit) {
    fx.git('-C', c.worktree, 'add', '--', name);
    fx.git('-C', c.worktree, 'commit', '-qm', content.trim());
  }
}
async function deliver(c: DevelopmentChange, message: string) {
  await workflow.prepare(c.id, { sourceHead: sourceHead(c), developmentHead: head() });
  const pending = (await workflow.get()).preparation!;
  return workflow.accept(c.id, { mode: 'commit', developmentHead: pending.head!, indexFingerprint: pending.indexFingerprint!, message });
}

describe('continuous workspace delivery and passive synchronization', () => {
  it('delivers nested additions without stripping their directory when diff.noprefix is enabled', async () => {
    const a = await task('Nested addition');
    fx.git('-C', a.worktree, 'config', 'diff.noprefix', 'true');
    await edit(a, 'src/added.txt', 'Nested content\n', true);

    const delivered = await deliver(a, 'Add a nested file');

    expect(fx.git('show', '--format=', '--name-only', head()).trim()).toBe('src/added.txt');
    expect(await file(fx.root, 'src/added.txt')).toBe('Nested content\n');
    await expect(file(fx.root, 'added.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fx.git('rev-parse', 'HEAD^{tree}').trim()).toBe(fx.git('-C', a.worktree, 'rev-parse', 'HEAD^{tree}').trim());
    expect(delivered.sourceBase).toBe(sourceHead(a));
  });

  it.each(['local', 'global'] as const)(
    'preserves preview and delivery paths and bytes under %s Git display configuration',
    { timeout: longGitTimeout },
    async (scope) => {
      const a = await task('Display configuration');
      const config = path.join(data, 'display.gitconfig');
      for (const [key, value] of [
        ['diff.noprefix', 'true'],
        ['diff.mnemonicPrefix', 'true'],
        ['diff.srcPrefix', 'before/'],
        ['diff.dstPrefix', 'after/'],
        ['diff.context', '0'],
        ['diff.submodule', 'diff'],
        ['color.ui', 'always'],
      ]) {
        if (scope === 'global') fx.git('config', '--file', config, key!, value!);
        else {
          fx.git('config', key!, value!);
          fx.git('-C', a.worktree, 'config', key!, value!);
        }
      }
      if (scope === 'global') vi.stubEnv('GIT_CONFIG_GLOBAL', config);
      const originalHead = head();
      const bytes = Buffer.from([0, 255, 0, 128, 3, 10]);
      await edit(a, 'src/a.ts', 'export function a() {\n  return 3;\n}\n\nexport const extra = true;\n');
      await edit(a, 'src/added.txt', 'Nested content\n');
      await writeFile(path.join(a.worktree, 'src/image.bin'), bytes);

      expect(await preview.set([a.id])).toMatchObject({ status: 'current', connectedIds: [a.id] });
      expect(await file((await preview.get()).worktree!, 'src/added.txt')).toBe('Nested content\n');
      expect(await file((await preview.get()).worktree!, 'src/a.ts')).toBe(await file(a.worktree, 'src/a.ts'));
      expect(await readFile(path.join((await preview.get()).worktree!, 'src/image.bin'))).toEqual(bytes);
      expect(head()).toBe(originalHead);
      expect(fx.git('diff', '--cached', '--name-only').trim()).toBe('');

      fx.git('-C', a.worktree, 'add', '--all');
      fx.git('-C', a.worktree, 'commit', '-qm', 'Agent changes');
      await deliver(a, 'Deliver the previewed files');

      expect(fx.git('rev-parse', 'HEAD^{tree}').trim()).toBe(fx.git('-C', a.worktree, 'rev-parse', 'HEAD^{tree}').trim());
      expect(fx.git('show', '--format=', '--name-only', head()).trim().split('\n')).toEqual(['src/a.ts', 'src/added.txt', 'src/image.bin']);
      expect(await readFile(path.join(fx.root, 'src/image.bin'))).toEqual(bytes);
      expect(fx.git('status', '--porcelain').trim()).toBe('');
    },
  );

  it('delivers A1, B1, A2 without rebasing either source or including A1 twice', { timeout: longGitTimeout }, async () => {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'a.txt', 'A1\n', true);
    const a1 = sourceHead(a);
    await deliver(a, 'A1');
    await edit(b, 'b.txt', 'B1\n', true);
    await deliver(b, 'B1');
    expect(sourceHead(a)).toBe(a1);
    await edit(a, 'a.txt', 'A2\n', true);
    const result = await deliver(a, 'A2');
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries![1]!.sourceBase).toBe(a1);
    expect(result.status).toBe('working');
    expect(await file(fx.root, 'a.txt')).toBe('A2\n');
    expect(await file(fx.root, 'b.txt')).toBe('B1\n');
    expect(fx.git('log', '-3', '--format=%s').trim().split('\n')).toEqual(['A2', 'B1', 'A1']);
    const checks = await workflow.rebaseChecks();
    expect(checks.checks.every((c) => c.status === 'ready')).toBe(true);
    const before = sourceHead(a);
    expect(sourceHead(a)).toBe(before);
    const check = checks.checks.find((c) => c.changeId === a.id)!;
    expect((await workflow.rebaseBatch({ items: [check] })).results[0]?.status).toBe('updated');
    expect(sourceHead(a)).toBe(head());
    expect((await workflow.get()).workflow!.changes.find((c) => c.id === a.id)).toMatchObject({ base: head(), status: 'working' });
  });

  it('keeps rebase checks read-only and returns separate results for stale and clean items', { timeout: longGitTimeout }, async () => {
    const a = await task('A');
    const b = await task('B');
    const c = await task('C');
    await edit(a, 'a.txt', 'A\n', true);
    await deliver(a, 'A');
    await edit(b, 'b.txt', 'B\n', true);
    await edit(c, 'c.txt', 'C\n', true);
    const before = await readFile(path.resolve(c.worktree, fx.git('-C', c.worktree, 'rev-parse', '--git-path', 'index').trim()));
    const checks = (await workflow.rebaseChecks()).checks;
    expect(await readFile(path.resolve(c.worktree, fx.git('-C', c.worktree, 'rev-parse', '--git-path', 'index').trim()))).toEqual(before);
    await edit(b, 'b.txt', 'B2\n', true);
    const response = await workflow.rebaseBatch({ items: checks.filter((x) => x.changeId === b.id || x.changeId === c.id) });
    expect(response.results.map((r) => r.status)).toEqual(['failed', 'updated']);
    await edit(b, 'b.txt', 'unsaved\n');
    expect((await workflow.rebaseChecks()).checks.find((x) => x.changeId === b.id)?.status).toBe('blocked');
  });
});

describe('persistent independent preview connections', () => {
  it('recovers a completed file write after an interrupted ownership-state write', async () => {
    const a = await task('A');
    await edit(a, 'src/b.ts', 'export const b = 10;\n');
    const update = store.update.bind(store);
    const spy = vi.spyOn(store, 'update').mockImplementation(async (mutate) =>
      update((s) => {
        const result = mutate(s);
        if (s.connectionPreview?.status === 'current' && !s.connectionPreview.pending) throw new Error('interrupted state write');
        return result;
      }),
    );
    await expect(preview.set([a.id])).rejects.toThrow('interrupted state write');
    spy.mockRestore();
    expect((await store.load()).connectionPreview?.pending).toBeDefined();
    const restarted = new PreviewService(await resolveRepo(fx.root), store);
    await restarted.tick();
    expect(await restarted.get()).toMatchObject({ status: 'current', connectedIds: [a.id] });
    expect(await file((await preview.get()).worktree!, 'src/b.ts')).toBe('export const b = 10;\n');
    await restarted.set([]);
    expect(fx.git('status', '--porcelain').trim()).toBe('');
    expect(fx.git('for-each-ref', '--format=%(refname)', 'refs/warden/').trim()).toBe('');
    expect(await listSafetyBackups(store)).toEqual([]);
    expect(await readdir(path.join(data, 'operations'))).toEqual([path.basename((await preview.get()).worktree!)]);
  });

  it('preserves binary changes, renames and deletions across connection and disconnection', async () => {
    const a = await task('Files');
    const before = await file(fx.root, 'src/b.ts');
    const originalA = await file(fx.root, 'src/a.ts');
    const bytes = Buffer.from([0, 255, 0, 128, 3, 10]);
    await writeFile(path.join(a.worktree, 'image.bin'), bytes);
    fx.git('-C', a.worktree, 'mv', 'src/b.ts', 'src/renamed.ts');
    await rm(path.join(a.worktree, 'src/a.ts'));
    await preview.set([a.id]);
    expect(await readFile(path.join((await preview.get()).worktree!, 'image.bin'))).toEqual(bytes);
    expect(await file((await preview.get()).worktree!, 'src/renamed.ts')).toBe(before);
    await expect(file((await preview.get()).worktree!, 'src/a.ts')).rejects.toMatchObject({ code: 'ENOENT' });
    await preview.set([]);
    expect(await file((await preview.get()).worktree!, 'src/a.ts')).toBe(originalA);
    expect(await file((await preview.get()).worktree!, 'src/b.ts')).toBe(before);
    await expect(file((await preview.get()).worktree!, 'image.bin')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fx.git('status', '--porcelain').trim()).toBe('');
  });
  it('composes live edits, updates them, and disconnects contributions without touching HEAD or index', { timeout: longGitTimeout }, async () => {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'a.txt', 'A\n');
    await edit(b, 'b.txt', 'B\n', true);
    const old = head();
    const index = await readFile(path.join(fx.root, '.git/index'));
    expect((await preview.set([a.id, b.id])).status).toBe('current');
    expect(await file((await preview.get()).worktree!, 'a.txt')).toBe('A\n');
    expect(await file((await preview.get()).worktree!, 'b.txt')).toBe('B\n');
    await edit(a, 'a.txt', 'A live\n');
    expect((await preview.refresh()).status).toBe('current');
    expect(await file((await preview.get()).worktree!, 'a.txt')).toBe('A live\n');
    await preview.set([b.id]);
    await expect(file((await preview.get()).worktree!, 'a.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await file((await preview.get()).worktree!, 'b.txt')).toBe('B\n');
    await preview.set([]);
    expect(fx.git('status', '--porcelain').trim()).toBe('');
    expect(head()).toBe(old);
    expect(await readFile(path.join(fx.root, '.git/index'))).toEqual(index);
  });

  it('fails a conflicting connection unchanged and keeps the last coherent preview on later conflicts', { timeout: longGitTimeout }, async () => {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'src/b.ts', 'export const b = 10;\n');
    await edit(b, 'src/b.ts', 'export const b = 20;\n');
    await preview.set([a.id]);
    await expect(preview.set([a.id, b.id])).rejects.toMatchObject({ status: 409, code: 'preview_conflict' });
    expect((await preview.get()).connectedIds).toEqual([a.id]);
    expect(await file((await preview.get()).worktree!, 'src/b.ts')).toBe('export const b = 10;\n');
    fx.git('-C', b.worktree, 'restore', 'src/b.ts');
    await edit(b, 'b.txt', 'other\n');
    await preview.set([a.id, b.id]);
    await edit(b, 'src/b.ts', 'export const b = 30;\n');
    expect((await preview.refresh()).status).toBe('stale');
    expect(await file((await preview.get()).worktree!, 'src/b.ts')).toBe('export const b = 10;\n');
    expect(await file((await preview.get()).worktree!, 'b.txt')).toBe('other\n');
    await preview.set([a.id]);
  });

  it('refuses to overwrite unexpected edits in the preview directory', async () => {
    const a = await task('A');
    await edit(a, 'a.txt', 'A\n');
    await preview.set([a.id]);
    await writeFile(path.join((await preview.get()).worktree!, 'a.txt'), 'user fix\n');
    await expect(preview.set([])).rejects.toMatchObject({ code: 'preview_dirty' });
    expect(await file((await preview.get()).worktree!, 'a.txt')).toBe('user fix\n');
    expect((await preview.get()).connectedIds).toEqual([a.id]);
  });

  it('isolates delivery from other connections and resumes remaining live edits afterwards', { timeout: longGitTimeout }, async () => {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'src/b.ts', 'export const b = 10;\n', true);
    await edit(b, 'b.txt', 'B live\n');
    await preview.set([a.id, b.id]);
    const delivered = await deliver(a, 'A1');
    expect(fx.git('show', '--format=', '--name-only', head()).trim()).toBe('src/b.ts');
    expect(await file((await preview.get()).worktree!, 'b.txt')).toBe('B live\n');
    expect((await preview.get()).status).toBe('current');
    expect(delivered.sourceBase).toBe(sourceHead(a));
    expect(fx.git('diff', '--cached', '--name-only').trim()).toBe('');
    await preview.set([]);
    expect(await file((await preview.get()).worktree!, 'src/b.ts')).toBe('export const b = 10;\n');
    await expect(file((await preview.get()).worktree!, 'b.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('primary-preview migration', () => {
  async function oldPreview() {
    const a = await task('Old connected task');
    await edit(a, 'agent.txt', 'Old preview\n', true);
    const sandbox = await GitSandbox.create(store, a.worktree, sourceHead(a));
    const tree = await oid(sandbox.path, 'HEAD^{tree}');
    await applyPatch(fx.root, await patchBetween(sandbox.path, head(), tree), false);
    await store.update((s) => {
      s.connectionPreview = {
        worktree: fx.root,
        developmentBranch: 'feature/order',
        developmentHead: head(),
        connectedIds: [a.id],
        status: 'current',
        files: [],
        tree,
        sandbox: sandbox.path,
        snapshot: sourceHead(a),
      };
    });
    return a;
  }
  it('moves a proven legacy composition out of primary and retries after interrupted baseline bookkeeping', async () => {
    const a = await oldPreview();
    const update = store.update.bind(store);
    const spy = vi.spyOn(store, 'update').mockImplementation(async (mutate) =>
      update((s) => {
        const result = mutate(s);
        if (s.connectionPreview?.status === 'disconnected' && !s.connectionPreview.directory) throw new Error('migration interrupted');
        return result;
      }),
    );
    expect((await preview.refresh()).status).toBe('stale');
    spy.mockRestore();
    expect(fx.git('status', '--porcelain')).toBe('');
    const result = await preview.refresh();
    expect(result).toMatchObject({ connectedIds: [a.id], status: 'current' });
    expect(result.worktree).not.toBe(fx.root);
    expect(await file(result.worktree!, 'agent.txt')).toBe('Old preview\n');
    expect(fx.git('status', '--porcelain')).toBe('');
  });
  it('preserves unexpected human edits and blocks legacy migration', async () => {
    const a = await oldPreview();
    await fx.write('human.txt', 'Keep me\n');
    await expect(preview.set([a.id])).rejects.toMatchObject({ code: 'preview_migration_required' });
    expect(await file(fx.root, 'human.txt')).toBe('Keep me\n');
    expect(await file(fx.root, 'agent.txt')).toBe('Old preview\n');
    expect((await store.load()).connectionPreview?.directory).toBeUndefined();
  });
});

describe('saved baseline and preview runtime', () => {
  it('includes staged, unstaged and untracked primary edits without changing the primary index or admitting them to a delivery', async () => {
    const a = await task('A');
    await edit(a, 'agent.txt', 'agent\n', true);
    await fx.write('src/b.ts', 'export const b = 200;\n');
    fx.git('add', 'src/b.ts');
    await fx.write('README.md', 'Human edits\n');
    await fx.write('human.txt', 'Untracked human file\n');
    const before = fx.git('status', '--porcelain');
    const index = await readFile(path.join(fx.root, '.git/index'));
    const result = await preview.set([a.id]);
    expect(result.worktree).not.toBe(fx.root);
    expect(await file(result.worktree!, 'src/b.ts')).toBe('export const b = 200;\n');
    expect(await file(result.worktree!, 'README.md')).toBe('Human edits\n');
    expect(await file(result.worktree!, 'human.txt')).toBe('Untracked human file\n');
    expect(await file(result.worktree!, 'agent.txt')).toBe('agent\n');
    expect(fx.git('status', '--porcelain')).toBe(before);
    expect(await readFile(path.join(fx.root, '.git/index'))).toEqual(index);
    await expect(workflow.prepare(a.id, { sourceHead: sourceHead(a), developmentHead: head() })).rejects.toMatchObject({ code: 'development_dirty' });
    expect(fx.git('status', '--porcelain')).toBe(before);
    await fx.write('human.txt', 'Saved again\n');
    await preview.refresh();
    expect(await file(result.worktree!, 'human.txt')).toBe('Saved again\n');
    await preview.set([]);
    await expect(file(result.worktree!, 'agent.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await file(result.worktree!, 'human.txt')).toBe('Saved again\n');
  });

  it('keeps other connections running while a delivery is prepared in primary', async () => {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'src/b.ts', 'export const b = 10;\n', true);
    await edit(b, 'b.txt', 'B\n');
    const first = await preview.set([a.id, b.id]);
    await workflow.prepare(a.id, { sourceHead: sourceHead(a), developmentHead: head() });
    const result = await preview.refresh();
    expect(result.status).toBe('current');
    expect(await file(first.worktree!, 'src/b.ts')).toBe('export const b = 10;\n');
    expect(await file(first.worktree!, 'b.txt')).toBe('B\n');
    expect(fx.git('diff', '--cached', '--name-only').trim()).toBe('src/b.ts');
    await expect(file(fx.root, 'b.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the last preview when a human baseline change conflicts with an agent change', async () => {
    const a = await task('A');
    await edit(a, 'src/b.ts', 'export const b = 10;\n');
    const first = await preview.set([a.id]);
    await fx.write('src/b.ts', 'export const b = 20;\n');
    const result = await preview.refresh();
    expect(result.status).toBe('stale');
    expect(result.sources?.[0]?.status).toBe('conflict');
    expect(await file(first.worktree!, 'src/b.ts')).toBe('export const b = 10;\n');
    expect(await file(fx.root, 'src/b.ts')).toBe('export const b = 20;\n');
    await preview.set([]);
    expect(await file(first.worktree!, 'src/b.ts')).toBe('export const b = 20;\n');
  });

  it('debounces actual content changes and reports whether each captured source has reached preview', async () => {
    const a = await task('A');
    await edit(a, 'a.txt', 'one\n');
    const first = await preview.set([a.id]);
    await edit(a, 'a.txt', 'two\n');
    await preview.tick();
    const pending = (await preview.get()).sources![0]!;
    expect(pending.status).toBe('pending');
    expect(pending.appliedTree).toBe(first.sources![0]!.appliedTree);
    expect(pending.observedTree).not.toBe(pending.appliedTree);
    await edit(a, 'a.txt', 'three\n');
    await preview.tick();
    expect((await preview.get()).sources![0]!.observedTree).not.toBe(pending.observedTree);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try {
      await preview.tick();
    } finally {
      now.mockRestore();
    }
    expect((await preview.get()).sources![0]!.status).toBe('synced');
    expect(await file(first.worktree!, 'a.txt')).toBe('three\n');
  });

  it('keeps dependencies across updates and restarts, runs setup on changes, and exposes setup failures and retry output', async () => {
    await fx.write('.gitignore', 'node_modules/\n');
    fx.git('add', '.gitignore');
    fx.git('commit', '-qm', 'Ignore runtime dependencies');
    const a = await task('A');
    const command = 'mkdir -p node_modules; echo setup >> node_modules/runs; echo configured';
    await store.update((s) => {
      s.workspaceConfig = { hooks: {}, previewSetup: command };
    });
    const first = await preview.set([]);
    expect(first.setup).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(first.setup!.output).toContain('configured');
    await writeFile(path.join(first.worktree!, 'node_modules/cache'), 'keep');
    await preview.refresh();
    expect((await file(first.worktree!, 'node_modules/runs')).trim().split('\n')).toHaveLength(1);
    await edit(a, 'a.txt', 'A\n');
    await preview.set([a.id]);
    const restarted = new PreviewService(await resolveRepo(fx.root), store);
    await restarted.refresh();
    expect((await restarted.get()).worktree).toBe(first.worktree);
    expect(await file(first.worktree!, 'node_modules/cache')).toBe('keep');
    expect((await file(first.worktree!, 'node_modules/runs')).trim().split('\n')).toHaveLength(2);
    await store.update((s) => {
      s.workspaceConfig!.previewSetup = 'echo failed-setup; exit 7';
    });
    expect((await restarted.setup()).setup).toMatchObject({ status: 'failed', exitCode: 7 });
    await store.update((s) => {
      s.workspaceConfig!.previewSetup = command;
    });
    expect((await restarted.setup()).setup).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(fx.git('status', '--porcelain')).toBe('');
  });
});

describe('commit history arrangement', () => {
  async function three() {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'a.txt', 'A1\n', true);
    await deliver(a, 'A1');
    await edit(b, 'b.txt', 'B1\n', true);
    await deliver(b, 'B1');
    await edit(a, 'a.txt', 'A2\n', true);
    await deliver(a, 'A2');
    return { a, b };
  }
  it('previews and applies A1,A2,B1 with a new message while keeping files and agent checkouts unchanged', { timeout: historyRebaseTimeout }, async () => {
    const { a, b } = await three();
    const current = await history.get();
    const entries = current.commits.slice(-3);
    const tree = fx.git('rev-parse', 'HEAD^{tree}').trim();
    const aHead = sourceHead(a);
    const bHead = sourceHead(b);
    const result = await history.preview({
      head: current.head,
      start: entries[0]!.sha,
      commits: [entries[0]!, { ...entries[2]!, message: 'A2 clarified' }, entries[1]!],
    });
    expect(result.canApply).toBe(true);
    expect(head()).toBe(current.head);
    const next = await history.apply({ id: result.id!, head: current.head });
    expect(next.commits.slice(-3).map((c) => c.message)).toEqual(['A1', 'A2 clarified', 'B1']);
    expect(next.commits.slice(-3).map((c) => c.changeId)).toEqual([a.id, a.id, b.id]);
    const stored = (await store.load()).workflow!.changes.find((c) => c.id === b.id) as DevelopmentChange;
    expect(stored.deliveries![0]!.parent).toBe(next.commits.at(-2)!.sha);
    expect(fx.git('rev-parse', 'HEAD^{tree}').trim()).toBe(tree);
    expect(sourceHead(a)).toBe(aHead);
    expect(sourceHead(b)).toBe(bHead);
    expect(fx.git('status', '--porcelain').trim()).toBe('');
    const check = (await workflow.rebaseChecks()).checks.find((c) => c.changeId === a.id)!;
    expect(check.status).toBe('ready');
    expect((await workflow.rebaseBatch({ items: [check] })).results[0]?.status).toBe('updated');
  });

  it('rejects invalid ranges, stale previews and conflicting reorder without changing history', { timeout: longGitTimeout }, async () => {
    await three();
    const current = await history.get();
    const entries = current.commits.slice(-3);
    await expect(history.preview({ head: current.head, start: entries[0]!.sha, commits: [entries[0]!, entries[0]!, entries[2]!] })).rejects.toMatchObject({
      status: 400,
    });
    const conflict = await history.preview({ head: current.head, start: entries[0]!.sha, commits: [entries[2]!, entries[0]!, entries[1]!] });
    expect(conflict.canApply).toBe(false);
    expect(conflict.conflicts).toContain('a.txt');
    expect(head()).toBe(current.head);
    const valid = await history.preview({ head: current.head, start: entries[0]!.sha, commits: entries });
    fx.git('commit', '--allow-empty', '-qm', 'External update');
    await expect(history.apply({ id: valid.id!, head: current.head })).rejects.toMatchObject({ status: 409 });
    expect(fx.git('log', '-1', '--format=%s').trim()).toBe('External update');
  });

  it('finishes a published history mapping after an interrupted state write without rewriting twice', { timeout: longGitTimeout }, async () => {
    await three();
    const current = await history.get();
    const last = current.commits.at(-1)!;
    const draft = await history.preview({ head: current.head, start: last.sha, commits: [{ sha: last.sha, message: 'A2 clarified' }] });
    const update = store.update.bind(store);
    const spy = vi.spyOn(store, 'update').mockImplementation(async (mutate) =>
      update((s) => {
        const result = mutate(s);
        if (s.workflow!.changes.some((c) => c.worktree && c.deliveries?.some((delivery) => delivery.commit === draft.newHead)))
          throw new Error('interrupted mapping');
        return result;
      }),
    );
    await expect(history.apply({ id: draft.id!, head: current.head })).rejects.toThrow('interrupted mapping');
    spy.mockRestore();
    expect(head()).toBe(draft.newHead);
    expect(await listSafetyBackups(store)).toHaveLength(1);
    expect(await readdir(path.join(data, 'operations'))).toHaveLength(1);
    const restarted = new HistoryService(await resolveRepo(fx.root), store);
    expect((await restarted.apply({ id: draft.id!, head: current.head })).head).toBe(draft.newHead);
    expect((await store.load()).historyDraft).toBeUndefined();
    expect(await listSafetyBackups(store)).toEqual([]);
    expect(await readdir(path.join(data, 'operations'))).toEqual([]);
    expect((await restarted.get()).commits.at(-1)?.deliveryId).toBe(last.deliveryId);
  });

  it('retries cleanup after temporary files were removed but their journal update failed', { timeout: longGitTimeout }, async () => {
    const a = await task('A');
    await edit(a, 'a.txt', 'A1\n', true);
    await deliver(a, 'A1');
    const current = await history.get();
    const last = current.commits.at(-1)!;
    const draft = await history.preview({ head: current.head, start: last.sha, commits: [{ sha: last.sha, message: 'Clarified' }] });
    const update = store.update.bind(store);
    const spy = vi.spyOn(store, 'update').mockImplementation(async (mutate) =>
      update((s) => {
        const result = mutate(s);
        if (!s.historyDraft) throw new Error('interrupted cleanup');
        return result;
      }),
    );
    await expect(history.apply({ id: draft.id!, head: current.head })).rejects.toThrow('interrupted cleanup');
    spy.mockRestore();
    expect(await listSafetyBackups(store)).toEqual([]);
    expect(await readdir(path.join(data, 'operations'))).toEqual([]);
    const restarted = new HistoryService(await resolveRepo(fx.root), store);
    expect((await restarted.apply({ id: draft.id!, head: current.head })).head).toBe(draft.newHead);
    expect((await store.load()).historyDraft).toBeUndefined();
  });

  it('exposes validation errors through the web API rather than mutating on malformed requests', async () => {
    const app = createApp({ repo: await resolveRepo(fx.root), store });
    const post = (url: string, body: unknown, method = 'POST') =>
      app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/api/preview', { connectedIds: [1] }, 'PUT')).status).toBe(400);
    expect((await post('/api/history/preview', { head: '--help' })).status).toBe(400);
    expect((await post('/api/workflow/rebase', { items: [{ changeId: 'x', sourceHead: '--help' }] })).status).toBe(400);
    expect((await post('/api/workspace/input', { path: fx.root, text: 'echo hello' })).status).toBe(404);
  });
});
