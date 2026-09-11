import type { Meta, StoryObj } from '@storybook/react-vite';
import { Markdown } from './Markdown';

const meta = {
  title: 'Review/Markdown',
  component: Markdown,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReviewComment: Story = {
  args: { text: '这里需要处理 **空列表**，并复用 `calcTotal`。\n\n- 保留折扣逻辑\n- 添加边界情况测试\n\n> 避免在渲染期间修改原始数据。' },
};

export const GitHubFlavoredMarkdown: Story = {
  args: {
    text: '# Review checklist\n\n- [x] 检查类型\n- [ ] 补充测试\n\n| 状态 | 文件 |\n| --- | --- |\n| 修改 | `src/App.tsx` |\n| 新增 | `src/empty.ts` |\n\n```ts\nconst total = items.reduce((sum, item) => sum + item.price, 0);\n```\n\n~~旧实现~~ → 新实现。',
  },
};

export const Empty: Story = { args: { text: '' } };
