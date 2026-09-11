import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { setupWorktreeStore } from '../../.storybook/worktree-store';
import { api } from '../api';
import { WorktreesPanel } from './WorktreesPanel';

const root = '/workspace/warden';
const topic = '/workspace/warden-review';
const meta = {
  title: 'Layout/WorktreesPanel',
  component: WorktreesPanel,
  decorators: [
    (Story) => (
      <div style={{ height: 680 }}>
        <Story />
      </div>
    ),
  ],
  parameters: { docs: { story: { height: '720px' } } },
  beforeEach: setupWorktreeStore,
} satisfies Meta<typeof WorktreesPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const CommitHistory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = (await canvas.findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: '提交列表' }));
    await expect(await within(row).findByText('补充评论导出')).toBeVisible();
    await expect(api.commits).toHaveBeenCalledWith({ root: topic, ref: 'def5678', offset: 0, limit: 30 });
  },
};
export const BranchTodos: Story = {
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: '分支 TODO' }));
    await expect(await within(row).findByText('验证导出格式')).toBeVisible();
    await expect(api.todos).toHaveBeenCalledWith('feature/review');
  },
};
export const OpenTmuxWindow: Story = {
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'tmux' }));
    await waitFor(() => expect(api.openTmuxWindow).toHaveBeenCalledWith({ path: topic, sessionId: '$1' }));
    await expect(api.openTmuxWindow).toHaveBeenCalledTimes(1);
    await expect(within(row).queryByRole('combobox', { name: 'tmux session' })).not.toBeInTheDocument();
  },
};
export const MultipleTmuxSessions: Story = {
  beforeEach: () => {
    api.tmuxSessions = fn(async () => ({
      sessions: [
        { id: '$1', name: 'warden', path: root },
        { id: '$2', name: 'review', path: root },
      ],
    }));
  },
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'tmux' }));
    const picker = await within(row).findByRole('combobox', { name: 'tmux session' });
    await expect(api.openTmuxWindow).not.toHaveBeenCalled();
    await userEvent.selectOptions(picker, '$2');
    await userEvent.click(within(row).getByRole('button', { name: '新建 tmux 窗口' }));
    await waitFor(() => expect(api.openTmuxWindow).toHaveBeenCalledWith({ path: topic, sessionId: '$2' }));
  },
};
export const TmuxUnavailable: Story = {
  beforeEach: () => {
    api.tmuxSessions = fn(async () => {
      throw new Error('tmux 不可用，请在 WSL 中运行 warden');
    });
  },
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'tmux' }));
    await expect(await within(row).findByRole('alert')).toBeVisible();
  },
};
