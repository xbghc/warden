import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setupDemoStore } from '../../.storybook/demo-store';
import { useStore } from '../store';
import { IssuesDrawer } from './IssuesDrawer';

const meta = {
  title: 'Layout/IssuesDrawer', component: IssuesDrawer,
  decorators: [(Story) => <div style={{ display: 'flex', height: 640 }}><Story /></div>],
  parameters: { docs: { story: { height: '680px' } } },
  beforeEach: setupDemoStore,
} satisfies Meta<typeof IssuesDrawer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = { beforeEach: () => { useStore.setState({ issues: [] }); } };
export const CreateIssue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '新建' }));
    await userEvent.type(canvas.getByPlaceholderText('标题'), '检查空状态');
    await userEvent.click(canvas.getByRole('button', { name: '创建 Issue' }));
    await expect(canvas.getByRole('heading', { name: /检查空状态/ })).toBeVisible();
    await expect(useStore.getState().createIssue).toHaveBeenCalledWith({ title: '检查空状态', body: '' });
  },
};
export const Detail: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('统一金额计算逻辑'));
    await expect(canvas.getByRole('button', { name: '复制 Issue' })).toBeVisible();
    await expect(canvas.queryByText(/关联评论/)).not.toBeInTheDocument();
  },
};
