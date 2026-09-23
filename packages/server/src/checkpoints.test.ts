import { describe, expect, it } from 'vitest';
import type { Comment } from '@warden/shared';
import { defaultState, ensureTarget, forgetWorktreeTargets } from './state.js';
import { MAX_CHECKPOINTS, addCheckpoint, checkpointsOf, forgetCheckpoint } from './checkpoints.js';

const comment = (id: string, targetKey: string) => ({ id, targetKey }) as Comment;

describe('checkpoint bookkeeping', () => {
  it('numbers each worktree on its own, one above the highest kept', () => {
    const s = defaultState('/repo');
    expect(addCheckpoint(s, undefined, 't1', 'h').id).toBe(1);
    expect(addCheckpoint(s, '/wt', 't2', 'h').id).toBe(1);
    const second = addCheckpoint(s, undefined, 't3', 'h');
    expect(second.id).toBe(2);
    forgetCheckpoint(s, second);
    expect(addCheckpoint(s, undefined, 't4', 'h').id).toBe(2);
  });

  it('drops the oldest past the limit, with the comments on it and their issue links', () => {
    const s = defaultState('/repo');
    for (let i = 1; i <= MAX_CHECKPOINTS; i++) addCheckpoint(s, undefined, `t${i}`, 'h');
    ensureTarget(s, 'checkpoint:1').comments.push(comment('c1', 'checkpoint:1'));
    ensureTarget(s, 'checkpoint:2').comments.push(comment('c2', 'checkpoint:2'));
    s.issues.push({ id: 'i', title: '', body: '', status: 'open', commentIds: ['c1', 'c2'], createdAt: '', updatedAt: '' });
    addCheckpoint(s, '/wt', 'other', 'h');

    addCheckpoint(s, undefined, 'newest', 'h');
    const kept = checkpointsOf(s, undefined);
    expect(kept).toHaveLength(MAX_CHECKPOINTS);
    expect(kept[0]!.id).toBe(2);
    expect(kept.at(-1)!.id).toBe(MAX_CHECKPOINTS + 1);
    expect(s.targets['checkpoint:1']).toBeUndefined();
    expect(s.issues[0]!.commentIds).toEqual(['c2']);
    expect(checkpointsOf(s, '/wt')).toHaveLength(1);
  });

  it('goes with the worktree when a slot is checked out again', () => {
    const s = defaultState('/repo');
    addCheckpoint(s, '/slot-1', 't', 'h');
    addCheckpoint(s, undefined, 't', 'h');
    ensureTarget(s, 'worktree:/slot-1:checkpoint:1');
    forgetWorktreeTargets(s, '/slot-1');
    expect(s.checkpoints.map((c) => c.worktree)).toEqual([undefined]);
    expect(s.targets['worktree:/slot-1:checkpoint:1']).toBeUndefined();
  });
});
