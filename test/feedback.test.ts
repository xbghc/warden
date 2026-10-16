import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, ExportResponse, ReanchorResponse, ReviewState, WorktreesResponse } from '@warden/shared';
import { addReply, createApp, formatCommentsExport, resolveRepo, shortId, StateStore, takeFeedback } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';
import * as checkpoints from '../packages/server/src/checkpoints.js';

let fx: FixtureRepo;
let app: ReturnType<typeof createApp>;
let appOptions: Parameters<typeof createApp>[0];
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

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function restartApp() {
  await app.close();
  app = createApp(appOptions);
}

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-feedback-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-feedback-data-'));
  const repo = await resolveRepo(fx.root);
  store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  appOptions = { repo, store, watchIntervalMs: 50, replyCommand: 'warden' };
  await fx.write('src/a.ts', ['export function a() {', '  return 1;', '}', 'export const z = 9;', ''].join('\n'));
});

beforeEach(() => {
  app = createApp(appOptions);
});

afterEach(async () => {
  try {
    await app.close();
  } finally {
    vi.restoreAllMocks();
  }
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

  it('sends a comment out again once its body is edited after it went', async () => {
    const c = await json<Comment>(
      await send('POST', `/api/targets/${k('working')}/comments`, { filePath: 'src/a.ts', side: 'new', startLine: 4, endLine: 4, body: 'first take' }),
    );
    expect((await take()).map((x) => x.id)).toContain(c.id);
    const same = await json<Comment>(await send('PATCH', `/api/targets/${k('working')}/comments/${c.id}`, { body: 'first take' }));
    expect(same.exportedAt).toBeTruthy();
    const edited = await json<Comment>(await send('PATCH', `/api/targets/${k('working')}/comments/${c.id}`, { body: 'second take' }));
    expect(edited.exportedAt).toBeUndefined();
    expect(edited.status).toBe('active');
    expect((await take()).map((x) => [x.id, x.body])).toEqual([[c.id, 'second take']]);
    await send('DELETE', `/api/targets/${k('working')}/comments/${c.id}`);
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
    const readUntil = async (marker: string) => {
      let seen = '';
      await bounded(
        (async () => {
          while (!seen.includes(marker)) {
            const { value, done } = await reader.read();
            if (done) throw new Error(`Event stream ended before ${marker}`);
            seen += decoder.decode(value, { stream: true });
          }
        })(),
        `Event stream did not emit ${marker}`,
      );
    };
    try {
      // The connected marker is emitted only after the state baseline is captured.
      await readUntil(': connected');
      await store.update(() => undefined);
      await readUntil('event: state');
    } finally {
      ac.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });
});

describe('a hand-off notes the working tree', () => {
  const handoffs = async () => (await store.load()).checkpoints.filter((c) => c.handoff);

  it('marks nothing and notes nothing for a preview, which is how the page reads the text before copying it', async () => {
    await fx.write('src/b.ts', 'export const b = 4;\n');
    const c = await json<Comment>(
      await send('POST', `/api/targets/${k('working')}/comments`, { filePath: 'src/b.ts', side: 'new', startLine: 1, endLine: 1, body: 'why 4?' }),
    );
    const before = (await handoffs()).length;
    const preview = await json<ExportResponse>(await send('POST', '/api/comments/export', { commentIds: [c.id], preview: true }));
    expect(preview.text).toContain('why 4?');
    await restartApp();
    expect((await find(c.id))?.exportedAt).toBeUndefined();
    expect(await handoffs()).toHaveLength(before);
    await json<ExportResponse>(await send('POST', '/api/comments/export', { commentIds: [c.id] }));
    expect((await find(c.id))?.exportedAt).toBeTruthy();
    // Closing drains the checkpoint before a restarted app observes the stored state.
    await restartApp();
    expect(await handoffs()).toHaveLength(before + 1);
    await send('DELETE', `/api/targets/${k('working')}/comments/${c.id}`);
  });

  it('takes a checkpoint once comments are copied, after answering the copy', async () => {
    await fx.write('src/b.ts', 'export const b = 3;\n');
    const c = await json<Comment>(
      await send('POST', `/api/targets/${k('working')}/comments`, { filePath: 'src/b.ts', side: 'new', startLine: 1, endLine: 1, body: 'why 3?' }),
    );
    const before = (await handoffs()).length;
    await json<ExportResponse>(await send('POST', '/api/comments/export', { commentIds: [c.id] }));
    await restartApp();
    const taken = await handoffs();
    expect(taken).toHaveLength(before + 1);
    expect(taken.at(-1)!.worktree).toBeUndefined();

    // Nothing handed over, nothing noted; and the same tree is not noted twice.
    await json<ExportResponse>(await send('POST', '/api/comments/export', { commentIds: ['missing'] }));
    await json<ExportResponse>(await send('POST', '/api/comments/export', { commentIds: [c.id] }));
    await restartApp();
    expect(await handoffs()).toHaveLength(before + 1);
  });

  it('closes only after an in-flight export schedules and finishes its checkpoint', async () => {
    await fx.write('src/b.ts', 'export const b = 12;\n');
    const comment = await json<Comment>(
      await send('POST', `/api/targets/${k('working')}/comments`, { filePath: 'src/b.ts', side: 'new', startLine: 1, endLine: 1, body: 'close safely' }),
    );
    const before = (await handoffs()).length;
    const requestStarted = signal();
    const finishRequest = signal();
    const checkpointStarted = signal();
    const finishCheckpoint = signal();
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementationOnce(async (mutate) => {
      requestStarted.resolve();
      await finishRequest.promise;
      return update(mutate);
    });
    const takeCheckpoint = checkpoints.takeCheckpoint;
    let checkpointFinished = false;
    let pendingCheckpoint: ReturnType<typeof takeCheckpoint> | undefined;
    vi.spyOn(checkpoints, 'takeCheckpoint').mockImplementation((...args) => {
      pendingCheckpoint = (async () => {
        checkpointStarted.resolve();
        await finishCheckpoint.promise;
        const result = await takeCheckpoint(...args);
        checkpointFinished = true;
        return result;
      })();
      return pendingCheckpoint;
    });
    const exporting = Promise.resolve(send('POST', '/api/comments/export', { commentIds: [comment.id] }));
    let closing: Promise<boolean> | undefined;
    try {
      await bounded(requestStarted.promise, 'Export did not reach its state write');
      closing = app.close().then(() => checkpointFinished);
      expect((await app.request('/api/state')).status).toBe(503);
      finishRequest.resolve();
      expect((await bounded(exporting, 'Export did not finish')).status).toBe(200);
      await bounded(checkpointStarted.promise, 'Export did not schedule its checkpoint');
      finishCheckpoint.resolve();
      expect(await bounded(closing, 'Close did not drain its checkpoint')).toBe(true);
      expect(await handoffs()).toHaveLength(before + 1);
    } finally {
      finishRequest.resolve();
      finishCheckpoint.resolve();
      await Promise.allSettled([exporting, closing, pendingCheckpoint]);
    }
  });
});

describe('GET /api/worktrees', () => {
  it('counts, per worktree, what waits on the agent and what waits on the reviewer', async () => {
    const res = await json<WorktreesResponse>(await app.request('/api/worktrees'));
    const main = res.worktrees.find((w) => w.isMain)!;
    const state = await store.load();
    const mine = Object.values(state.targets)
      .flatMap((t) => t.comments)
      .filter((c) => !c.targetKey.startsWith('worktree:'));
    const toAgent = mine.filter((c) => !c.exportedAt).length;
    const toReviewer = mine.filter((c) => c.replies?.at(-1)?.author === 'agent').length;
    expect(toAgent + toReviewer).toBeGreaterThan(0);
    expect(main.review).toMatchObject({ toAgent, toReviewer });
  });
});

describe('GET /api/worktrees leads each count to a pool', () => {
  it('names the target the latest comment of each kind sits in', async () => {
    const at = await json<Comment>(
      await send('POST', `/api/targets/${k('commit:HEAD')}/comments`, { filePath: 'src/a.ts', side: 'new', startLine: 4, endLine: 4, body: 'on the commit' }),
    );
    const res = await json<WorktreesResponse>(await app.request('/api/worktrees'));
    expect(res.worktrees.find((w) => w.isMain)!.review?.toAgentTarget).toBe(at.targetKey);
  });
});
