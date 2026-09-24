import type { Comment } from './types.js';
import { tryParseTargetKey } from './target.js';

/** The worktree whose code a comment is on, as its target key names it; undefined is the server's own. */
export function commentWorktree(c: Comment): string | undefined {
  return tryParseTargetKey(c.targetKey)?.worktree;
}

/** Not yet handed to the agent: never exported, or the reviewer has replied since. */
export function awaitsAgent(c: Comment): boolean {
  return !c.exportedAt;
}

/** The agent answered last, and the reviewer has yet to accept the answer or reply to it. */
export function awaitsReviewer(c: Comment): boolean {
  return c.replies?.at(-1)?.author === 'agent';
}
