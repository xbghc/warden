import type { Comment } from './types.js';

/** Not yet handed to the agent: never exported, or the reviewer has replied since. */
export function awaitsAgent(c: Comment): boolean {
  return !c.exportedAt;
}

/** The agent answered last, and the reviewer has yet to accept the answer or reply to it. */
export function awaitsReviewer(c: Comment): boolean {
  return c.replies?.at(-1)?.author === 'agent';
}
