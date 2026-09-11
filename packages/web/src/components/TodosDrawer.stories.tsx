import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setupDemoStore } from '../../.storybook/demo-store';
import { useStore } from '../store';
import { TodosDrawer } from './TodosDrawer';

const meta = {
  title: 'Layout/TodosDrawer', component: TodosDrawer,
  decorators: [(Story) => <div style={{ display: 'flex', height: 640 }}><Story /></div>],
  parameters: { docs: { story: { height: '680px' } } },
  beforeEach: setupDemoStore,
} satisfies Meta<typeof TodosDrawer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentBranch: Story = {};
export const Empty: Story = { beforeEach: () => { useStore.setState({ todos: [] }); } };
export const SwitchBranch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('补充空列表测试')).toBeVisible();
    await expect(canvas.queryByText('完善评论导出')).not.toBeInTheDocument();
    useStore.setState({ root: '/workspace/warden-review' });
    await expect(await canvas.findByText('完善评论导出')).toBeVisible();
    await expect(canvas.queryByText('补充空列表测试')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: '全部' }));
    await expect(canvas.queryByText('检查键盘操作')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('checkbox', { name: '所有分支' })).not.toBeInTheDocument();
    useStore.setState({ root: '/workspace/warden' });
    await expect(await canvas.findByText('补充空列表测试')).toBeVisible();
    await expect(canvas.getByText('检查键盘操作')).toBeVisible();
    await expect(canvas.queryByText('完善评论导出')).not.toBeInTheDocument();
  },
};
export const CreateTodo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '新建' }));
    await userEvent.type(canvas.getByPlaceholderText('标题'), '检查长文件名布局');
    await userEvent.click(canvas.getByRole('button', { name: '创建 Todo' }));
    await expect(canvas.getByText('检查长文件名布局')).toBeVisible();
  },
};
