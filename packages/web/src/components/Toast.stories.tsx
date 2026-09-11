import type { Meta, StoryObj } from '@storybook/react-vite';
import { useStore, type Toast as ToastState } from '../store';
import { Toast } from './Toast';

const meta = {
  title: 'Feedback/Toast',
  component: Toast,
  render: () => <Toast />,
} satisfies Meta<typeof Toast>;
export default meta;
type Story = StoryObj<typeof meta>;

function showToast(kind: ToastState['kind'], message: string) {
  return () => {
    useStore.setState({ toast: { id: 1, kind, message } });
  };
}

export const Info: Story = { beforeEach: showToast('info', '已复制 3 条评论') };
export const ErrorState: Story = { beforeEach: showToast('error', '加载 diff 失败，请刷新重试。') };
export const LongMessage: Story = { beforeEach: showToast('info', '评论已复制。请将内容粘贴给编码助手，修复后刷新以检查代码变化和评论附着状态。') };
export const Hidden: Story = {};
