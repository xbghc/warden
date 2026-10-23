import { formatTargetKey } from './target.js';
import type { DevelopmentPreparation, WorkflowResponse, WorktreeDetail } from './types.js';

/** A comparison version, not a record of which files the user has read. */
export interface TaskReview {
  changeId: string;
  targetKey: string;
  developmentHead?: string;
  sourceHead?: string;
  sourceBase: string;
  preparation?: DevelopmentPreparation;
}

export function taskReview(data: WorkflowResponse, changeId: string, checkouts: WorktreeDetail[]): TaskReview | undefined {
  const task = data.workflow?.changes.find((row) => row.id === changeId);
  if (!task?.worktree) return undefined;
  const sourceBase = task.sourceBase ?? task.base;
  const preparation = data.preparation?.changeId === changeId ? data.preparation : undefined;
  if (preparation && (task.integration?.prepared || preparation.state === 'committed')) {
    return {
      changeId,
      sourceBase,
      developmentHead: data.developmentHead,
      targetKey: formatTargetKey(
        preparation.state === 'committed' && preparation.head
          ? { kind: 'commit', sha: preparation.head, worktree: preparation.worktree }
          : { kind: 'staged', worktree: preparation.worktree },
      ),
      preparation: { ...preparation },
    };
  }
  const checkout = checkouts.find((row) => row.path === task.worktree);
  const sourceHead =
    checkout && checkout.dirty === 0 && !checkout.busy && !checkout.foreign && !checkout.prunable && checkout.branch === task.branch
      ? checkout.head
      : undefined;
  return {
    changeId,
    sourceBase,
    developmentHead: data.developmentHead,
    sourceHead,
    targetKey: formatTargetKey(
      sourceHead ? { kind: 'range', base: sourceBase, head: sourceHead, worktree: task.worktree } : { kind: 'base', ref: sourceBase, worktree: task.worktree },
    ),
  };
}

export function sameReview(a: TaskReview | undefined, b: TaskReview | undefined): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}
