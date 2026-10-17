import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentChange, SlotKind, WorkflowResponse } from '@warden/shared';
import { createApp, resolveRepo, StateStore, WorkflowService } from '@warden/server';
import { listWorktreesDetailed } from '../packages/server/src/worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let store: StateStore;
let workflow: WorkflowService;
const gitAt = (change: DevelopmentChange, ...args: string[]) => fx.git('-C', change.worktree, ...args).trim();
// These two delivery/replay scenarios exceeded 24 seconds on native Windows with real Git.
// Limit the additional process-startup allowance to those measured multi-step cases.
const longGitTimeout = process.platform === 'win32' ? 90_000 : 30_000;

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-workflow-');
  fx.git('config', 'user.name', 'Reviewer');
  fx.git('config', 'user.email', 'reviewer@example.com');
  fx.git('switch', '-c', 'feature/order');
  data = await mkdtemp(path.join(os.tmpdir(), 'warden-workflow-state-'));
  store = new StateStore(path.join(data, 'state.json'), fx.root);
  workflow = new WorkflowService(await resolveRepo(fx.root), store);
  await workflow.configure('feature/order');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const row of await listWorktreesDetailed(await resolveRepo(fx.root))) {
    if (row.slot !== undefined) await rm(row.path, { recursive: true, force: true });
  }
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

async function commit(change: DevelopmentChange, file = 'task.txt', content = 'task\n') {
  await writeFile(path.join(change.worktree, file), content);
  gitAt(change, 'add', file);
  gitAt(change, 'commit', '-qm', 'Agent progress');
}

async function task(title: string, kind: SlotKind = 'worktree') {
  const planned = await workflow.create({ title });
  const change = await workflow.start(planned.id, { kind });
  gitAt(change, 'config', 'user.name', 'Agent');
  gitAt(change, 'config', 'user.email', 'agent@example.com');
  return change;
}

async function accept(change: DevelopmentChange) {
  const current = (await workflow.get()).workflow!.changes.find((row) => row.id === change.id)!;
  if (change.deliveries?.length && current.status !== 'integrating')
    return workflow.accept(change.id, { mode: 'record', commit: change.deliveries.at(-1)!.commit });
  if (current.status !== 'integrating') await prepare(change);
  const pending = (await workflow.get()).preparation!;
  return workflow.accept(
    change.id,
    pending.state === 'committed'
      ? { mode: 'record', commit: pending.head! }
      : { mode: 'commit', developmentHead: pending.head!, indexFingerprint: pending.indexFingerprint!, message: change.title },
  );
}

function prepare(change: DevelopmentChange) {
  return workflow.prepare(change.id, { sourceHead: change.submittedHead!, developmentHead: change.base });
}

async function hook(name: string, body: string) {
  const dir = path.join(data, 'hooks');
  await mkdir(dir, { recursive: true });
  fx.git('config', 'core.hooksPath', dir);
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const shellCheckout = (cwd: string) => shellQuote(fx.git('-C', cwd, 'rev-parse', '--show-toplevel').trim());

describe('requirement development workflow', () => {
  it('runs thin creation hooks with workspace context and preserves failed assignments and delivered workspaces', async () => {
    const app = createApp({ repo: await resolveRepo(fx.root), store });
    const configure = (hooks: unknown) =>
      app.request('/api/workspace/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands: [], hooks }),
      });
    expect((await configure({ create: 1 })).status).toBe(400);
    expect(
      (
        await configure({
          create: 'git rev-parse --show-toplevel; printf "%s\\n" "$WARDEN_TASK_ID" "$WARDEN_HOOK_EVENT"; exit 7',
          reuse: 'printf "%s" "$WARDEN_HOOK_EVENT"',
        })
      ).status,
    ).toBe(200);
    const change = await task('Hook context');
    expect(change.workspaceHook).toMatchObject({ status: 'failed', event: 'create', exitCode: 7 });
    expect(change.workspaceHook!.output).toContain(`${gitAt(change, 'rev-parse', '--show-toplevel')}\n${change.id}\ncreate`);
    expect((await workflow.start(change.id)).workspaceHook).toEqual(change.workspaceHook);
    await configure({ create: 'printf "%s" "$WARDEN_DEVELOPMENT_BRANCH"', reuse: 'printf "%s" "$WARDEN_HOOK_EVENT"' });
    expect((await workflow.retryHook(change.id)).workspaceHook).toMatchObject({ status: 'succeeded', exitCode: 0, output: 'feature/order' });
    await commit(change);
    await accept(await workflow.ready(change.id));
    const reused = await task('Reuse hook');
    expect(reused.worktree).not.toBe(change.worktree);
    expect(reused.workspaceHook).toMatchObject({ status: 'succeeded', event: 'create', output: 'feature/order' });
  });

  it('runs the reuse hook in an available workspace with its new task context', async () => {
    const available = `${fx.root}-1`;
    fx.git('worktree', 'add', '--detach', available, 'feature/order');
    await store.update((state) => {
      state.workspaceConfig = {
        commands: [],
        hooks: {
          create: 'exit 9',
          reuse: 'git rev-parse --show-toplevel; printf "%s\\n" "$WARDEN_TASK_ID" "$WARDEN_HOOK_EVENT" "$WARDEN_DEVELOPMENT_BRANCH"',
        },
      };
    });
    const change = await task('Reuse available checkout');
    expect(change.worktree).toBe(available);
    expect(change.workspaceHook).toMatchObject({ status: 'succeeded', event: 'reuse', exitCode: 0 });
    expect(change.workspaceHook!.output).toBe(`${gitAt(change, 'rev-parse', '--show-toplevel')}\n${change.id}\nreuse\nfeature/order\n`);
  });

  it('plans and edits commits without allocating a checkout or pinning an old baseline', async () => {
    const branches = fx.git('branch', '--format=%(refname)');
    const planned = await workflow.create({ title: 'Plan validation', body: 'Handle empty orders', acceptance: 'Tests cover empty input' });
    expect(planned).toMatchObject({ status: 'planned', body: 'Handle empty orders', acceptance: 'Tests cover empty input' });
    expect(planned.worktree).toBeUndefined();
    expect(planned.base).toBeUndefined();
    expect(await listWorktreesDetailed(await resolveRepo(fx.root))).toHaveLength(1);
    expect(fx.git('branch', '--format=%(refname)')).toBe(branches);
    await workflow.update(planned.id, { title: 'Validate orders', acceptance: 'Reject negative values' });
    await expect(workflow.ready(planned.id)).rejects.toMatchObject({ code: 'change_not_started' });
    await expect(workflow.resume(planned.id)).rejects.toMatchObject({ code: 'change_not_started' });
    await fx.write('foundation.txt', 'new baseline');
    fx.git('add', '.');
    fx.git('commit', '-qm', 'Advance development');
    const head = fx.git('rev-parse', 'HEAD').trim();
    const first = await workflow.start(planned.id, { agent: 'Codex' });
    const duplicate = await workflow.start(planned.id, { agent: 'Codex' });
    expect(first).toMatchObject({
      id: planned.id,
      status: 'working',
      agent: 'Codex',
      base: head,
      title: 'Validate orders',
      acceptance: 'Reject negative values',
    });
    expect(duplicate.worktree).toBe(first.worktree);
    expect(await listWorktreesDetailed(await resolveRepo(fx.root))).toHaveLength(2);
    await expect(workflow.update(first.id, { status: 'archived' })).rejects.toMatchObject({ code: 'change_started' });
  });

  it('lets the user allocate ordered tasks in parallel despite legacy dependencies', async () => {
    const first = await task('Order foundation');
    const planned = await workflow.create({ title: 'Payment retry', dependsOn: [first.id] });
    const second = await workflow.start(planned.id);
    expect(second.status).toBe('working');
    expect(second.base).toBe(first.base);
    expect(second.worktree).not.toBe(first.worktree);
    await commit(first);
    const accepted = await accept(await workflow.ready(first.id));
    const later = await workflow.create({ title: 'Later work' });
    const started = await workflow.start(later.id);
    expect(started.base).toBe(accepted.deliveries!.at(-1)!.commit);
    expect(started.worktree).not.toBe(first.worktree);
  });

  it('retains legacy planning metadata without enforcing a graph and isolates requirements', async () => {
    const a = await workflow.create({ title: 'A', dependsOn: ['missing'] });
    const b = await workflow.create({ title: 'B', dependsOn: [a.id] });
    expect(await workflow.update(a.id, { dependsOn: [b.id, b.id] })).toMatchObject({ dependsOn: [b.id] });
    await expect(workflow.update(a.id, { dependsOn: [1] as unknown as string[] })).rejects.toMatchObject({ status: 400 });
    await workflow.configure('main');
    const other = await workflow.create({ title: 'Another requirement' });
    await expect(workflow.start(a.id)).rejects.toMatchObject({ code: 'requirement_changed' });
    await workflow.configure('feature/order');
    expect((await workflow.get()).workflow!.changes.map((row) => row.id)).toEqual([a.id, b.id, other.id]);
  });

  it('reorders and archives plans without pretending they produced commits', async () => {
    const a = await workflow.create({ title: 'A' });
    const b = await workflow.create({ title: 'B' });
    await workflow.move(b.id, a.id);
    expect((await workflow.get()).workflow!.changes.map((row) => row.id)).toEqual([b.id, a.id]);
    await workflow.update(a.id, { status: 'archived' });
    await expect(workflow.start(a.id)).rejects.toMatchObject({ code: 'change_not_planned' });
    expect((await workflow.get()).workflow!.changes.find((row) => row.id === a.id)?.integration).toBeUndefined();
    await workflow.update(a.id, { status: 'planned' });
    await workflow.start(a.id);
    await workflow.move(a.id, b.id);
    expect((await workflow.update(a.id, { body: 'Updated while working' })).body).toBe('Updated while working');
  });

  it('migrates matching todos once, keeps descriptions and comments, and archives old checkmarks', async () => {
    const running = await task('Existing task');
    const todo = (id: string, branch: string, status: 'open' | 'done' = 'open') => ({
      id,
      branch,
      status,
      title: id,
      body: 'Preserve this note',
      commentIds: ['review-1'],
      createdAt: '2026-10-14T00:00:00Z',
      updatedAt: '2026-10-14T00:00:00Z',
    });
    await store.update((state) => {
      state.todos.push(todo('open', 'feature/order'), todo('done', running.branch, 'done'), todo('other', 'main'));
    });
    const response = await workflow.get();
    expect(response.workflow!.changes.find((row) => row.id === 'todo-open')).toMatchObject({
      status: 'planned',
      body: 'Preserve this note',
      commentIds: ['review-1'],
    });
    expect(response.workflow!.changes.find((row) => row.id === 'todo-done')).toMatchObject({
      status: 'archived',
      legacyTodo: { branch: running.branch, status: 'done' },
    });
    expect(response.workflow!.changes.find((row) => row.id === 'todo-done')?.integration).toBeUndefined();
    expect(response.legacyTodos?.map((row) => row.id)).toEqual(['other']);
    await workflow.importTodo('other');
    await store.update(() => undefined);
    const reloaded = await new StateStore(path.join(data, 'state.json'), fx.root).load();
    expect(reloaded.todos).toEqual([]);
    expect(reloaded.workflow!.changes.filter((row) => row.id.startsWith('todo-'))).toHaveLength(3);
    await workflow.get();
    expect((await store.load()).workflow!.changes).toHaveLength(4);
  });

  it('exposes planning and explicit execution through the API and rejects invalid comments', async () => {
    const app = createApp({ repo: await resolveRepo(fx.root), store });
    const send = (method: string, url: string, body: unknown) =>
      app.request(`/api/workflow${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const created = await send('POST', '/changes', { title: 'From API', acceptance: 'Pass tests' });
    expect(created.status).toBe(201);
    const plan = (await created.json()) as { id: string; status: string; worktree?: string };
    expect(plan.status).toBe('planned');
    expect(plan.worktree).toBeUndefined();
    expect((await send('POST', '/changes', { title: 'Bad link', commentIds: ['missing'] })).status).toBe(400);
    expect((await send('PATCH', `/changes/${plan.id}`, { body: 'Updated plan' })).status).toBe(200);
    const started = await send('POST', `/changes/${plan.id}/start`, { agent: 'Example agent', kind: 'worktree' });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ status: 'working', agent: 'Example agent', body: 'Updated plan' });
    expect((await send('POST', `/changes/${plan.id}/start`, null)).status).toBe(400);
  });

  it('squashes multiple commits into the selected development branch and preserves the checkout', async () => {
    const main = fx.git('rev-parse', 'main').trim();
    const change = await task('Add order validation');
    await commit(change);
    await commit(change, 'task.txt', 'final\n');
    const source = gitAt(change, 'rev-parse', 'HEAD');
    await mkdir(path.join(change.worktree, 'node_modules'));
    await writeFile(path.join(change.worktree, 'node_modules/keep'), 'dependency');
    fx.git('config', 'core.excludesFile', path.join(data, 'ignore'));
    await writeFile(path.join(data, 'ignore'), 'node_modules/\n');
    const accepted = await accept(await workflow.ready(change.id));
    expect(accepted.status).toBe('working');
    expect(accepted.cleanupError).toBeUndefined();
    expect(fx.git('rev-list', '--count', `${main}..feature/order`).trim()).toBe('1');
    expect(fx.git('rev-parse', 'main').trim()).toBe(main);
    expect(fx.git('log', '-1', '--format=%s').trim()).toBe(change.title);
    expect(fx.git('rev-parse', 'HEAD^{tree}').trim()).toBe(fx.git('rev-parse', `${source}^{tree}`).trim());
    expect(fx.git('rev-parse', `refs/warden/changes/${change.id}/source`).trim()).toBe(source);
    expect((await listWorktreesDetailed(await resolveRepo(fx.root))).find((row) => row.path === change.worktree)?.free).toBe(false);
    expect(await readFile(path.join(change.worktree, 'node_modules/keep'), 'utf8')).toBe('dependency');
    const next = await task('Next change');
    expect(next.worktree).not.toBe(change.worktree);
    expect(gitAt(next, 'rev-parse', 'HEAD')).toBe(accepted.deliveries!.at(-1)!.commit);
    await accept(accepted);
    expect(gitAt(next, 'branch', '--show-current')).toBe(next.branch);
  });

  it('leaves every sibling unchanged after delivery and legacy handoff', async () => {
    const a = await task('A');
    const b = await task('B');
    const c = await task('C');
    await commit(a, 'a.txt');
    await commit(b, 'b.txt');
    await commit(c, 'c.txt');
    const bReady = await workflow.ready(b.id);
    fx.git('branch', 'keep-this-tip', bReady.submittedHead!);
    fx.git('config', 'rebase.updateRefs', 'true');
    const cHead = gitAt(c, 'rev-parse', 'HEAD');
    await accept(await workflow.ready(a.id));
    const changes = (await workflow.get()).workflow!.changes;
    const nextB = changes.find((row) => row.id === b.id)!;
    expect(nextB.base).toBe(b.base);
    expect(nextB.submittedHead).toBe(bReady.submittedHead);
    expect(nextB.sync?.status).toBe('pending');
    expect(fx.git('rev-parse', 'keep-this-tip').trim()).toBe(bReady.submittedHead);
    expect(changes.find((row) => row.id === c.id)?.sync?.status).toBe('pending');
    expect(gitAt(c, 'rev-parse', 'HEAD')).toBe(cHead);
    const nextC = await workflow.ready(c.id);
    expect(nextC.base).toBe(c.base);
    expect(nextC.sync?.status).toBe('pending');
    expect(await readFile(path.join(c.worktree, 'c.txt'), 'utf8')).toBe('task\n');
  });

  it('predicts a sibling rebase conflict without changing files or the accepted commit', { timeout: longGitTimeout }, async () => {
    const a = await task('A');
    const b = await task('B');
    await commit(a, 'src/b.ts', 'export const b = 10;\n');
    await commit(b, 'src/b.ts', 'export const b = 20;\n');
    const ready = await workflow.ready(b.id);
    const accepted = await accept(await workflow.ready(a.id));
    const nextB = (await workflow.get()).workflow!.changes.find((row) => row.id === b.id)!;
    expect(nextB.sync?.status).toBe('pending');
    expect((await workflow.rebaseChecks()).checks.find((r) => r.changeId === b.id)?.status).toBe('conflict');
    expect(gitAt(b, 'rev-parse', 'HEAD')).toBe(ready.submittedHead);
    expect(gitAt(b, 'status', '--porcelain')).toBe('');
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(accepted.deliveries!.at(-1)!.commit);
    await expect(workflow.prepare(nextB.id, { sourceHead: nextB.submittedHead!, developmentHead: accepted.deliveries!.at(-1)!.commit! })).rejects.toMatchObject(
      {
        code: 'delivery_conflict',
      },
    );
  });

  it('imports a clone task locally and preserves it while a new workspace uses the latest baseline', async () => {
    const clone = await task('Clone task', 'clone');
    await commit(clone);
    const accepted = await accept(await workflow.ready(clone.id));
    expect(accepted.cleanupError).toBeUndefined();
    expect(await readFile(path.join(fx.root, 'task.txt'), 'utf8')).toBe('task\n');
    const next = await task('Clone next', 'clone');
    expect(next.worktree).not.toBe(clone.worktree);
    expect(gitAt(next, 'rev-parse', 'HEAD')).toBe(accepted.deliveries!.at(-1)!.commit);
  });

  it('blocks dirty task and development checkouts, and refuses changed review revisions', async () => {
    const change = await task('Guard revisions');
    await writeFile(path.join(change.worktree, 'untracked.txt'), 'keep');
    await expect(workflow.ready(change.id)).rejects.toMatchObject({ code: 'worktree_dirty' });
    gitAt(change, 'add', '.');
    gitAt(change, 'commit', '-qm', 'save');
    const ready = await workflow.ready(change.id);
    await fx.write('local.txt', 'keep');
    await expect(accept(ready)).rejects.toMatchObject({ code: 'development_dirty' });
    await rm(path.join(fx.root, 'local.txt'));
    await commit(change, 'later.txt');
    await expect(accept(ready)).rejects.toMatchObject({ code: 'review_changed' });
    expect((await workflow.get()).workflow!.changes[0]!.status).toBe('working');
    expect(fx.git('rev-list', '--count', 'main..HEAD').trim()).toBe('0');
  });

  it('integrates a reviewed working task without an agent handoff and runs commit hooks', async () => {
    const change = await task('Direct review');
    await commit(change);
    const sourceHead = gitAt(change, 'rev-parse', 'HEAD');
    await hook('commit-msg', 'echo "Reviewed delivery" > "$1"');
    expect((await workflow.get()).workflow!.changes[0]!.status).toBe('working');
    await workflow.prepare(change.id, { sourceHead, developmentHead: change.base });
    expect((await accept(change)).status).toBe('working');
    expect(fx.git('log', '-1', '--format=%s').trim()).toBe('Reviewed delivery');
  });

  it('syncs a working task only on user request and rejects stale observed revisions', async () => {
    const first = await task('First');
    const second = await task('Second');
    await commit(first, 'first.txt');
    await commit(second, 'second.txt');
    const head = gitAt(second, 'rev-parse', 'HEAD');
    const accepted = await accept(await workflow.ready(first.id));
    expect(gitAt(second, 'rev-parse', 'HEAD')).toBe(head);
    await expect(workflow.sync(second.id, second.base)).rejects.toMatchObject({ code: 'review_changed' });
    const synced = await workflow.sync(second.id, head);
    expect(synced).toMatchObject({ status: 'working', base: accepted.deliveries!.at(-1)!.commit });
    expect(synced.sync).toBeUndefined();
    expect(gitAt(second, 'rev-parse', 'HEAD^')).toBe(accepted.deliveries!.at(-1)!.commit);
  });

  it('handles a repeated delivery request without duplicating a commit', async () => {
    const change = await task('Recover');
    await commit(change);
    const ready = await workflow.ready(change.id);
    const accepted = await accept(ready);
    const head = fx.git('rev-parse', 'HEAD').trim();
    expect((await workflow.accept(change.id, { mode: 'record', commit: head })).status).toBe('working');
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(fx.git('rev-list', '--count', 'main..HEAD').trim()).toBe('1');
    expect(accepted.deliveries!.at(-1)!.commit).toBe(head);
  });

  it('returns a prepared task to development only after the user restores the destination', async () => {
    const change = await task('Resume unpublished integration');
    await commit(change);
    const ready = await workflow.ready(change.id);
    await prepare(ready);
    await expect(workflow.resume(change.id)).rejects.toMatchObject({ code: 'development_dirty' });
    expect(await readFile(path.join(fx.root, 'task.txt'), 'utf8')).toBe('task\n');
    fx.git('restore', '--source=HEAD', '--staged', '--worktree', '--', 'task.txt');
    const resumed = await workflow.resume(change.id);
    expect(resumed.status).toBe('working');
    expect(resumed.integration).toBeUndefined();
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(ready.base);
    await commit(change, 'later.txt');
    await accept(await workflow.ready(change.id));
    expect(fx.git('rev-list', '--count', 'main..feature/order').trim()).toBe('1');
  });

  it('records review comments on each delivery without completing unrelated plan notes', async () => {
    const change = await task('Archive');
    await commit(change);
    const targetKey = `worktree:${change.worktree}:working`;
    await store.update((state) => {
      state.targets[targetKey] = {
        viewed: { 'task.txt': 'hash' },
        comments: [
          {
            id: 'feedback',
            targetKey,
            filePath: 'task.txt',
            body: 'Reviewed',
            side: 'new',
            startLine: 1,
            endLine: 1,
            codeSnippet: ['task'],
            status: 'active',
            createdAt: 'now',
            updatedAt: 'now',
            anchor: { hunkHash: 'h', lineHashes: [], contextBefore: [], contextAfter: [], hunkLineOffset: 0 },
          },
        ],
      };
      state.todos.push({ id: 'todo', branch: change.branch, title: 'Check', body: '', status: 'open', createdAt: 'now', updatedAt: 'now' });
    });
    const ready = await workflow.ready(change.id);
    const accepted = await accept(ready);
    await task('Next');
    const state = await store.load();
    expect(state.targets[`commit:${accepted.deliveries!.at(-1)!.commit}`]?.comments[0]?.body).toBe('Reviewed');
    expect(accepted.deliveries![0]!.review?.[0]?.body).toBe('Reviewed');
    expect(state.todos).toEqual([]);
    expect(state.workflow!.changes.find((row) => row.id === 'todo-todo')).toMatchObject({ status: 'planned', title: 'Check' });
  });

  it('keeps preparation ownership and refuses a sibling revision rewritten after acceptance', { timeout: longGitTimeout }, async () => {
    const a = await task('Concurrent A');
    const b = await task('Concurrent B');
    await commit(a, 'a.txt');
    await commit(b, 'b.txt');
    const readyA = await workflow.ready(a.id);
    const readyB = await workflow.ready(b.id);
    const parent = (await workflow.get()).developmentHead!;
    // Ownership survives releasing the repository lock. Test it separately from the bounded
    // wait for an in-flight operation, which correctly reports operation_locked when slow.
    await workflow.prepare(readyA.id, { sourceHead: readyA.submittedHead!, developmentHead: parent });
    await expect(workflow.prepare(readyB.id, { sourceHead: readyB.submittedHead!, developmentHead: parent })).rejects.toMatchObject({
      code: 'development_in_use',
    });
    const prepared = (await workflow.get()).workflow!.changes.find((row): row is DevelopmentChange => row.status === 'integrating')!;
    await accept(prepared);
    expect(fx.git('rev-list', '--count', 'main..feature/order').trim()).toBe('1');
    await expect(prepare(prepared.id === a.id ? readyB : readyA)).rejects.toMatchObject({ code: 'review_changed' });
    const remaining = prepared.id === a.id ? readyB : readyA;
    await workflow.prepare(remaining.id, { sourceHead: remaining.submittedHead!, developmentHead: fx.git('rev-parse', 'HEAD').trim() });
    await accept(remaining);
    expect(fx.git('rev-list', '--count', 'main..feature/order').trim()).toBe('2');
  });

  it('reports repository lock contention before a second preparation changes any files', async () => {
    const change = await task('Wait for the active repository operation');
    await commit(change);
    const ready = await workflow.ready(change.id);
    let acquired!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = store.withRepositoryLock(async () => {
      acquired();
      await gate;
    });
    await entered;
    try {
      await expect(prepare(ready)).rejects.toMatchObject({ code: 'operation_locked', status: 409 });
      expect(fx.git('rev-parse', 'HEAD').trim()).toBe(change.base);
      expect(fx.git('status', '--porcelain')).toBe('');
      expect((await store.load()).workflow!.changes[0]!.status).toBe('working');
    } finally {
      release();
      await holding;
    }
    expect((await prepare(ready)).status).toBe('integrating');
  });

  it('requires a checked-out development branch and preserves unrelated current files', async () => {
    fx.git('switch', 'main');
    await fx.write('local.txt', 'unrelated work');
    const main = fx.git('rev-parse', 'HEAD').trim();
    const change = await task('Only the chosen branch');
    await commit(change);
    await expect(accept(await workflow.ready(change.id))).rejects.toMatchObject({ code: 'development_checkout_missing' });
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(main);
    expect(fx.git('rev-parse', 'feature/order').trim()).toBe(main);
    expect(await readFile(path.join(fx.root, 'local.txt'), 'utf8')).toBe('unrelated work');
  });

  it('preserves a newer task tip during delivery retries and keeps the delivery record intact', async () => {
    const change = await task('Preserve later work');
    await commit(change);
    const accepted = await accept(await workflow.ready(change.id));
    await commit(change, 'later.txt', 'new work\n');
    const later = gitAt(change, 'rev-parse', 'HEAD');
    const retry = await accept(accepted);
    expect(retry.status).toBe('working');
    expect(retry.deliveries).toHaveLength(1);
    expect(gitAt(change, 'rev-parse', 'HEAD')).toBe(later);
    expect(gitAt(change, 'branch', '--show-current')).toBe(change.branch);
    expect(fx.git('rev-list', '--count', 'main..feature/order').trim()).toBe('1');
  });

  it('validates the destination, adopts existing slots, and guards legacy release APIs', async () => {
    await expect(workflow.configure('does-not-exist')).rejects.toMatchObject({ code: 'invalid_development_branch' });
    fx.git('worktree', 'add', '-b', 'existing-task', `${fx.root}-1`, 'feature/order');
    const change = await workflow.create({ title: 'Adopt', worktree: `${fx.root}-1` });
    expect(change.branch).toBe('existing-task');
    await workflow.configure('main');
    await workflow.configure('feature/order');
    await expect(workflow.create({ title: 'Outside', worktree: fx.root })).rejects.toMatchObject({ code: 'invalid_change_checkout' });
    expect((await workflow.get()).workflow!.changes.map((row) => row.id)).toEqual([change.id]);
    const app = createApp({ repo: await resolveRepo(fx.root), store });
    const response = await app.request('/api/worktrees/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: change.worktree }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'active_change' });
    const listing = await app.request('/api/workflow');
    expect(((await listing.json()) as WorkflowResponse).workflow!.changes[0]!.id).toBe(change.id);
  });

  it('stages the complete squash without committing, releasing the slot or rebasing siblings', async () => {
    const a = await task('Validate on development');
    const b = await task('Wait for acceptance');
    await commit(a);
    await commit(a, 'second.txt', 'second\n');
    await commit(b, 'sibling.txt');
    const sibling = await workflow.ready(b.id);
    const ready = await workflow.ready(a.id);
    await hook('pre-commit', 'echo "must not run during preparation" >&2\nexit 1');
    const prepared = await prepare(ready);
    expect(prepared.status).toBe('integrating');
    expect(prepared.integration?.commit).toBeUndefined();
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(ready.base);
    expect(fx.git('diff', '--cached', ready.submittedHead!, '--').trim()).toBe('');
    expect(fx.git('diff', '--cached', '--name-only').trim().split('\n')).toEqual(['second.txt', 'task.txt']);
    expect(gitAt(a, 'branch', '--show-current')).toBe(a.branch);
    expect(gitAt(b, 'rev-parse', 'HEAD')).toBe(sibling.submittedHead);
    expect((await workflow.get()).preparation).toMatchObject({ state: 'testing', canCommit: true, worktree: fx.root });
    expect((await prepare(ready)).integration).toEqual(prepared.integration);
  });

  it.each(['pre-commit', 'commit-msg'])('retains staged files and task ownership when %s rejects a commit', async (name) => {
    const change = await task('Respect hooks');
    await commit(change);
    const ready = await workflow.ready(change.id);
    await prepare(ready);
    await hook(name, 'echo "project validation failed" >&2\nexit 1');
    await expect(accept(ready)).rejects.toMatchObject({ code: 'commit_failed' });
    const pending = (await workflow.get()).workflow!.changes[0]!;
    expect(pending.status).toBe('integrating');
    expect(pending.integration?.error).toContain('project validation failed');
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(ready.base);
    expect(fx.git('diff', '--cached', '--name-only').trim()).toBe('task.txt');
    expect(gitAt(change, 'branch', '--show-current')).toBe(change.branch);
    await hook(name, 'exit 0');
    const accepted = await accept(ready);
    expect(accepted.status).toBe('working');
    expect(accepted.integration?.error).toBeUndefined();
    expect(fx.git('rev-list', '--count', 'main..HEAD').trim()).toBe('1');
  });

  it('runs configured hooks in the development checkout and preserves their file and message changes', async () => {
    const change = await task('Hooks use the development context', 'clone');
    await commit(change);
    const ready = await workflow.ready(change.id);
    await hook(
      'pre-commit',
      `test "$(git branch --show-current)" = feature/order || exit 1\ntest "$(git rev-parse --show-toplevel)" = ${shellCheckout(fx.root)} || exit 1\nprintf 'formatted\\n' > task.txt\ngit add -- task.txt`,
    );
    await hook('prepare-commit-msg', 'printf "\\nPrepared by project hook\\n" >> "$1"');
    await hook('commit-msg', 'printf "\\nValidated by project hook\\n" >> "$1"');
    const accepted = await accept(ready);
    expect(await readFile(path.join(fx.root, 'task.txt'), 'utf8')).toBe('formatted\n');
    expect(accepted.deliveries!.at(-1)!.message).toContain('Prepared by project hook');
    expect(accepted.deliveries!.at(-1)!.message).toContain('Validated by project hook');
    expect(fx.git('status', '--porcelain').trim()).toBe('');
    expect(accepted.cleanupError).toBeUndefined();
  });

  it('tests and commits in a linked development checkout without touching the main checkout', async () => {
    const change = await task('Linked development branch');
    await commit(change);
    const ready = await workflow.ready(change.id);
    fx.git('switch', 'main');
    await fx.write('local.txt', 'unrelated main checkout work');
    const development = `${fx.root}-9`;
    fx.git('worktree', 'add', development, 'feature/order');
    await hook(
      'pre-commit',
      `test "$(git rev-parse --show-toplevel)" = ${shellCheckout(development)} || exit 1\ntest "$(git branch --show-current)" = feature/order || exit 1`,
    );
    const accepted = await accept(ready);
    expect(accepted.deliveries).toHaveLength(1);
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(ready.base);
    expect(fx.git('-C', development, 'rev-parse', 'HEAD').trim()).toBe(accepted.deliveries!.at(-1)!.commit);
    expect(await readFile(path.join(fx.root, 'local.txt'), 'utf8')).toBe('unrelated main checkout work');
  });

  it('rejects stale staged content and unstaged test fixes until the reviewer validates the new snapshot', async () => {
    const change = await task('Check staged snapshot');
    await commit(change);
    await prepare(await workflow.ready(change.id));
    const pending = (await workflow.get()).preparation!;
    const request = { mode: 'commit' as const, developmentHead: pending.head!, indexFingerprint: pending.indexFingerprint!, message: change.title };
    await fx.write('task.txt', 'fixed in development\n');
    await expect(workflow.accept(change.id, request)).rejects.toMatchObject({ code: 'development_unstaged' });
    fx.git('add', 'task.txt');
    await expect(workflow.accept(change.id, request)).rejects.toMatchObject({ code: 'review_changed' });
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(pending.head);
    const accepted = await accept(change);
    expect(accepted.status).toBe('working');
    expect(await readFile(path.join(fx.root, 'task.txt'), 'utf8')).toBe('fixed in development\n');
  });

  it('records an explicitly reviewed manual commit and leaves siblings unchanged', async () => {
    const a = await task('Manual commit');
    const b = await task('Sibling');
    await commit(a);
    await commit(b, 'sibling.txt');
    const ready = await workflow.ready(a.id);
    await prepare(ready);
    await fx.write('task.txt', 'test fix\n');
    fx.git('add', 'task.txt');
    await hook('commit-msg', 'printf "\\nChecked manually\\n" >> "$1"');
    fx.git('commit', '-qm', 'Validated in my terminal');
    const head = fx.git('rev-parse', 'HEAD').trim();
    expect((await workflow.get()).preparation).toMatchObject({ state: 'committed', head, changed: true, canRecord: true });
    expect((await workflow.get()).workflow!.changes[0]!.status).toBe('integrating');
    expect((await workflow.ready(b.id)).base).toBe(ready.base);
    await expect(workflow.accept(a.id, { mode: 'record', commit: ready.base })).rejects.toMatchObject({ code: 'review_changed' });
    const accepted = await workflow.accept(a.id, { mode: 'record', commit: head });
    expect(accepted.status).toBe('working');
    expect(accepted.deliveries!.at(-1)!.message).toContain('Checked manually');
    expect((await workflow.get()).workflow!.changes.find((row) => row.id === b.id)?.base).toBe(b.base);
    expect(fx.git('rev-list', '--count', 'main..HEAD').trim()).toBe('1');
  });

  it('does not mistake a multi-commit or unrelated history for a single accepted change', async () => {
    const change = await task('Single commit');
    await commit(change);
    await prepare(await workflow.ready(change.id));
    fx.git('commit', '-qm', 'Manual task');
    fx.git('commit', '--allow-empty', '-qm', 'Unrelated later commit');
    const head = fx.git('rev-parse', 'HEAD').trim();
    expect((await workflow.get()).preparation?.state).toBe('blocked');
    await expect(workflow.accept(change.id, { mode: 'record', commit: head })).rejects.toMatchObject({ code: 'development_history_changed' });
    expect(gitAt(change, 'branch', '--show-current')).toBe(change.branch);
  });

  it('recovers interrupted staging only when the index still equals the reviewed tree', async () => {
    const change = await task('Recover staging');
    await commit(change);
    const ready = await workflow.ready(change.id);
    await prepare(ready);
    await store.update((state) => {
      delete state.workflow!.changes[0]!.integration!.prepared;
    });
    await fx.write('keep.txt', 'preserve test work');
    await expect(prepare(ready)).rejects.toMatchObject({ code: 'development_dirty' });
    expect(await readFile(path.join(fx.root, 'keep.txt'), 'utf8')).toBe('preserve test work');
    await rm(path.join(fx.root, 'keep.txt'));
    expect((await prepare(ready)).integration!.prepared).toBe(true);
    expect(fx.git('rev-parse', 'HEAD').trim()).toBe(ready.base);
    await accept(ready);
  });

  it('recovers a successful normal commit after a state write failure without rerunning hooks', async () => {
    const change = await task('Recover normal commit');
    await commit(change);
    await prepare(await workflow.ready(change.id));
    const pending = (await workflow.get()).preparation!;
    const request = { mode: 'commit' as const, developmentHead: pending.head!, indexFingerprint: pending.indexFingerprint!, message: change.title };
    const update = store.update.bind(store);
    const spy = vi.spyOn(store, 'update').mockImplementation(async (mutate) =>
      update((state) => {
        const result = mutate(state);
        if (state.workflow!.changes[0]!.worktree && (state.workflow!.changes[0] as DevelopmentChange).deliveries?.length)
          throw new Error('simulated state write failure');
        return result;
      }),
    );
    await expect(workflow.accept(change.id, request)).rejects.toThrow('simulated state write failure');
    spy.mockRestore();
    const head = fx.git('rev-parse', 'HEAD').trim();
    await hook('pre-commit', 'echo "must not run twice" >&2\nexit 1');
    const accepted = await workflow.accept(change.id, request);
    expect(accepted.status).toBe('working');
    expect(accepted.deliveries!.at(-1)!.commit).toBe(head);
    expect(fx.git('rev-list', '--count', 'main..HEAD').trim()).toBe('1');
  });

  it('does not release a task when a successful commit hook leaves uncommitted files behind', async () => {
    const change = await task('Preserve hook leftovers');
    await commit(change);
    await prepare(await workflow.ready(change.id));
    await hook('post-commit', 'printf "uncommitted hook edit\\n" >> task.txt');
    await expect(accept(change)).rejects.toMatchObject({ code: 'development_dirty' });
    expect((await workflow.get()).preparation).toMatchObject({ state: 'committed', canRecord: false });
    expect(gitAt(change, 'branch', '--show-current')).toBe(change.branch);
    expect(await readFile(path.join(fx.root, 'task.txt'), 'utf8')).toContain('uncommitted hook edit');
  });

  it('does not synchronize an unconfirmed manual commit during an older cleanup retry', async () => {
    const a = await task('Earlier accepted task');
    await commit(a, 'a.txt');
    const accepted = await accept(await workflow.ready(a.id));
    const b = await task('Manual validation');
    const c = await task('Still waiting');
    await commit(b, 'b.txt');
    await commit(c, 'c.txt');
    const readyC = await workflow.ready(c.id);
    await prepare(await workflow.ready(b.id));
    fx.git('commit', '-qm', 'Not yet reviewed');
    await workflow.accept(a.id, { mode: 'record', commit: accepted.deliveries!.at(-1)!.commit! });
    const after = (await workflow.get()).workflow!.changes.find((row) => row.id === c.id)!;
    expect(after.base).toBe(readyC.base);
    expect(gitAt(c, 'rev-parse', 'HEAD')).toBe(readyC.submittedHead);
  });
});
