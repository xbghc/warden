import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WorkbenchModel } from '@warden/shared';
import { WorkbenchApp } from './workbench';

const base: WorkbenchModel = {
  session: 'storybook',
  repository: '/projects/orders',
  surface: 'workspaces',
  creating: true,
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

export const NewWorkspace: Story = {};
export const ChooseRepository: Story = { args: { model: { ...base, repository: '', workflow: undefined, creating: false } } };
export const ChooseBranch: Story = { args: { model: { ...base, workflow: { workflow: null }, creating: false } } };
export const Loading: Story = { args: { model: { ...base, workflow: undefined, creating: false } } };
export const HookFailure: Story = {
  args: {
    model: {
      ...base,
      creating: false,
      task,
      workspaces: [{ task, expanded: false, description: '初始化失败', tooltip: task.body }],
      errors: [{ scope: 'task:orders', code: 'commit_failed', message: '提交 hook 失败；已保留主目录中准备好的内容。处理后重新打开差异审阅。' }],
    },
  },
};
export const HistoryDraft: Story = {
  args: {
    model: {
      ...base,
      creating: false,
      surface: 'history',
      history: {
        branch: 'feature/orders',
        head: 'bc2345',
        commits: [
          { sha: 'abc123', parents: ['def456'], message: '增加订单查询', author: '开发者', date: '2026-10-24' },
          { sha: 'bc2345', parents: ['abc123'], message: '补充分页参数', author: '开发者', date: '2026-10-24' },
        ],
      },
      historyDraft: {
        head: 'bc2345',
        start: 'abc123',
        commits: [
          { sha: 'abc123', message: '增加订单查询\n\n保留旧调用方式。' },
          { sha: 'bc2345', message: '补充分页参数' },
        ],
      },
    },
  },
};
export const PreviewConflict: Story = {
  args: {
    model: {
      ...base,
      creating: false,
      surface: 'preview',
      preview: {
        connectedIds: [],
        status: 'stale',
        syncStatus: 'conflict',
        worktree: '/projects/orders-warden/preview',
        files: [],
        conflicts: ['src/orders.ts'],
        message: '连接内容存在冲突。预览仍保留上一次成功同步的内容。',
      },
    },
  },
};
export const Settings: Story = { args: { model: { ...base, surface: 'settings' } } };
