import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { CommentEditor } from './CommentEditor';

const meta = {
  title: 'Review/CommentEditor',
  component: CommentEditor,
  decorators: [(Story) => <div style={{ maxWidth: 640 }}><Story /></div>],
  args: { title: 'src/App.tsx · new 12–15', onSave: fn(), onCancel: fn() },
} satisfies Meta<typeof CommentEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const KeyboardShortcuts: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '保存评论' })).toBeDisabled();
    await userEvent.type(canvas.getByRole('textbox'), '   ');
    await expect(canvas.getByRole('button', { name: '保存评论' })).toBeDisabled();
    await userEvent.clear(canvas.getByRole('textbox'));
    await userEvent.type(canvas.getByRole('textbox'), '请处理空列表。');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expect(args.onSave).toHaveBeenCalledWith('请处理空列表。');
    await userEvent.keyboard('{Escape}');
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};

export const Editing: Story = {
  args: { title: '编辑评论', initial: '请复用 **calcTotal**，确保折扣计算一致。', submitLabel: '保存修改' },
};

export const SlowSave: Story = {
  args: { initial: '点击保存以查看等待状态。', onSave: fn(async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); }) },
};
