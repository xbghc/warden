import { describe, expect, it } from 'vitest';
import { taskReview, sameReview } from './review.js';
import type { WorkflowResponse, WorktreeDetail } from './types.js';

const data: WorkflowResponse = {
  developmentHead: 'primary',
  workflow: {
    developmentBranch: 'main',
    changes: [{ id: 'task', title: 'Task', status: 'working', developmentBranch: 'main', branch: 'task', worktree: '/repo-1', base: 'base', createdAt: '' }],
  },
};
const checkout: WorktreeDetail = {
  path: '/repo-1',
  branch: 'task',
  head: 'source',
  dirty: 0,
  isMain: false,
  detached: false,
  bare: false,
  free: false,
  prunable: false,
};

describe('task review version', () => {
  it('pins clean comparisons and detects source, baseline and primary changes', () => {
    const review = taskReview(data, 'task', [checkout])!;
    expect(review.targetKey).toBe('worktree:/repo-1:range:base..source');
    expect(sameReview(review, taskReview(data, 'task', [checkout]))).toBe(true);
    expect(sameReview(review, taskReview(data, 'task', [{ ...checkout, head: 'new' }]))).toBe(false);
    expect(sameReview(review, taskReview({ ...data, developmentHead: 'new-primary' }, 'task', [checkout]))).toBe(false);
    const updated = structuredClone(data);
    Object.assign(updated.workflow!.changes[0]!, { sourceBase: 'delivered' });
    expect(sameReview(review, taskReview(updated, 'task', [checkout]))).toBe(false);
  });

  it('keeps live uncommitted content visible without assigning a deliverable revision', () => {
    const review = taskReview(data, 'task', [{ ...checkout, dirty: 1 }])!;
    expect(review.targetKey).toBe('worktree:/repo-1:base:base');
    expect(review.sourceHead).toBeUndefined();
  });

  it('binds recovery to the reviewed staged content or manual commit', () => {
    const pending = structuredClone(data);
    Object.assign(pending.workflow!.changes[0]!, { status: 'integrating', integration: { source: 'source', parent: 'primary', prepared: true } });
    pending.preparation = { changeId: 'task', state: 'testing', head: 'primary', indexFingerprint: 'one', canCommit: true, worktree: '/repo' };
    const review = taskReview(pending, 'task', [checkout])!;
    expect(review.targetKey).toBe('worktree:/repo:staged');
    pending.preparation.indexFingerprint = 'two';
    expect(sameReview(review, taskReview(pending, 'task', [checkout]))).toBe(false);
    pending.preparation = { changeId: 'task', state: 'committed', head: 'manual', canRecord: true, worktree: '/repo' };
    pending.workflow!.changes[0]!.integration!.prepared = false;
    expect(taskReview(pending, 'task', [checkout])!.targetKey).toBe('worktree:/repo:commit:manual');
    expect(sameReview(review, taskReview(pending, 'task', [checkout]))).toBe(false);
  });
});
