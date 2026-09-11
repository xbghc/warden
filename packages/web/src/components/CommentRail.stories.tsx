import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setupDemoStore } from '../../.storybook/demo-store';
import { useStore } from '../store';
import { CommentRail } from './CommentRail';

const meta = {
  title: 'Layout/CommentRail',
  component: CommentRail,
  decorators: [
    (Story) => (
      <div className="rail" style={{ height: 640 }}>
        <Story />
      </div>
    ),
  ],
  parameters: { docs: { story: { height: '680px' } } },
  beforeEach: setupDemoStore,
} satisfies Meta<typeof CommentRail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentFile: Story = {};
export const AllComments: Story = {
  beforeEach: () => {
    useStore.setState({ railFilter: 'all' });
  },
};
export const BeforeChanges: Story = {
  beforeEach: () => {
    useStore.setState((s) => ({ railFilter: 'all', comments: s.comments.map((c) => (c.id === 'comment-1' ? { ...c, side: 'old' } : c)) }));
  },
};
export const Empty: Story = {
  beforeEach: () => {
    useStore.setState({ comments: [] });
  },
};
export const NoMatchingComments: Story = {
  beforeEach: () => {
    useStore.setState({ activeFile: 'README.md' });
  },
};
export const WritingComment: Story = {
  beforeEach: () => {
    useStore.setState({ editor: { filePath: 'src/App.tsx', side: 'new', startLine: 18, endLine: 20 } });
  },
};
export const SaveComment: Story = {
  ...WritingComment,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox'), '请处理空列表。');
    await userEvent.click(canvas.getByRole('button', { name: '保存评论' }));
    await expect(canvas.getByText('请处理空列表。')).toBeVisible();
    await expect(useStore.getState().editor).toBeNull();
  },
};
