import { fn } from 'storybook/test';
import type { DevelopmentChange, WorkflowTask, WorkflowResponse } from '@warden/shared';
import { api } from '../src/api';
import { useWorkflow } from '../src/workflow-store';

/** Local-only task lifecycle fixtures shared by the full workspace previews. */
export async function setupWorkflowStore() {
  const checkouts = structuredClone(await api.worktrees());
  const base = 'abc1234';
  const changes: WorkflowTask[] = [
    {
      id: 'orders',
      title: '补充订单金额校验',
      branch: 'feature/review',
      worktree: '/workspace/warden-1',
      developmentBranch: 'feature/order',
      base,
      submittedHead: 'def5678',
      status: 'working',
      createdAt: '2026-10-14T08:00:00Z',
    },
    {
      id: 'errors',
      title: '统一库存不足的错误提示',
      branch: 'agent/clone-work',
      worktree: '/workspace/warden-3',
      developmentBranch: 'feature/order',
      base: 'fed1234',
      status: 'working',
      createdAt: '2026-10-14T08:10:00Z',
      sync: { status: 'pending', target: base, message: '主开发分支已有新提交，可检查同步条件' },
    },
    {
      id: 'tests',
      title: '覆盖折扣叠加的边界测试',
      branch: 'warden/tests',
      worktree: '/workspace/warden-5',
      developmentBranch: 'feature/order',
      base: 'fed1234',
      submittedHead: 'fed5678',
      status: 'working',
      createdAt: '2026-10-14T08:20:00Z',
      sync: { status: 'conflict', target: base, message: '预计 rebase 有冲突，尚未执行' },
    },
    {
      id: 'accepted',
      title: '提取订单金额计算函数',
      branch: 'warden/total',
      worktree: '/workspace/warden-2',
      developmentBranch: 'feature/order',
      base: 'fed1234',
      status: 'accepted',
      createdAt: '2026-10-14T07:00:00Z',
      acceptedAt: '2026-10-14T07:30:00Z',
      integration: { commit: base, source: 'fed4567', parent: 'fed1234', message: '提取订单金额计算函数' },
    },
  ];
  changes.push(
    {
      id: 'retry',
      title: '为支付重试增加幂等保护',
      developmentBranch: 'feature/order',
      status: 'planned',
      body: '相同请求重复提交时复用首次支付结果。',
      acceptance: '并发重试只产生一笔支付记录。',
      dependsOn: ['orders'],
      createdAt: '2026-10-14T08:30:00Z',
    },
    {
      id: 'empty',
      title: '补充空订单的交互反馈',
      developmentBranch: 'feature/order',
      status: 'planned',
      body: '空订单不能进入支付流程。',
      acceptance: '按钮禁用，并展示明确的引导。',
      createdAt: '2026-10-14T08:40:00Z',
    },
  );
  const assigned = (id: string): DevelopmentChange => {
    const change = changes.find((row) => row.id === id)!;
    if (!change.worktree) throw new Error('task has not started');
    return change;
  };
  const data: WorkflowResponse = { workflow: { developmentBranch: 'feature/order', changes }, developmentHead: base };
  checkouts.worktrees[0]!.branch = 'feature/order';
  checkouts.worktrees[1]!.dirty = 0;
  checkouts.worktrees[1]!.head = 'def5678';
  checkouts.worktrees.find((row) => row.path === '/workspace/warden-3')!.dirty = 0;
  checkouts.branches = [
    { name: 'feature/order', sha: base },
    { name: 'main', sha: 'fed1234' },
  ];
  checkouts.worktrees.push({ ...checkouts.worktrees[1]!, path: '/workspace/warden-5', branch: 'warden/tests', slot: 5, head: 'fed5678' });
  api.workflow = fn(async () => structuredClone(data));
  api.worktrees = fn(async () => structuredClone(checkouts));
  api.configureWorkflow = fn(async (developmentBranch) => {
    data.workflow!.developmentBranch = developmentBranch;
    return structuredClone(data);
  });
  api.createChange = fn(async (request) => {
    const change: WorkflowTask = {
      ...request,
      worktree: undefined,
      id: `preview-${changes.length}`,
      developmentBranch: 'feature/order',
      status: 'planned',
      createdAt: new Date().toISOString(),
    };
    changes.push(change);
    return structuredClone(change);
  });
  api.updateChange = fn(async (id, patch) => {
    const change = changes.find((row) => row.id === id)!;
    Object.assign(change, patch);
    return structuredClone(change);
  });
  api.moveChange = fn(async (id, before) => {
    const index = changes.findIndex((row) => row.id === id);
    const [row] = changes.splice(index, 1);
    changes.splice(before ? changes.findIndex((entry) => entry.id === before) : changes.length, 0, row!);
    return structuredClone(data);
  });
  api.importTodo = fn(async () => structuredClone(data));
  api.startChange = fn(async (id, request) => {
    const index = changes.findIndex((row) => row.id === id);
    const plan = changes[index]!;
    const change: DevelopmentChange = {
      ...plan,
      branch: `warden/preview-${id}`,
      worktree: '/workspace/warden-2',
      base: data.developmentHead!,
      status: 'working',
      agent: request.agent,
    };
    changes[index] = change;
    Object.assign(checkouts.worktrees.find((row) => row.path === change.worktree)!, { branch: change.branch, free: false, detached: false });
    return structuredClone(change);
  });
  data.workspaceConfig = { hooks: {} };
  api.saveWorkspaceConfig = fn(async (config) => {
    data.workspaceConfig = structuredClone(config);
    return structuredClone(config);
  });
  api.retryWorkspaceHook = fn(async (id) => structuredClone(assigned(id)));
  api.syncChange = fn(async (id) => {
    const change = assigned(id);
    change.base = data.developmentHead!;
    delete change.sync;
    return structuredClone(change);
  });
  api.prepareChange = fn(async (id, request) => {
    const change = assigned(id);
    change.status = 'integrating';
    change.integration = { source: request.sourceHead, parent: request.developmentHead, message: change.title, worktree: '/workspace/warden', prepared: true };
    data.preparation = {
      changeId: id,
      worktree: '/workspace/warden',
      state: 'testing',
      head: data.developmentHead,
      indexFingerprint: 'staged-order',
      canCommit: true,
    };
    checkouts.worktrees[0]!.dirty = 1;
    return structuredClone(change);
  });
  api.acceptChange = fn(async (id, request) => {
    const change = assigned(id);
    const integration = change.integration!;
    change.status = 'working';
    change.deliveries = [
      ...(change.deliveries ?? []),
      {
        id: `delivery-${change.id}-${change.deliveries?.length ?? 0}`,
        source: integration.source,
        sourceBase: change.sourceBase ?? change.base,
        parent: integration.parent,
        commit: 'cafe123',
        message: request.mode === 'commit' ? request.message : change.title,
        createdAt: new Date().toISOString(),
      },
    ];
    change.sourceBase = integration.source;
    delete change.integration;
    delete data.preparation;
    data.developmentHead = 'cafe123';
    Object.assign(checkouts.worktrees[0]!, { dirty: 0, head: 'cafe123' });
    return structuredClone(change);
  });
  api.deliverChange = fn(async (id, request) => {
    await api.prepareChange(id, request);
    return api.acceptChange(id, {
      mode: 'commit',
      developmentHead: request.developmentHead,
      indexFingerprint: data.preparation!.indexFingerprint!,
      message: request.message,
    });
  });
  useWorkflow.setState({ data: structuredClone(data), checkouts: structuredClone(checkouts), busy: false, error: null });
}
