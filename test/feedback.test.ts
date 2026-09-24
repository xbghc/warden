import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Comment, ExportResponse, ReanchorResponse, ReviewState } from '@warden/shared';
import { addReply, createApp, formatCommentsExport, NvimService, resolveRepo, shortId, StateStore, takeFeedback } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let app: Hono;
let store: StateStore;
let dataDir: string;

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}
const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const k = (key: string) => encodeURIComponent(key);
const take = (peek = false) => takeFeedback(store, { worktreeRoot: fx.root, mainRoot: fx.root, peek });
const find = async (id: string): Promise<Comment | undefined> =>
  Object.values((await json<ReviewState>(await app.request('/api/state'))).targets)
    .flatMap((t) => t.comments)
    .find((c) => c.id === id);

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-feedback-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-feedback-data-'));
  const repo = await resolveRepo(fx.root);
  store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  app = createApp({ repo, store, nvim: new NvimService([path.join(dataDir, 'no-sockets')]), watchIntervalMs: 50, replyCommand: 'warden' });
  await fx.write('src/a.ts', ['export function a() {', '  return 1;', '}', 'export const z = 9;', ''].join('\n'));
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('the loop between reviewer and agent', () => {
  let comment: Comment;

  it('hands the agent what it has not seen, once', async () => {
    comment = await json<Comment>(
      await send('POST', `/api/targets/${k('working')}/comments`, { filePath: 'src/a.ts', side: 'new', startLine: 4, endLine: 4, body: 'why z?' }),
    );
    // A comment on another worktree's code is that agent's business, not this one's.
    await store.update((s) => {
      s.targets['worktree:/elsewhere:local'] = { viewed: {}, comments: [{ ...comment, id: 'f0000000-other', targetKey: 'worktree:/elsewhere:working' }] };
    });

    expect((await take(true)).map((c) => c.id)).toEqual([comment.id]);
    expect((await find(comment.id))?.exportedAt).toBeUndefined();

    const taken = await take();
    expect(taken.map((c) => c.id)).toEqual([comment.id]);
    expect(taken[0]!.status).toBe('exported');
    expect(await take()).toEqual([]);
  });

  it('names each comment by an id `warden reply` takes, and says how to reply', async () => {
    const text = formatCommentsExport({ repoRoot: fx.root, comments: [comment], replyCommand: 'npx @xbghc/warden' });
    expect(text).toContain(`## src/a.ts:4 (new) [id: ${shortId(comment.id)}]`);
    expect(text.trimEnd().endsWith('`npx @xbghc/warden reply <id> "<what you changed, or why you did not>"` so the reviewer sees your answer beside it.')).toBe(
      true,
    );
    const copied = await json<ExportResponse>(await send('POST', '/api/comments/export', { commentIds: [comment.id] }));
    expect(copied.text).toContain('`warden reply <id>');
  });

  it('takes the agent’s answer by a prefix of the id, and leaves it with the reviewer', async () => {
    const replied = await addReply(store, shortId(comment.id), 'agent', 'renamed it to zeta');
    expect(replied.replies?.map((r) => [r.author, r.body])).toEqual([['agent', 'renamed it to zeta']]);
    expect(replied.exportedAt).toBeTruthy();
    expect(await take()).toEqual([]);
  });

  it('refuses an id that matches nothing, or more than one comment', async () => {
    await expect(addReply(store, 'zzzzzzzz', 'agent', 'x')).rejects.toMatchObject({ code: 'unknown_comment' });
    await expect(addReply(store, '', 'agent', 'x')).rejects.toMatchObject({ code: 'bad_comment_id' });
    await store.update((s) => {
      s.targets['worktree:/elsewhere:local']!.comments.push({ ...comment, id: 'f0000000-twin', targetKey: 'worktree:/elsewhere:working' });
    });
    await expect(addReply(store, 'f0000000', 'agent', 'x')).rejects.toMatchObject({ code: 'ambiguous_comment' });
    await expect(addReply(store, 'f0000000-twin', 'agent', '  ')).rejects.toMatchObject({ code: 'empty_reply' });
  });

  it('sends a reviewer follow-up back out with the thread so far', async () => {
    const res = await send('POST', `/api/targets/${k('staged')}/comments/${comment.id}/replies`, { body: 'and the callers?' });
    expect(res.status).toBe(201);
    const followed = await json<Comment>(res);
    expect(followed.exportedAt).toBeUndefined();
    expect(followed.status).toBe('active');

    const again = await take();
    expect(again.map((c) => c.id)).toEqual([comment.id]);
    const text = formatCommentsExport({ repoRoot: fx.root, comments: again });
    expect(text).toContain('> why z?\nAgent replied:\n> renamed it to zeta\nReviewer replied:\n> and the callers?');
  });

  it('refuses a reply through a target whose pool the comment is not in', async () => {
    const res = await send('POST', `/api/targets/${k('commit:HEAD')}/comments/${comment.id}/replies`, { body: 'x' });
    expect(res.status).toBe(404);
  });

  it('keeps a comment with a thread when the commit that answers it lands', async () => {
    const plain = await json<Comment>(
      await send('POST', `/api/targets/${k('working')}/comments`, { filePath: 'src/a.ts', side: 'new', startLine: 4, endLine: 4, body: 'no thread' }),
    );
    await addReply(store, comment.id, 'agent', 'callers updated');
    await json<ReanchorResponse>(await send('POST', `/api/targets/${k('working')}/comments/reanchor`, {}));
    fx.git('commit', '-q', '-a', '-m', 'answer the review');
    const after = await json<ReanchorResponse>(await send('POST', `/api/targets/${k('working')}/comments/reanchor`, {}));
    expect(after.comments.map((c) => [c.id, c.status])).toEqual([[comment.id, 'orphaned']]);
    expect(await find(plain.id)).toBeUndefined();
  });
});

describe('GET /api/events', () => {
  it('says so when the state file is written behind the page’s back', async () => {
    const ac = new AbortController();
    const res = await app.request('/api/events', { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Let the stream take its first reading of the file before anything changes it.
    await new Promise((r) => setTimeout(r, 100));
    await store.update(() => undefined);
    let seen = '';
    const deadline = Date.now() + 3000;
    while (!seen.includes('event: state') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    ac.abort();
    await reader.cancel().catch(() => undefined);
    expect(seen).toContain('event: state');
  });
});
