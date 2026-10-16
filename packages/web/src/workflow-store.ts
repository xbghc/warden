import { create } from 'zustand';
import type { DevelopmentChange, WorkflowTask, WorkflowResponse, WorktreesResponse } from '@warden/shared';
import { formatTargetKey } from '@warden/shared';
import { api } from './api';
import { useStore } from './store';
import { copyText } from './lib/clipboard';
import { useWorkbench } from './workbench-store';

interface WorkflowStore {
  data: WorkflowResponse | null;
  checkouts: WorktreesResponse | null;
  error: string | null;
  actionError: string | null;
  busy: boolean;
  focusedId: string | null;
  focusSeq: number;
  refresh: () => Promise<void>;
}

let refreshVersion = 0;
export const useWorkflow = create<WorkflowStore>((set) => ({
  data: null,
  checkouts: null,
  error: null,
  actionError: null,
  busy: false,
  focusedId: null,
  focusSeq: 0,
  refresh: async () => {
    const version = ++refreshVersion;
    try {
      const [data, checkouts] = await Promise.all([api.workflow(), api.worktrees()]);
      if (version === refreshVersion) set({ data, checkouts, error: null });
    } catch (error) {
      if (version === refreshVersion) set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
}));

export function revealTask(id: string) {
  useWorkflow.setState((state) => ({ focusedId: id, focusSeq: state.focusSeq + 1 }));
  useWorkbench.getState().openTask(id);
}

export async function copyTaskBrief(change: DevelopmentChange) {
  try {
    const ids = change.commentIds ?? [];
    const comments = ids.length ? await api.exportComments(ids, true) : undefined;
    await copyText(
      [
        `任务：${change.title}`,
        change.body && `目标与范围：\n${change.body}`,
        change.acceptance && `验收条件：\n${change.acceptance}`,
        change.agent && `执行者：${change.agent}`,
        `工作目录：${change.worktree}`,
        `临时分支：${change.branch}`,
        `主开发分支：${change.developmentBranch}`,
        '只在任务工作区开发。可以提交多个本地 commit，由用户审查后分批合入主开发分支。',
        '用户在主目录自行运行测试。用 warden feedback / warden reply 获取和回复评论。',
        comments?.text,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    if (comments?.commentIds.length) {
      await api.exportComments(comments.commentIds);
      await useStore.getState().loadAllComments();
    }
    useStore.getState().showToast('任务说明已复制');
  } catch (error) {
    useStore.getState().showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

export async function workflowAction<T>(action: () => Promise<T>): Promise<T | undefined> {
  if (useWorkflow.getState().busy) return;
  useWorkflow.setState({ busy: true, actionError: null });
  try {
    const result = await action();
    await Promise.all([useWorkflow.getState().refresh(), useStore.getState().reloadRepo()]);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useStore.getState().showToast(message, 'error');
    await useWorkflow.getState().refresh();
    useWorkflow.setState({ actionError: message });
  } finally {
    useWorkflow.setState({ busy: false });
  }
}

export function changeTarget(change: WorkflowTask) {
  if (!change.worktree) return undefined;
  if (change.status === 'accepted' && change.integration?.commit) return formatTargetKey({ kind: 'commit', sha: change.integration.commit });
  const checkout = useWorkflow.getState().checkouts?.worktrees.find((row) => row.path === change.worktree);
  const head = checkout?.dirty === 0 ? checkout.head : undefined;
  const base = change.sourceBase ?? change.base;
  if (head) return formatTargetKey({ kind: 'range', base, head, worktree: change.worktree });
  return formatTargetKey({ kind: 'base', ref: base, worktree: change.worktree });
}

export function preparationTarget(change: DevelopmentChange) {
  const pending = useWorkflow.getState().data?.preparation;
  if (pending?.changeId === change.id && pending.state === 'committed' && pending.head) return formatTargetKey({ kind: 'commit', sha: pending.head });
  const path = pending?.worktree ?? change.integration?.worktree;
  return formatTargetKey({ kind: 'staged', worktree: path === useStore.getState().repo?.root ? undefined : path });
}

export async function reviewChange(change: WorkflowTask) {
  // setTarget opens the diff immediately. A late load must not reopen it after
  // the user has already chosen another task or returned to orchestration.
  const target = change.status === 'integrating' ? preparationTarget(change) : changeTarget(change);
  if (target) await useStore.getState().setTarget(target);
}
