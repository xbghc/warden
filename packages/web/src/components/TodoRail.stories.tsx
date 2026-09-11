import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setupDemoStore } from '../../.storybook/demo-store';
import { useStore } from '../store';
import { TodoRail } from './TodoRail';

const meta = {
  title: 'Layout/TodoRail',
  component: TodoRail,
  decorators: [
    (Story) => (
      <div className="rail" style={{ height: 640 }}>
        <Story />
      </div>
    ),
  ],
  parameters: { docs: { story: { height: '680px' } } },
  beforeEach: setupDemoStore,
} satisfies Meta<typeof TodoRail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentBranch: Story = {};
export const Empty: Story = {
  beforeEach: () => {
    useStore.setState({ todos: [] });
  },
};
export const SwitchBranch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByDisplayValue('补充空列表测试')).toBeVisible();
    await expect(canvas.queryByDisplayValue('完善评论导出')).not.toBeInTheDocument();
    useStore.setState({ root: '/workspace/warden-review' });
    await expect(await canvas.findByDisplayValue('完善评论导出')).toBeVisible();
    await expect(canvas.queryByDisplayValue('补充空列表测试')).not.toBeInTheDocument();
    await expect(canvas.queryByDisplayValue('检查键盘操作')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('checkbox', { name: '所有分支' })).not.toBeInTheDocument();
    useStore.setState({ root: '/workspace/warden' });
    await expect(await canvas.findByDisplayValue('补充空列表测试')).toBeVisible();
    await expect(canvas.queryByDisplayValue('完善评论导出')).not.toBeInTheDocument();
  },
};
export const CreateTodo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '添加待办' }));
    await userEvent.type(canvas.getAllByRole('textbox', { name: '标题' }).find((el) => !(el as HTMLTextAreaElement).value)!, '检查长文件名布局{Enter}');
    await expect(canvas.getByDisplayValue('检查长文件名布局')).toBeVisible();
  },
};
