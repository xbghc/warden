import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setupDemoStore } from '../../.storybook/demo-store';
import { useStore } from '../store';
import { IssueRail } from './IssueRail';

const meta = {
  title: 'Layout/IssueRail',
  component: IssueRail,
  decorators: [
    (Story) => (
      <div className="rail" style={{ height: 640 }}>
        <Story />
      </div>
    ),
  ],
  parameters: { docs: { story: { height: '680px' } } },
  beforeEach: setupDemoStore,
} satisfies Meta<typeof IssueRail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = {
  beforeEach: () => {
    useStore.setState({ issues: [] });
  },
};
export const CreateIssue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '添加 Issue' }));
    await userEvent.type(canvas.getAllByRole('textbox', { name: '标题' }).find((el) => !(el as HTMLTextAreaElement).value)!, '检查空状态{Enter}');
    await expect(canvas.getByDisplayValue('检查空状态')).toBeVisible();
    await expect(useStore.getState().createIssue).toHaveBeenCalledWith({ title: '检查空状态', body: '', after: undefined });
  },
};
export const Detail: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByDisplayValue('统一金额计算逻辑'));
    await expect(canvas.getByRole('button', { name: '复制 Issue' })).toBeVisible();
    await expect(canvas.queryByText(/关联评论/)).not.toBeInTheDocument();
  },
};
