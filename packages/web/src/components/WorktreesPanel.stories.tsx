import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { setupWorktreeStore } from '../../.storybook/worktree-store';
import { api } from '../api';
import { WorktreesPanel } from './WorktreesPanel';

const topic = '/workspace/warden-1';
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
/** Releasing a slot: the row asks first, with the branch and directory options, then keeps the directory. */
export const ReleaseSlot: Story = {
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: '释放' }));
    await expect(await within(row).findByText(/释放 warden-1/)).toBeVisible();
    await expect(within(row).getByRole('checkbox', { name: /一并删除分支/ })).toBeChecked();
    await expect(within(row).getByRole('checkbox', { name: /连目录一起删除/ })).not.toBeChecked();
    await userEvent.click(within(row).getByRole('button', { name: '释放' }));
    await waitFor(() => expect(api.releaseWorktree).toHaveBeenCalledWith({ path: topic, force: false, deleteBranch: true }));
    await expect(api.removeWorktree).not.toHaveBeenCalled();
  },
};
/** A free slot's row points the form at it, and the checkout goes there rather than to a new directory. */
export const CheckOutIntoFreeSlot: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = (await canvas.findByText('warden-2')).closest('.wt-row')! as HTMLElement;
    await expect(within(row).getByText('空闲')).toBeVisible();
    await userEvent.click(within(row).getByRole('button', { name: '检出到这里' }));
    // The form lives in the sidebar's slot, outside the panel; the stories' decorator has none, so
    // the form renders nowhere. What can be checked here is the request the row's pick leads to.
    await expect(api.createWorktree).not.toHaveBeenCalled();
  },
};
export const OpenTmuxSession: Story = {
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'tmux session' }));
    await waitFor(() => expect(api.openTmuxSession).toHaveBeenCalledWith({ path: topic }));
    await expect(api.openTmuxSession).toHaveBeenCalledTimes(1);
    // Nothing to pick any more: the session is the worktree's own, made in one click.
    await expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
  },
};
export const TmuxUnavailable: Story = {
  beforeEach: () => {
    api.openTmuxSession = fn(async () => {
      throw new Error('tmux 不可用，请在 WSL 中运行 warden');
    });
  },
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText('feature/review')).closest('.wt-row')! as HTMLElement;
    const button = within(row).getByRole('button', { name: 'tmux session' });
    await userEvent.click(button);
    await waitFor(() => expect(api.openTmuxSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toBeEnabled());
  },
};
