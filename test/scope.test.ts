import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Comment, FilesResponse, Issue, ReanchorResponse, ReviewState } from '@warden/shared';
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
const k = (key: string) => encodeURIComponent(key);

const FILE = 'src/scope.ts';
/** 24 numbered lines, so the two edits below land in separate -U3 hunks. */
const base = Array.from({ length: 24 }, (_, i) => `export const L${i + 1} = ${i + 1};`).join('\n') + '\n';
const withAlpha = base.replace('export const L3 = 3;', 'export const L3 = 300; // alpha');
const withBoth = withAlpha.replace('export const L20 = 20;', 'export const L20 = 2000; // beta');

const comment = async (key: string, startLine: number, body: string) =>
  json<Comment>(await send('POST', `/api/targets/${k(key)}/comments`, { filePath: FILE, side: 'new', startLine, endLine: startLine, body }));
const reanchor = async (key = 'working') => json<ReanchorResponse>(await send('POST', `/api/targets/${k(key)}/comments/reanchor`, {}));
const byId = (list: Comment[], id: string) => list.find((c) => c.id === id);

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-scope-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-scope-data-'));
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  app = createApp({ repo, store, nvim: new NvimService([path.join(dataDir, 'no-sockets')]) });
  await fx.write(FILE, base);
  fx.git('add', '.');
  fx.git('commit', '-q', '-m', 'add scope fixture');
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('comments follow the code across views', () => {
  let alpha: Comment;
  let beta: Comment;
  let issue: Issue;

  it('stores local comments in a shared scope, not per view', async () => {
    await fx.write(FILE, withBoth);
    alpha = await comment('working', 3, 'why 300?');
    beta = await comment('working', 20, 'why 2000?');
    expect(alpha.targetKey).toBe('working');

    const state = await json<ReviewState>(await get('/api/state'));
    expect(state.targets.local!.comments.map((c) => c.id)).toEqual([alpha.id, beta.id]);
    expect(state.targets.working).toBeUndefined();

    // Every local view serves the whole scope.
    for (const view of ['working', 'staged', 'all']) {
      const files = await json<FilesResponse>(await get(`/api/targets/${k(view)}/files`));
      expect(files.comments.map((c) => c.id).sort()).toEqual([alpha.id, beta.id].sort());
    }
  });

  it('moves a comment to staged when its hunk is staged', async () => {
    fx.git('add', FILE);
    const re = await reanchor();
    const moved = byId(re.comments, alpha.id)!;
    expect(moved.targetKey).toBe('staged');
    expect(moved.status).toBe('active');
    expect(moved.startLine).toBe(3);
    expect(moved.codeSnippet).toEqual(['export const L3 = 300; // alpha']);
  });

  it('splits comments across staged and working when only one hunk is staged', async () => {
    // Stage the alpha hunk alone: index gets `withAlpha`, the worktree keeps both edits.
    await fx.write(FILE, withAlpha);
    fx.git('add', FILE);
    await fx.write(FILE, withBoth);

    const re = await reanchor();
    expect(byId(re.comments, alpha.id)).toMatchObject({ targetKey: 'staged', status: 'active', startLine: 3 });
    expect(byId(re.comments, beta.id)).toMatchObject({ targetKey: 'working', status: 'active', startLine: 20 });
  });

  it('deletes committed comments and unlinks them from issues, keeping unstaged ones', async () => {
    issue = await json<Issue>(await send('POST', '/api/issues', { title: 'Alpha', commentIds: [alpha.id, beta.id] }));
    expect(issue.commentIds).toEqual([alpha.id, beta.id]);

    // Commits the index only, so the beta edit stays unstaged in the worktree.
    fx.git('commit', '-q', '-m', 'ship alpha');

    const re = await reanchor();
    expect(byId(re.comments, alpha.id)).toBeUndefined();
    expect(byId(re.comments, beta.id)).toMatchObject({ targetKey: 'working', status: 'active' });

    const after = await json<{ issues: Issue[] }>(await get('/api/issues'));
    expect(after.issues[0]!.commentIds).toEqual([beta.id]);
  });

  it('orphans instead of deleting when HEAD did not move', async () => {
    await fx.write(FILE, withAlpha.replace('export const L20 = 20;', 'export const L20 = 999; // rewritten'));
    const re = await reanchor();
    expect(byId(re.comments, beta.id)).toMatchObject({ status: 'orphaned', targetKey: 'working' });
    expect(byId(re.comments, beta.id)!.codeSnippet).toEqual(['export const L20 = 2000; // beta']);
  });
});

describe('a base target survives the commits made while the branch is under review', () => {
  const FILE2 = 'src/base.ts';
  const key = 'base:main';
  let alpha: Comment;
  let beta: Comment;

  it('lists the branch since its fork and files comments under its own key', async () => {
    fx.git('checkout', '-q', '-b', 'topic');
    await fx.write(FILE2, base);
    fx.git('add', FILE2);
    fx.git('commit', '-q', '-m', 'topic: add base fixture', '--', FILE2);

    const files = await json<FilesResponse>(await get(`/api/targets/${k(key)}/files`));
    expect(files.files.find((f) => f.path === FILE2)).toMatchObject({ status: 'added' });
    alpha = await json<Comment>(await send('POST', `/api/targets/${k(key)}/comments`, { filePath: FILE2, side: 'new', startLine: 3, endLine: 3, body: 'alpha' }));
    beta = await json<Comment>(await send('POST', `/api/targets/${k(key)}/comments`, { filePath: FILE2, side: 'new', startLine: 20, endLine: 20, body: 'beta' }));
    expect(alpha.targetKey).toBe(key);

    const state = await json<ReviewState>(await get('/api/state'));
    expect(state.targets[key]?.comments.map((c) => c.id)).toEqual([alpha.id, beta.id]);
    expect(state.targets.local?.comments.map((c) => c.id) ?? []).not.toContain(alpha.id);
  });

  it('orphans a comment whose line changed and keeps it once that change is committed', async () => {
    await fx.write(FILE2, withAlpha);
    let re = await reanchor(key);
    expect(byId(re.comments, alpha.id)).toMatchObject({ status: 'orphaned', targetKey: key });
    expect(byId(re.comments, beta.id)).toMatchObject({ status: 'active', targetKey: key, startLine: 20 });

    // In a local view a moved HEAD deletes the orphans; here the review goes on, so they stay.
    fx.git('commit', '-q', '-a', '-m', 'topic: alpha');
    re = await reanchor(key);
    expect(byId(re.comments, alpha.id)).toMatchObject({ status: 'orphaned', targetKey: key });
    expect(byId(re.comments, alpha.id)!.codeSnippet).toEqual(['export const L3 = 3;']);
    expect(byId(re.comments, beta.id)).toMatchObject({ status: 'active', startLine: 20 });
  });
});
