import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WorkbenchModel } from '@warden/shared';
import { WorkbenchApp } from './workbench';

const base: WorkbenchModel = {
  session: 'storybook',
  repository: '/projects/orders',
  repositoryState: 'ready',
  agentConfiguration: { status: 'configured', count: 1 },
  agentReadiness: { status: 'ready', profile: { id: 'fixture', label: 'Fixture agent' }, message: 'Agent connection verified.' },
  surface: 'rebase',
  message: '',
  errors: [],
  reviewCurrent: false,
  hasPreviewCommand: false,
  workflow: { workflow: { developmentBranch: 'feature/orders', changes: [] } },
};
const task = {
  id: 'orders',
  title: '订单查询接口',
  developmentBranch: 'feature/orders',
  status: 'working' as const,
  createdAt: '2026-10-24T00:00:00Z',
  branch: 'warden/orders',
  base: 'abc123',
  worktree: '/projects/orders-1',
  workspaceHook: { event: 'create' as const, command: 'pnpm install', status: 'failed' as const, exitCode: 1, output: '依赖安装失败，请检查仓库配置后重试。' },
};
const meta = {
  title: 'Workbench/Rebase Panel',
  component: WorkbenchApp,
  args: { model: base, send: () => {} },
} satisfies Meta<typeof WorkbenchApp>;
export default meta;
type Story = StoryObj<typeof meta>;

// The panel stays open across agent disconnects and falls back to the Configure ACP entry point.
export const UnavailableAgent: Story = {
  args: {
    model: {
      ...base,
      agentReadiness: { status: 'error', message: 'Unable to start the agent. Check its executable path on the workspace host.' },
    },
  },
};
// A pending reconnect, such as after a profile change, shows progress instead of setup.
export const ConnectingAgent: Story = {
  args: { model: { ...base, agentReadiness: { status: 'checking', message: 'Connecting to ACP…' } } },
};
const synchronizationCases = [
  { id: 'current', title: '订单查询', status: 'current', message: 'Includes the current base branch commit.' },
  { id: 'ready', title: '订单筛选', status: 'ready', message: 'The check found no rebase conflicts.' },
  { id: 'conflict', title: '表单校验', status: 'conflict', message: 'Conflicts expected in src/orders.ts. Rebase has not run.' },
  { id: 'blocked', title: '错误提示', status: 'blocked', message: 'The workspace has uncommitted changes.' },
  { id: 'unknown', title: '接口联调', status: 'unknown', message: 'Unable to read Git status.' },
] as const;

export const SynchronizationChecks: Story = {
  args: {
    model: {
      ...base,
      surface: 'rebase',
      workflow: {
        workflow: {
          developmentBranch: task.developmentBranch,
          changes: synchronizationCases.map(({ id, title }) => ({ ...task, id, title })),
        },
        developmentHead: 'c42e9100',
      },
      checks: {
        checks: synchronizationCases.map(({ id, status, message }) => ({
          changeId: id,
          sourceHead: 'abc12300',
          developmentHead: 'c42e9100',
          checkedAt: '2026-10-31T02:45:08Z',
          status,
          message,
        })),
      },
    },
  },
};

export const CheckingSynchronization: Story = {
  args: {
    model: {
      ...base,
      surface: 'rebase',
      workflow: { workflow: { developmentBranch: task.developmentBranch, changes: [task] }, developmentHead: 'c42e9100' },
      checkingRebase: true,
      rebaseSelection: { request: 'pending', taskIds: [task.id] },
      checks: {
        checks: [
          {
            changeId: task.id,
            sourceHead: '',
            developmentHead: 'c42e9100',
            checkedAt: '2026-10-31T02:45:08Z',
            status: 'unknown',
            message: 'Checking synchronization…',
          },
        ],
      },
    },
  },
};
