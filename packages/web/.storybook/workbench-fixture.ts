import { fn } from 'storybook/test';
import type { DevelopmentChange, HistoryPreviewRequest, HistoryResponse, PreviewResponse, RebaseBatchRequest, RebaseCheck } from '@warden/shared';
import { api } from '../src/api';
import { useStore } from '../src/store';
import { useWorkflow } from '../src/workflow-store';
import { useWorkbenchData } from '../src/workbench-data';
import { setupWorkspaceStore } from './workspace-store';

/** Full-page fixtures replace APIs only inside Storybook; production uses the real server. */
export async function setupWorkbenchFixture() {
  const cleanup = await setupWorkspaceStore();
  const data = await api.workflow();
  data.workflow!.changes = data.workflow!.changes.filter((task) => task.status !== 'accepted');
  const orders = data.workflow!.changes.find((task) => task.id === 'orders')! as DevelopmentChange;
  if (orders.worktree) {
    orders.sourceBase = 'source-a1';
    orders.body = '校验订单总额与折扣叠加，保持空订单的明确反馈。';
    orders.deliveries = [
      {
        id: 'delivery-a1',
        source: 'source-a1',
        sourceBase: 'fed1234',
        parent: 'fed1234',
        commit: 'a100001',
        message: '提取订单金额计算函数',
        createdAt: '2026-10-14T09:00:00Z',
      },
    ];
  }
  data.workspaceConfig = {
    commands: [
      { id: 'agent', label: '启动 agent', text: 'codex', keys: ['Enter'] },
      { id: 'interrupt', label: '发送 Ctrl+C', keys: ['C-c'] },
    ],
    hooks: {},
  };
  const oldWorkflow = api.workflow;
  api.workflow = fn(async () => {
    const latest = await oldWorkflow();
    return {
      ...latest,
      workspaceConfig: data.workspaceConfig,
      workflow: {
        ...latest.workflow!,
        changes: latest
          .workflow!.changes.filter((task) => task.status !== 'accepted')
          .map((task) =>
            task.id === orders.id && task.worktree
              ? { ...task, body: orders.body, sourceBase: task.sourceBase ?? orders.sourceBase, deliveries: task.deliveries ?? orders.deliveries }
              : task,
          ),
      },
    };
  });
  let preview: PreviewResponse = {
    developmentBranch: 'feature/order',
    developmentHead: 'abc1234',
    worktree: '/workspace/warden',
    connectedIds: ['orders'],
    status: 'current',
    updatedAt: '2026-10-16T10:42:16Z',
    files: [{ path: 'src/App.tsx', changeIds: ['orders'] }],
  };
  api.preview = fn(async () => structuredClone(preview));
  api.connectPreview = fn(async (ids) => {
    preview = {
      ...preview,
      connectedIds: ids,
      status: ids.length ? 'current' : 'disconnected',
      updatedAt: new Date().toISOString(),
      files: ids.length ? [{ path: 'src/App.tsx', changeIds: ids }] : [],
    };
    return structuredClone(preview);
  });
  api.refreshPreview = fn(async () => {
    preview.updatedAt = new Date().toISOString();
    return structuredClone(preview);
  });
  api.sendWorkspaceInput = fn(async () => ({ session: 'warden-1', pane: '%1', created: false }));
  const checks: RebaseCheck[] = [
    { changeId: 'orders', sourceHead: 'def5678', developmentHead: 'abc1234', status: 'current', checkedAt: new Date().toISOString() },
    { changeId: 'errors', sourceHead: 'bcd2345', developmentHead: 'abc1234', status: 'ready', checkedAt: new Date().toISOString() },
    {
      changeId: 'tests',
      sourceHead: 'fed5678',
      developmentHead: 'abc1234',
      status: 'conflict',
      checkedAt: new Date().toISOString(),
      message: '预计 src/order.ts 冲突，尚未执行。',
      files: ['src/order.ts'],
    },
  ];
  api.rebaseChecks = fn(async () => ({ checks: structuredClone(checks) }));
  api.rebaseWorkspaces = fn(async ({ items }: RebaseBatchRequest) => ({
    results: items.map((item) => {
      const check = checks.find((row) => row.changeId === item.changeId)!;
      check.status = 'current';
      return { changeId: item.changeId, status: 'updated' as const };
    }),
  }));
  let history: HistoryResponse = {
    branch: 'feature/order',
    head: 'abc1234',
    commits: [
      {
        sha: 'a100001',
        parents: ['base001'],
        message: '提取订单金额计算函数',
        author: 'Lin',
        date: '2026-10-14T09:00:00Z',
        changeId: 'orders',
        deliveryId: 'delivery-a1',
      },
      {
        sha: 'b100001',
        parents: ['a100001'],
        message: '统一库存不足的提示',
        author: 'Lin',
        date: '2026-10-14T10:00:00Z',
        changeId: 'errors',
        deliveryId: 'delivery-b1',
      },
      {
        sha: 'abc1234',
        parents: ['b100001'],
        message: '增加折扣叠加校验',
        author: 'Lin',
        date: '2026-10-14T11:00:00Z',
        changeId: 'orders',
        deliveryId: 'delivery-a2',
      },
    ],
  };
  let candidate = history;
  api.history = fn(async () => structuredClone(history));
  api.previewHistory = fn(async (request: HistoryPreviewRequest) => {
    const entries = request.commits.map((commit, index) => ({
      ...history.commits.find((row) => row.sha === commit.sha)!,
      sha: `new000${index}`,
      message: commit.message,
    }));
    candidate = { ...history, head: entries.at(-1)!.sha, commits: entries };
    return {
      id: 'history-preview',
      head: request.head,
      newHead: candidate.head,
      canApply: true,
      contentChanged: false,
      conflicts: [],
      commits: entries.map((commit, index) => ({ source: request.commits[index]!.sha, sha: commit.sha, message: commit.message })),
    };
  });
  api.applyHistory = fn(async () => {
    history = candidate;
    return structuredClone(history);
  });
  await useWorkflow.getState().refresh();
  await useWorkbenchData.getState().refresh();
  useStore.setState((state) => ({ reviewReadOnly: true, prefs: { ...state.prefs, railOpen: false }, panel: 'diff' }));
  return cleanup;
}
