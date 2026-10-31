import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WorkbenchModel } from '@warden/shared';
import { WorkbenchApp } from './workbench';

const base: WorkbenchModel = {
  session: 'storybook',
  repository: '/projects/orders',
  repositoryState: 'ready',
  agentConfiguration: { status: 'configured', count: 1 },
  agentReadiness: { status: 'ready', profile: { id: 'fixture', label: 'Fixture agent' }, message: 'Agent connection verified.' },
  surface: 'task',
  message: '',
  errors: [],
  reviewCurrent: false,
  hasPreviewCommand: false,
  workflow: { workflow: { developmentBranch: 'feature/orders', changes: [] } },
};
const task = {
  id: 'orders',
  title: '订单查询接口',
  body: '增加分页查询\n保留旧调用方式',
  developmentBranch: 'feature/orders',
  status: 'working' as const,
  createdAt: '2026-10-24T00:00:00Z',
  branch: 'warden/orders',
  base: 'abc123',
  worktree: '/projects/orders-1',
  workspaceHook: { event: 'create' as const, command: 'pnpm install', status: 'failed' as const, exitCode: 1, output: '依赖安装失败，请检查仓库配置后重试。' },
};
const meta = {
  title: 'Workbench/Forms',
  component: WorkbenchApp,
  args: { model: base, send: () => {} },
} satisfies Meta<typeof WorkbenchApp>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TaskNotes: Story = { args: { model: { ...base, task } } };
export const OpeningRepository: Story = { args: { model: { ...base, repository: '', repositoryState: 'loading', workflow: undefined } } };
export const ChooseRepository: Story = { args: { model: { ...base, repository: '', repositoryState: 'unselected', workflow: undefined } } };
export const ChooseBranch: Story = { args: { model: { ...base, workflow: { workflow: null } } } };
export const MissingAgent: Story = { args: { model: { ...base, agentConfiguration: { status: 'missing' }, agentReadiness: { status: 'unchecked' } } } };
export const UncheckedAgent: Story = { args: { model: { ...base, agentReadiness: { status: 'unchecked' } } } };
export const UnavailableAgent: Story = {
  args: {
    model: {
      ...base,
      agentReadiness: { status: 'error', message: 'Unable to start the agent. Check its executable path on the workspace host.' },
    },
  },
};
export const AgentAuthentication: Story = {
  args: {
    model: {
      ...base,
      agentReadiness: { status: 'authentication_required', message: 'Sign in to continue.', authMethods: [{ id: 'login', name: 'Sign In' }] },
    },
  },
};
export const ConnectingAgent: Story = {
  args: { model: { ...base, agentReadiness: { status: 'checking', message: 'Connecting to ACP…' } } },
};
export const InvalidAgentConfiguration: Story = {
  args: {
    model: { ...base, workflow: { workflow: null }, agentConfiguration: { status: 'invalid', message: 'Agent profiles require a valid label and command.' } },
  },
};
export const ChooseBranchWithAgent: Story = {
  args: { model: { ...base, workflow: { workflow: null }, agentConfiguration: { status: 'configured', count: 1 } } },
};
export const Loading: Story = { args: { model: { ...base, workflow: undefined } } };
export const TaskSaveFailure: Story = {
  args: {
    model: {
      ...base,
      task,
      errors: [
        {
          scope: 'task:orders',
          code: 'operation_locked',
          message: 'Unable to save while another window updates the repository. The draft has been preserved; retry shortly.',
        },
      ],
    },
  },
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
