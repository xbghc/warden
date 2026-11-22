import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentChange } from '@warden/shared';
import { parseWorkbenchAction, taskReview } from '@warden/shared';
import { createApp, resolveRepo, StateStore, WorkflowService } from './compat/index.js';
import * as git from '../packages/engine/src/git.js';
import { PreviewService } from '../packages/engine/src/preview.js';
import { HistoryService } from '../packages/engine/src/history.js';
import { listSafetyBackups } from '../packages/engine/src/backups.js';
import { listWorktreesDetailed } from '../packages/engine/src/worktrees.js';
import { getFullFile, listTargetDiffs, resolveTargetContext } from '../packages/engine/src/targets.js';
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
// Independent clone allocation pushes multi-task delivery past 30 seconds on Intel macOS runners.
const longGitTimeout = process.platform === 'win32' ? 90_000 : process.platform === 'darwin' ? 60_000 : 30_000;
// History replay and recovery, including a subsequent rebase, exceed 30 seconds on Intel macOS runners.
const historyReplayTimeout = process.platform === 'darwin' ? 60_000 : longGitTimeout;

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
  it('delivers the refreshed review after a manual rebase and rejects the previous boundary', { timeout: longGitTimeout }, async () => {
    const a = await task('Manual rebase');
    await edit(a, 'task.txt', 'Task change\n', true);
    await fx.write('primary.txt', 'Primary change\n');
    fx.git('add', 'primary.txt');
    fx.git('commit', '-qm', 'Primary change');
    const target = head();
    fx.git('-C', a.worktree, 'fetch', '--quiet', fx.root, target);
    fx.git('-C', a.worktree, 'rebase', target);

    const review = taskReview(await workflow.get(), a.id, await listWorktreesDetailed(await resolveRepo(fx.root)))!;
    expect(review).toMatchObject({ sourceBase: target, sourceHead: sourceHead(a), developmentHead: target });
    expect((await store.load()).workflow!.changes.find((row) => row.id === a.id)).toMatchObject({ base: a.base });
    const request = {
      sourceHead: review.sourceHead!,
      sourceBase: review.sourceBase,
      developmentHead: review.developmentHead!,
      message: 'Reviewed manual rebase',
    };
    await expect(workflow.deliver(a.id, { ...request, sourceBase: a.base })).rejects.toMatchObject({ code: 'review_changed' });
    expect(head()).toBe(target);
    expect(fx.git('status', '--porcelain')).toBe('');
    expect((await workflow.get()).preparation).toBeUndefined();

    const delivered = await workflow.deliver(a.id, request);
    expect(delivered.deliveries!.at(-1)).toMatchObject({ sourceBase: target, source: review.sourceHead });
    expect(fx.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('task.txt');
    expect(await file(fx.root, 'task.txt')).toBe('Task change\n');
    expect(await file(fx.root, 'primary.txt')).toBe('Primary change\n');
    expect(sourceHead(a)).toBe(review.sourceHead);
    expect(() => fx.git('cat-file', '-e', review.sourceHead!)).toThrow();
  });

  it('keeps primary commits a manual rebase incorporated out of delivery, rebase and preview after primary moves on', { timeout: longGitTimeout }, async () => {
    const a = await task('Rebased before a revert');
    await edit(a, 'task.txt', 'Task change\n', true);
    await fx.write('feature.txt', 'Feature\n');
    fx.git('add', 'feature.txt');
    fx.git('commit', '-qm', 'Add feature');
    const feature = head();
    fx.git('-C', a.worktree, 'fetch', '--quiet', fx.root, feature);
    fx.git('-C', a.worktree, 'rebase', '--quiet', feature);
    // Primary moves past the incorporated commit by reverting it.
    fx.git('revert', '--no-edit', 'HEAD');
    const target = head();

    const review = taskReview(await workflow.get(), a.id, await listWorktreesDetailed(await resolveRepo(fx.root)))!;
    expect(review.sourceBase).toBe(feature);
    const check = (await workflow.rebaseChecks()).checks.find((row) => row.changeId === a.id)!;
    expect(check.status).toBe('ready');
    expect((await workflow.rebaseBatch({ items: [check] })).results).toEqual([{ changeId: a.id, status: 'updated' }]);
    // Only the task commit is replayed; the reverted primary commit stays reverted.
    expect(fx.git('-C', a.worktree, 'rev-parse', 'HEAD^').trim()).toBe(target);
    await expect(file(a.worktree, 'feature.txt')).rejects.toMatchObject({ code: 'ENOENT' });

    await deliver((await workflow.get()).workflow!.changes.find((row) => row.id === a.id) as DevelopmentChange, 'Deliver after revert');
    expect(fx.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('task.txt');
    await expect(file(fx.root, 'feature.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('undoes an automatic rebase that conflicts and leaves a manual conflict for the user', { timeout: longGitTimeout }, async () => {
    const auto = await task('Automatic');
    const manual = await task('Manual');
    await edit(auto, 'shared.txt', 'Automatic change\n', true);
    await edit(manual, 'shared.txt', 'Manual change\n', true);
    await fx.write('shared.txt', 'Primary change\n');
    fx.git('add', 'shared.txt');
    fx.git('commit', '-qm', 'Primary change');
    const target = head();
    const before = sourceHead(auto);
    // An automatic request trusts a check that predicted no conflict; the real replay conflicts.
    const response = await workflow.rebaseBatch({ items: [{ changeId: auto.id, sourceHead: before, developmentHead: target }], automatic: true });
    expect(response.results).toEqual([
      { changeId: auto.id, status: 'failed', message: expect.stringContaining('Automatic rebase stopped at a conflict and was undone') },
    ]);
    expect(sourceHead(auto)).toBe(before);
    expect(fx.git('-C', auto.worktree, 'status', '--porcelain')).toBe('');
    expect((await listWorktreesDetailed(await resolveRepo(fx.root))).find((row) => row.path === auto.worktree)?.busy).toBeUndefined();
    expect(await file(auto.worktree, 'shared.txt')).toBe('Automatic change\n');
    const saved = (await workflow.get()).workflow!.changes.find((row) => row.id === auto.id) as DevelopmentChange;
    expect(saved.sync?.status).not.toBe('conflict');
    expect(saved.rebaseBackups).toBeUndefined();
    expect(await listSafetyBackups(store)).toEqual([]);

    // The same conflict from an explicit request stays in the workspace with its backup.
    const manualResult = await workflow.rebaseBatch({ items: [{ changeId: manual.id, sourceHead: sourceHead(manual), developmentHead: target }] });
    expect(manualResult.results[0]?.status).toBe('failed');
    expect((await listWorktreesDetailed(await resolveRepo(fx.root))).find((row) => row.path === manual.worktree)?.busy).toBe('rebase');
    expect((await workflow.get()).workflow!.changes.find((row) => row.id === manual.id)?.sync?.status).toBe('conflict');
    fx.git('-C', manual.worktree, 'rebase', '--abort');

    // A replayable automatic request rebases like an explicit one.
    await fx.write('shared.txt', 'Automatic change\n');
    fx.git('add', 'shared.txt');
    fx.git('commit', '-qm', 'Match the automatic change');
    const other = await task('Other');
    await edit(other, 'other.txt', 'Other change\n', true);
    await fx.write('primary.txt', 'Primary follow-up\n');
    fx.git('add', 'primary.txt');
    fx.git('commit', '-qm', 'Primary follow-up');
    const check = (await workflow.rebaseChecks()).checks.find((row) => row.changeId === other.id)!;
    expect(check.status).toBe('ready');
    expect((await workflow.rebaseBatch({ items: [check], automatic: true })).results).toEqual([{ changeId: other.id, status: 'updated' }]);
    expect(fx.git('-C', other.worktree, 'rev-parse', 'HEAD^').trim()).toBe(head());
    expect(() => workflow.rebaseBatch({ items: [check], automatic: 'yes' as unknown as boolean })).toThrow(expect.objectContaining({ status: 400 }));
  });

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
    'reviews, previews and delivers submodule versions despite %s ignore settings',
    { timeout: longGitTimeout },
    async (scope) => {
      const before = fx.git('rev-parse', 'HEAD^').trim();
      const after = head();
      await fx.write('.gitmodules', '[submodule "dependency"]\n\tpath = dependency\n\turl = ./dependency.git\n');
      fx.git('add', '.gitmodules');
      fx.git('update-index', '--add', '--cacheinfo', `160000,${before},dependency`);
      fx.git('commit', '-qm', 'Record dependency');
      await mkdir(path.join(fx.root, 'dependency'));
      const a = await task('Update dependency');
      fx.git('-C', a.worktree, 'update-index', '--cacheinfo', `160000,${after},dependency`);
      await edit(a, 'task.txt', 'Update dependency and code\n', true);
      if (scope === 'global') {
        const config = path.join(data, 'ignore-submodules.gitconfig');
        fx.git('config', '--file', config, 'diff.ignoreSubmodules', 'all');
        vi.stubEnv('GIT_CONFIG_GLOBAL', config);
      } else {
        fx.git('config', 'diff.ignoreSubmodules', 'all');
        fx.git('-C', a.worktree, 'config', 'diff.ignoreSubmodules', 'all');
      }
      const repo = await resolveRepo(fx.root);
      const checkouts = await listWorktreesDetailed(repo);
      const review = taskReview(await workflow.get(), a.id, checkouts)!;
      const context = resolveTargetContext(repo, checkouts, review.targetKey);
      const files = await listTargetDiffs(context);
      expect(files.map((entry) => entry.path)).toEqual(['dependency', 'task.txt']);
      expect(await getFullFile(context, 'dependency', 'old')).toBe(`Subproject commit ${before}\n`);
      expect(await getFullFile(context, 'dependency', 'new')).toBe(`Subproject commit ${after}\n`);
      const connected = await preview.set([a.id]);
      expect(connected.status).toBe('current');
      expect(fx.git('-C', connected.worktree!, 'rev-parse', 'HEAD:dependency').trim()).toBe(after);
      await workflow.prepare(a.id, { sourceHead: sourceHead(a), developmentHead: head() });
      const staged = resolveTargetContext(repo, checkouts, 'staged');
      expect(await getFullFile(staged, 'dependency', 'old')).toBe(`Subproject commit ${before}\n`);
      expect(await getFullFile(staged, 'dependency', 'new')).toBe(`Subproject commit ${after}\n`);
      const delivered = await deliver(a, 'Update dependency and code');
      expect(fx.git('rev-parse', 'HEAD:dependency').trim()).toBe(after);
      expect(fx.git('rev-parse', 'HEAD^{tree}').trim()).toBe(fx.git('-C', a.worktree, 'rev-parse', 'HEAD^{tree}').trim());
      expect(delivered.sourceBase).toBe(sourceHead(a));
      const live = { cwd: a.worktree, key: 'all', target: { kind: 'all' as const } };
      expect(await getFullFile(live, 'dependency', 'new')).toBe(`Subproject commit ${after}\n`);
      const nested = path.join(a.worktree, 'dependency');
      fx.git('clone', '--quiet', '--no-checkout', fx.root, nested);
      fx.git('-C', nested, 'switch', '--detach', after);
      expect(await getFullFile(live, 'dependency', 'new')).toBe(`Subproject commit ${after}\n`);
      await writeFile(path.join(nested, 'src/a.ts'), 'Saved submodule edit\n');
      expect(await getFullFile(live, 'dependency', 'new')).toBe(`Subproject commit ${after}-dirty\n`);
    },
  );

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

  it('reports unavailable workspaces per item and requires a fresh check after they return', { timeout: longGitTimeout }, async () => {
    const unavailable = await task('Unavailable');
    const available = await task('Available');
    await edit(available, 'task.txt', 'Task change\n', true);
    await fx.write('primary.txt', 'Primary change\n');
    fx.git('add', 'primary.txt');
    fx.git('commit', '-qm', 'Primary change');
    const target = head();
    const before = sourceHead(unavailable);
    const moved = path.join(data, 'unavailable-workspace');
    await rename(unavailable.worktree, moved);
    const unavailableItem = { changeId: unavailable.id, sourceHead: '', developmentHead: target };
    try {
      const checks = (await workflow.rebaseChecks()).checks;
      expect(checks.find((check) => check.changeId === unavailable.id)).toMatchObject({ ...unavailableItem, status: 'blocked' });
      expect(checks.find((check) => check.changeId === available.id)?.status).toBe('ready');
      const action = parseWorkbenchAction({
        type: 'rebase.run',
        items: checks.map(({ changeId, sourceHead, developmentHead }) => ({ changeId, sourceHead, developmentHead })),
      });
      if (action.type !== 'rebase.run') throw new Error('Expected rebase action');
      const response = await workflow.rebaseBatch(action);
      expect(response.results).toEqual([
        { changeId: unavailable.id, status: 'failed', message: expect.stringContaining('The task workspace no longer exists') },
        { changeId: available.id, status: 'updated' },
      ]);
      expect(fx.git('-C', available.worktree, 'rev-parse', 'HEAD^').trim()).toBe(target);
      expect(await file(available.worktree, 'task.txt')).toBe('Task change\n');
      expect(head()).toBe(target);
    } finally {
      await rename(moved, unavailable.worktree);
    }

    expect((await workflow.rebaseBatch({ items: [unavailableItem] })).results).toEqual([
      { changeId: unavailable.id, status: 'failed', message: expect.stringContaining('Run the check again.') },
    ]);
    expect(sourceHead(unavailable)).toBe(before);
    expect(fx.git('-C', unavailable.worktree, 'status', '--porcelain')).toBe('');
    expect(await listSafetyBackups(store)).toEqual([]);
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
    expect((await preview.get()).worktree).toBe(`${fx.root}-work`);
    expect(await readdir(path.join(data, 'operations'))).toEqual([]);
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

  it('keeps the edits made in the work folder when connections change, and shows them as its only changes', async () => {
    const a = await task('A');
    await edit(a, 'a.txt', 'A\n');
    const folder = (await preview.set([a.id])).worktree!;
    const status = () =>
      fx
        .git('-C', folder, 'status', '--porcelain')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim())
        .sort();
    expect(status()).toEqual([]);
    await writeFile(path.join(folder, 'README.md'), 'Edited in the work folder\n');
    await writeFile(path.join(folder, 'notes.txt'), 'New file in the work folder\n');
    fx.git('-C', folder, 'add', 'notes.txt');
    await edit(a, 'a.txt', 'A again\n');
    expect((await preview.refresh()).status).toBe('current');
    expect(await file(folder, 'a.txt')).toBe('A again\n');
    expect(await file(folder, 'README.md')).toBe('Edited in the work folder\n');
    // The index follows the composition, so a file staged by the user is theirs again, unstaged.
    expect(status()).toEqual(['?? notes.txt', 'M README.md']);
    await preview.set([]);
    await expect(file(folder, 'a.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await file(folder, 'README.md')).toBe('Edited in the work folder\n');
    expect(await file(folder, 'notes.txt')).toBe('New file in the work folder\n');
    expect(status()).toEqual(['?? notes.txt', 'M README.md']);
    expect(fx.git('status', '--porcelain').trim()).toBe('');
  });

  it('merges a task change into a file the user edited elsewhere', async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    await fx.write('long.txt', `${lines.join('\n')}\n`);
    fx.git('add', 'long.txt');
    fx.git('commit', '-qm', 'Add a long file');
    const a = await task('A');
    const folder = (await preview.set([a.id])).worktree!;
    await writeFile(path.join(folder, 'long.txt'), `${['user first line', ...lines.slice(1)].join('\n')}\n`);
    await edit(a, 'long.txt', `${[...lines.slice(0, 11), 'agent last line'].join('\n')}\n`);
    expect((await preview.refresh()).status).toBe('current');
    expect(await file(folder, 'long.txt')).toBe(`${['user first line', ...lines.slice(1, 11), 'agent last line'].join('\n')}\n`);
    expect(fx.git('-C', folder, 'status', '--porcelain').trim()).toBe('M long.txt');
  });

  it('leaves the work folder alone when an edit there conflicts with a connected change', async () => {
    const a = await task('A');
    await edit(a, 'a.txt', 'A\n');
    const folder = (await preview.set([a.id])).worktree!;
    await writeFile(path.join(folder, 'a.txt'), 'user fix\n');
    // The edit builds on a file only the task provides, so the task cannot be taken away under it.
    await expect(preview.set([])).rejects.toMatchObject({ code: 'preview_conflict' });
    expect(await file(folder, 'a.txt')).toBe('user fix\n');
    expect((await preview.get()).connectedIds).toEqual([a.id]);
    await edit(a, 'a.txt', 'A changed by the agent\n');
    const result = await preview.refresh();
    expect(result).toMatchObject({ status: 'stale', syncStatus: 'conflict' });
    expect(result.message).toContain('a.txt');
    expect(await file(folder, 'a.txt')).toBe('user fix\n');
    // Once the agent has taken the fix over, the same content on both sides is no conflict.
    await edit(a, 'a.txt', 'user fix\n');
    expect((await preview.refresh()).status).toBe('current');
    expect(fx.git('-C', folder, 'status', '--porcelain').trim()).toBe('');
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

describe('saved baseline and preview runtime', () => {
  it('composes from the base branch commit and leaves uncommitted primary files out and untouched', async () => {
    const a = await task('A');
    await edit(a, 'agent.txt', 'agent\n', true);
    await fx.write('src/b.ts', 'export const b = 200;\n');
    fx.git('add', 'src/b.ts');
    await fx.write('human.txt', 'Untracked file in primary\n');
    const before = fx.git('status', '--porcelain');
    const index = await readFile(path.join(fx.root, '.git/index'));
    const result = await preview.set([a.id]);
    expect(result.worktree).toBe(`${fx.root}-work`);
    expect(await file(result.worktree!, 'src/b.ts')).toBe(fx.git('show', 'HEAD:src/b.ts'));
    await expect(file(result.worktree!, 'human.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await file(result.worktree!, 'agent.txt')).toBe('agent\n');
    expect(fx.git('status', '--porcelain')).toBe(before);
    expect(await readFile(path.join(fx.root, '.git/index'))).toEqual(index);
    await expect(workflow.prepare(a.id, { sourceHead: sourceHead(a), developmentHead: head() })).rejects.toMatchObject({ code: 'development_dirty' });
    expect(fx.git('status', '--porcelain')).toBe(before);
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

  it('does not look up remote default branches when a tick finds nothing changed', async () => {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'a.txt', 'one\n');
    await edit(b, 'b.txt', 'one\n');
    expect((await preview.set([a.id, b.id])).syncStatus).toBe('synced');
    await preview.tick();
    // Nothing in the work folder's inputs depends on a remote's default branch, and the lookup
    // was one more Git process for every task workspace, every second.
    const reads = vi.spyOn(git, 'runGit');
    try {
      await preview.tick();
      expect(reads.mock.calls.length).toBeGreaterThan(0);
      expect(reads.mock.calls.filter(([args]) => args[0] === 'for-each-ref').map(([args, options]) => [args.join(' '), options.cwd])).toEqual([]);
    } finally {
      reads.mockRestore();
    }
  });

  it('validates the shared repository once for the inventory when a tick finds nothing changed', async () => {
    const a = await task('A');
    const b = await task('B');
    await edit(a, 'a.txt', 'one\n');
    await edit(b, 'b.txt', 'one\n');
    expect((await preview.set([a.id, b.id])).syncStatus).toBe('synced');
    await preview.tick();
    // The setup mirror and the checkout inventory both need the shared repository, and each
    // ownership check is two Git processes, every second. These are clone tasks: a shared-kind
    // task still validates the repository again when its own checkout is verified.
    const reads = vi.spyOn(git, 'runGit');
    try {
      await preview.tick();
      const calls = reads.mock.calls.map(([args]) => args.join(' '));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((call) => call === 'rev-parse --is-bare-repository --absolute-git-dir')).toHaveLength(1);
      expect(calls.filter((call) => call.startsWith('config --get-regexp ^(warden'))).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
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

describe('committing work folder edits', () => {
  const primaryStatus = () => fx.git('status', '--porcelain').trim();
  async function editedFolder() {
    const a = await task('A');
    await edit(a, 'a.txt', 'A\n');
    const folder = (await preview.set([a.id])).worktree!;
    await writeFile(path.join(folder, 'README.md'), 'Edited in the work folder\n');
    await writeFile(path.join(folder, 'notes.txt'), 'New file in the work folder\n');
    return { a, folder };
  }
  const review = async () => {
    const changes = await preview.changes();
    return { tree: changes.tree!, developmentHead: changes.developmentHead! };
  };

  it('keeps edits committed or staged natively in the work folder as edits', { timeout: longGitTimeout }, async () => {
    const { a, folder } = await editedFolder();
    const base = head();
    const run = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: folder, encoding: 'utf8' }).trim();
    const composition = run('rev-parse', 'HEAD');
    // The Source Control view offers Git's own commit; on the detached HEAD it reaches no branch.
    run('add', 'README.md');
    run('commit', '-qm', 'Native commit in the work folder');
    run('add', 'notes.txt');
    expect(run('rev-parse', 'HEAD')).not.toBe(composition);
    expect((await preview.changes()).files).toEqual([
      { path: 'README.md', status: 'modified' },
      { path: 'notes.txt', status: 'added' },
    ]);
    await edit(a, 'a.txt', 'A again\n');
    expect(await preview.refresh()).toMatchObject({ syncStatus: 'synced' });
    expect(await file(folder, 'a.txt')).toBe('A again\n');
    expect(run('log', '-1', '--format=%s')).not.toBe('Native commit in the work folder');
    expect(head()).toBe(base);
    expect((await preview.changes()).files).toEqual([
      { path: 'README.md', status: 'modified' },
      { path: 'notes.txt', status: 'added' },
    ]);
    await workflow.commitWorkFolder({ ...(await review()), message: 'Describe the work folder' });
    expect(fx.git('diff', '--name-only', 'HEAD^', 'HEAD').trim().split('\n')).toEqual(['README.md', 'notes.txt']);
  });

  it('commits only the user edits to the base branch and leaves connected task changes pending', { timeout: longGitTimeout }, async () => {
    const { a, folder } = await editedFolder();
    const before = head();
    const changes = await preview.changes();
    expect(changes).toMatchObject({ directory: folder, developmentHead: before });
    expect(changes.files).toEqual([
      { path: 'README.md', status: 'modified' },
      { path: 'notes.txt', status: 'added' },
    ]);
    const after = await workflow.commitWorkFolder({ ...(await review()), message: 'Describe the work folder' });
    expect(after.files).toEqual([]);
    expect(fx.git('log', '-1', '--format=%s').trim()).toBe('Describe the work folder');
    expect(fx.git('rev-parse', 'HEAD^').trim()).toBe(before);
    expect(fx.git('diff', '--name-only', 'HEAD^', 'HEAD').trim().split('\n')).toEqual(['README.md', 'notes.txt']);
    expect(primaryStatus()).toBe('');
    expect(await file(fx.root, 'notes.txt')).toBe('New file in the work folder\n');
    await expect(file(fx.root, 'a.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    // The folder now stands on the new commit: the task's change is still there, and nothing is the user's.
    expect(await file(folder, 'a.txt')).toBe('A\n');
    expect(fx.git('-C', folder, 'status', '--porcelain').trim()).toBe('');
    expect((await preview.get()).connectedIds).toEqual([a.id]);
    expect((await store.load()).workFolderCommit).toBeUndefined();
  });

  it('refuses edits that build on a connected task and changes nothing', { timeout: longGitTimeout }, async () => {
    const { folder } = await editedFolder();
    await writeFile(path.join(folder, 'a.txt'), 'A, corrected by the user\n');
    const before = head();
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Correct the task' })).rejects.toMatchObject({
      code: 'work_folder_depends',
      message: expect.stringContaining('a.txt'),
    });
    expect(head()).toBe(before);
    expect(primaryStatus()).toBe('');
    expect(await file(folder, 'a.txt')).toBe('A, corrected by the user\n');
    expect((await store.load()).workFolderCommit).toBeUndefined();
  });

  it('requires the reviewed content, a synced folder and a message', { timeout: longGitTimeout }, async () => {
    const { folder } = await editedFolder();
    const reviewed = await review();
    await expect(workflow.commitWorkFolder({ ...reviewed, message: ' ' })).rejects.toMatchObject({ code: 'invalid_commit_message' });
    await writeFile(path.join(folder, 'notes.txt'), 'Changed after review\n');
    await expect(workflow.commitWorkFolder({ ...reviewed, message: 'Stale review' })).rejects.toMatchObject({ code: 'review_changed' });
    await fx.write('primary.txt', 'Committed in primary\n');
    fx.git('add', 'primary.txt');
    fx.git('commit', '-qm', 'Advance the base branch');
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Behind the base branch' })).rejects.toMatchObject({ code: 'review_changed' });
    await preview.refresh();
    await writeFile(path.join(folder, 'notes.txt'), 'New file in the work folder\n');
    await writeFile(path.join(folder, 'README.md'), fx.git('show', 'HEAD:README.md'));
    await rm(path.join(folder, 'notes.txt'));
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Nothing left' })).rejects.toMatchObject({ code: 'empty_change' });
    expect(primaryStatus()).toBe('');
  });

  it('returns primary to the base commit when a hook rejects the commit, and after an interrupted commit', { timeout: longGitTimeout }, async () => {
    const { folder } = await editedFolder();
    const before = head();
    const hook = path.join(fx.root, '.git', 'hooks', 'commit-msg');
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, '#!/bin/sh\necho blocked-by-hook >&2\nexit 1\n');
    await chmod(hook, 0o755);
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Rejected' })).rejects.toMatchObject({
      code: 'commit_failed',
      message: expect.stringContaining('blocked-by-hook'),
    });
    expect(head()).toBe(before);
    expect(primaryStatus()).toBe('');
    expect(await file(folder, 'README.md')).toBe('Edited in the work folder\n');
    expect((await store.load()).workFolderCommit).toBeUndefined();
    await rm(hook);

    // Killed after staging: the patch is in primary's index and the journal names it.
    const write = git.runGitWrite;
    vi.spyOn(git, 'runGitWrite').mockImplementation(async (args, options) => {
      if (args[0] === 'commit' && options.cwd === fx.root) throw new Error('killed');
      if (args.includes('-R')) throw new Error('killed');
      return write(args, options);
    });
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Interrupted' })).rejects.toThrow('killed');
    vi.restoreAllMocks();
    expect(primaryStatus()).not.toBe('');
    expect((await store.load()).workFolderCommit).toMatchObject({ parent: before });
    // Staged content that is not the journaled patch is someone's work and stops the recovery.
    await fx.write('other.txt', 'Unrelated\n');
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Blocked' })).rejects.toMatchObject({ code: 'development_dirty' });
    await rm(path.join(fx.root, 'other.txt'));
    await workflow.commitWorkFolder({ ...(await review()), message: 'Committed after recovery' });
    expect(fx.git('log', '-1', '--format=%s').trim()).toBe('Committed after recovery');
    expect(fx.git('rev-parse', 'HEAD^').trim()).toBe(before);
    expect(primaryStatus()).toBe('');
    expect(fx.git('-C', folder, 'status', '--porcelain').trim()).toBe('');
  });

  it('reports the hook output when the rejecting hook also left edits in primary', { timeout: longGitTimeout }, async () => {
    const { folder } = await editedFolder();
    const before = head();
    const hook = path.join(fx.root, '.git', 'hooks', 'pre-commit');
    await mkdir(path.dirname(hook), { recursive: true });
    // A formatter that rewrites a file and then a check that fails: the hook's edit is unstaged.
    await writeFile(hook, '#!/bin/sh\necho "Formatted by hook" > README.md\necho lint-failed-in-hook >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const rejected = await workflow.commitWorkFolder({ ...(await review()), message: 'Rejected' }).catch((error) => error);
    expect(rejected).toMatchObject({ code: 'commit_failed' });
    expect(rejected.message).toContain('lint-failed-in-hook');
    expect(rejected.message).toContain('the primary folder has other changes');
    // Nothing is discarded: the hook's edit stays in primary and the edits stay in the work folder.
    expect(head()).toBe(before);
    expect(await file(fx.root, 'README.md')).toBe('Formatted by hook\n');
    expect(await file(folder, 'README.md')).toBe('Edited in the work folder\n');
    expect((await store.load()).workFolderCommit).toMatchObject({ parent: before });
    await rm(hook);

    // Once the hook's edit is handled, the staged patch is recognized and removed, and the commit goes through.
    fx.git('checkout', '--', 'README.md');
    await workflow.commitWorkFolder({ ...(await review()), message: 'Committed after the hook' });
    expect(fx.git('log', '-1', '--format=%s').trim()).toBe('Committed after the hook');
    expect(fx.git('rev-parse', 'HEAD^').trim()).toBe(before);
    expect(primaryStatus()).toBe('');
    expect((await store.load()).workFolderCommit).toBeUndefined();
  });

  it('clears an interrupted work folder commit from primary before a task is committed', { timeout: longGitTimeout }, async () => {
    const { a, folder } = await editedFolder();
    const before = head();
    const write = git.runGitWrite;
    const interrupt = () =>
      vi.spyOn(git, 'runGitWrite').mockImplementation(async (args, options) => {
        if (args[0] === 'commit' && options.cwd === fx.root) throw new Error('killed');
        if (args.includes('-R')) throw new Error('killed');
        return write(args, options);
      });
    interrupt();
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Interrupted' })).rejects.toThrow('killed');
    vi.restoreAllMocks();
    expect(primaryStatus()).not.toBe('');

    // The staged patch is Warden's own leftover, invisible from the work folder window.
    await edit(a, 'a.txt', 'A\n', true);
    await deliver(a, 'Deliver A');
    expect(fx.git('log', '-1', '--format=%s').trim()).toBe('Deliver A');
    expect(fx.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('a.txt');
    expect(fx.git('rev-parse', 'HEAD^').trim()).toBe(before);
    expect(primaryStatus()).toBe('');
    expect((await store.load()).workFolderCommit).toBeUndefined();
    expect(await file(folder, 'README.md')).toBe('Edited in the work folder\n');

    // Someone else's change beside the leftover still stops the task commit.
    const b = await task('B');
    await edit(b, 'b.txt', 'B\n', true);
    interrupt();
    await expect(workflow.commitWorkFolder({ ...(await review()), message: 'Interrupted again' })).rejects.toThrow('killed');
    vi.restoreAllMocks();
    await fx.write('other.txt', 'Unrelated\n');
    await expect(deliver(b, 'Deliver B')).rejects.toMatchObject({ code: 'development_dirty' });
    expect(await file(fx.root, 'other.txt')).toBe('Unrelated\n');
    expect((await store.load()).workFolderCommit).toBeDefined();
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
  it('previews and applies A1,A2,B1 with a new message while keeping files and agent checkouts unchanged', { timeout: historyReplayTimeout }, async () => {
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

  it('finishes a published history mapping after an interrupted state write without rewriting twice', { timeout: historyReplayTimeout }, async () => {
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

    const a = await task('Malformed batch');
    const before = sourceHead(a);
    await fx.write('primary.txt', 'Primary change\n');
    fx.git('add', 'primary.txt');
    fx.git('commit', '-qm', 'Primary change');
    const valid = { changeId: a.id, sourceHead: before, developmentHead: head() };
    for (const invalid of [
      { sourceHead: undefined },
      { sourceHead: null },
      { sourceHead: 1 },
      { sourceHead: 'not-an-oid' },
      { sourceHead: ' ' },
      { sourceHead: '', developmentHead: '' },
      { sourceHead: '', developmentHead: '--help' },
    ]) {
      expect((await post('/api/workflow/rebase', { items: [valid, { ...valid, ...invalid }] })).status).toBe(400);
      expect(sourceHead(a)).toBe(before);
    }
    expect(await listSafetyBackups(store)).toEqual([]);
  });
});
