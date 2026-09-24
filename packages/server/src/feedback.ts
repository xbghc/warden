import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Comment, CommentReply, ReplyAuthor, ReviewState } from '@warden/shared';
import { awaitsAgent, commentWorktree } from '@warden/shared';
import { badRequest, notFound } from './errors.js';
import type { StateStore } from './state.js';

// What an agent reaches warden through: the CLI, run in its own worktree, reading and writing the
// state file under the store's lock. No server has to be running, and none has to be found — there
// can be several on random ports — which is what would make an HTTP route the harder road.

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * The worktree a comment's code lives in. A key without a worktree names the one the server was
 * started in, which is the main worktree unless warden was launched inside a linked one — then
 * this guess is wrong, as the key itself is ambiguous in the state both servers share.
 */
function worktreeOf(c: Comment, mainRoot: string): string {
  return commentWorktree(c) ?? mainRoot;
}

/** Every comment on code in `worktreeRoot`, across its pools (local views, base, commits, checkpoints). */
async function commentsIn(state: ReviewState, worktreeRoot: string, mainRoot: string): Promise<Comment[]> {
  const want = await real(worktreeRoot);
  const resolved = new Map<string, Promise<string>>();
  const out: Comment[] = [];
  for (const t of Object.values(state.targets)) {
    for (const c of t.comments) {
      const wt = worktreeOf(c, mainRoot);
      let p = resolved.get(wt);
      if (!p) {
        p = real(wt);
        resolved.set(wt, p);
      }
      if ((await p) === want) out.push(c);
    }
  }
  return out;
}

export interface TakeFeedbackOptions {
  worktreeRoot: string;
  mainRoot: string;
  /** Look without marking anything as handed over. */
  peek?: boolean;
}

/**
 * The comments on `worktreeRoot` the agent has not seen yet — new ones and reviewer follow-ups —
 * marked as exported unless `peek`, exactly as copying them to the clipboard would.
 */
export async function takeFeedback(store: StateStore, opts: TakeFeedbackOptions): Promise<Comment[]> {
  if (opts.peek) return (await commentsIn(await store.load(), opts.worktreeRoot, opts.mainRoot)).filter(awaitsAgent);
  return store.update(async (s) => {
    const ids = new Set((await commentsIn(s, opts.worktreeRoot, opts.mainRoot)).filter(awaitsAgent).map((c) => c.id));
    const now = new Date().toISOString();
    const taken: Comment[] = [];
    for (const t of Object.values(s.targets)) {
      t.comments = t.comments.map((c) => {
        if (!ids.has(c.id)) return c;
        const next: Comment = { ...c, exportedAt: now, updatedAt: now, status: c.status === 'active' ? 'exported' : c.status };
        taken.push(next);
        return next;
      });
    }
    return taken;
  });
}

/** The comment whose id is `ref` or starts with it; an export names comments by their first 8 characters. */
function locate(state: ReviewState, ref: string): { list: Comment[]; index: number } {
  const needle = ref.trim().toLowerCase();
  if (!needle) throw badRequest('a comment id is required', 'bad_comment_id');
  const hits: { list: Comment[]; index: number }[] = [];
  for (const t of Object.values(state.targets)) {
    t.comments.forEach((c, index) => {
      if (c.id === needle) hits.unshift({ list: t.comments, index });
      else if (c.id.startsWith(needle)) hits.push({ list: t.comments, index });
    });
  }
  const exact = hits[0] && hits[0].list[hits[0].index]!.id === needle;
  if (hits.length === 0) throw notFound(`no comment with id ${ref}; it may have been resolved or deleted`, 'unknown_comment');
  if (!exact && hits.length > 1) throw badRequest(`id ${ref} matches ${hits.length} comments; give more of it`, 'ambiguous_comment');
  return hits[0]!;
}

/**
 * Append to a comment's thread. A reviewer's reply is a question the agent has not seen, so it
 * clears `exportedAt` and the comment waits to go out again; an agent's reply leaves that alone.
 */
export async function addReply(store: StateStore, ref: string, author: ReplyAuthor, body: string): Promise<Comment> {
  if (!body.trim()) throw badRequest('reply must not be empty', 'empty_reply');
  return store.update((s) => {
    const { list, index } = locate(s, ref);
    const now = new Date().toISOString();
    const reply: CommentReply = { id: randomUUID(), author, body: body.trim(), at: now };
    const prev = list[index]!;
    const next: Comment = { ...prev, replies: [...(prev.replies ?? []), reply], updatedAt: now };
    if (author === 'reviewer') {
      delete next.exportedAt;
      if (next.status === 'exported') next.status = 'active';
    }
    list[index] = next;
    return next;
  });
}
