import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Todo, TodosResponse } from '@warden/shared';
import { createApp, resolveRepo, StateStore, NvimService } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}
const get = (p: string) => app.request(p);
const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-todos-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-todos-data-'));
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  app = createApp({ repo, store, nvim: new NvimService([path.join(dataDir, 'no-sockets')]) });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('todos', () => {
  let first: Todo;
  let second: Todo;

  it('defaults the branch to the one currently checked out', async () => {
    first = await json<Todo>(await send('POST', '/api/todos', { title: '  补充 OrderList 的空状态  ', body: '描述正文（Markdown）…' }));
    expect(first).toMatchObject({ branch: 'main', status: 'open', title: '补充 OrderList 的空状态' });
    expect(first.createdAt).toBeTruthy();

    second = await json<Todo>(await send('POST', '/api/todos', { title: 'useOrder 的依赖数组缺少 id' }));
    expect(second.body).toBe('');
    expect((await send('POST', '/api/todos', { title: '   ' })).status).toBe(400);
  });

  it('filters by branch and lists everything without one', async () => {
    fx.git('checkout', '-q', '-b', 'feature/x');
    const onFeature = await json<Todo>(await send('POST', '/api/todos', { title: '只属于 feature/x' }));
    expect(onFeature.branch).toBe('feature/x');

    const scoped = await json<TodosResponse>(await get('/api/todos?branch=main'));
    expect(scoped.branch).toBe('main');
    // Newest on top, as in a task list.
    expect(scoped.todos.map((t) => t.id)).toEqual([second.id, first.id]);

    const all = await json<TodosResponse>(await get('/api/todos'));
    expect(all.todos).toHaveLength(3);
    expect(all.branch).toBeUndefined();

    // An explicit branch wins over the checked-out one.
    const explicit = await json<Todo>(await send('POST', '/api/todos', { title: 'pinned', branch: 'main' }));
    expect(explicit.branch).toBe('main');
    await send('DELETE', `/api/todos/${explicit.id}`);
    await send('DELETE', `/api/todos/${onFeature.id}`);
    fx.git('checkout', '-q', 'main');
  });

  it('keeps the order the reviewer arranged', async () => {
    const ids = async () => (await json<TodosResponse>(await get('/api/todos'))).todos.map((t) => t.id);
    // Typed after `second` (Enter at the end of its row): lands right under it.
    const third = await json<Todo>(await send('POST', '/api/todos', { title: 'third', after: second.id }));
    expect(await ids()).toEqual([second.id, third.id, first.id]);
    // An `after` that is gone puts it on top rather than losing it.
    const fourth = await json<Todo>(await send('POST', '/api/todos', { title: 'fourth', after: 'nope' }));
    expect(await ids()).toEqual([fourth.id, second.id, third.id, first.id]);
    // Drag: before another, or to the end.
    let moved = await json<TodosResponse>(await send('POST', `/api/todos/${first.id}/move`, { before: second.id }));
    expect(moved.todos.map((t) => t.id)).toEqual([fourth.id, first.id, second.id, third.id]);
    moved = await json<TodosResponse>(await send('POST', `/api/todos/${fourth.id}/move`, { before: null }));
    expect(moved.todos.map((t) => t.id)).toEqual([first.id, second.id, third.id, fourth.id]);
    expect((await send('POST', `/api/todos/${first.id}/move`, { before: 'nope' })).status).toBe(404);
    expect((await send('POST', `/api/todos/nope/move`, { before: null })).status).toBe(404);
    expect((await send('POST', `/api/todos/${first.id}/move`, { before: 5 })).status).toBe(400);
    // A restored (undone) deletion comes back with its status.
    const done = await json<Todo>(await send('POST', '/api/todos', { title: 'was done', status: 'done' }));
    expect(done.status).toBe('done');
    for (const t of [third, fourth, done]) await send('DELETE', `/api/todos/${t.id}`);
    expect(await ids()).toEqual([first.id, second.id]);
  });

  it('updates title, body and status', async () => {
    const patched = await json<Todo>(await send('PATCH', `/api/todos/${second.id}`, { status: 'done', body: 'fixed in a follow-up' }));
    expect(patched).toMatchObject({ status: 'done', body: 'fixed in a follow-up', title: 'useOrder 的依赖数组缺少 id' });
    expect(patched.updatedAt >= patched.createdAt).toBe(true);
    expect((await send('PATCH', '/api/todos/nope', { status: 'done' })).status).toBe(404);
  });

  it('deletes', async () => {
    expect((await send('DELETE', `/api/todos/${first.id}`)).status).toBe(200);
    expect((await send('DELETE', `/api/todos/${first.id}`)).status).toBe(404);
    const left = await json<TodosResponse>(await get('/api/todos'));
    expect(left.todos.map((t) => t.id)).toEqual([second.id]);
  });
});
