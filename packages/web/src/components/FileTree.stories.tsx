import type { Meta, StoryObj } from '@storybook/react-vite';
import type { FileEntry } from '@warden/shared';
import { expect, fn, userEvent, within } from 'storybook/test';
import { useStore } from '../store';
import { FileTree } from './FileTree';

function file(path: string, status: FileEntry['status'], extra: Partial<FileEntry> = {}): FileEntry {
  return { path, status, additions: 12, deletions: 3, binary: false, contentHash: path, ...extra };
}

const changes = [
  file('src/App.tsx', 'modified'),
  file('src/components/Empty.tsx', 'added', { untracked: true, deletions: 0 }),
  file('src/legacy.ts', 'deleted', { additions: 0 }),
  file('assets/logo.png', 'modified', { binary: true }),
  file('README.md', 'modified'),
];
const commitFiles = [file('src/App.tsx', 'modified'), file('src/components/Empty.tsx', 'added', { deletions: 0 }), file('README.md', 'modified')];

const meta = {
  title: 'Review/FileTree',
  component: FileTree,
  decorators: [
    (Story) => (
      <div className="sidebar" style={{ width: 320, maxWidth: '100%', height: 540 }}>
        <Story />
      </div>
    ),
  ],
  beforeEach() {
    useStore.setState({
      files: changes,
      targetKey: 'all',
      activeFile: 'src/App.tsx',
      openFile: fn(async (path: string) => {
        useStore.setState({ activeFile: path });
      }),
    });
  },
} satisfies Meta<typeof FileTree>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LocalChanges: Story = {};
export const FileTypes: Story = {
  beforeEach: () => {
    const files = [
      'App.tsx',
      'index.ts',
      'main.js',
      'styles.css',
      'README.md',
      'package.json',
      'vite.config.ts',
      'Dockerfile',
      '.gitignore',
      'script.py',
      'logo.svg',
      'data.unknown',
    ].map((path) => file(path, 'modified'));
    useStore.setState({ files, activeFile: 'App.tsx' });
  },
};
export const LongPaths: Story = {
  beforeEach: () => {
    const files = [
      file('src/components/ReviewFileComparisonSelector.tsx', 'modified', { additions: 1248, deletions: 365 }),
      file('src/components/ReviewFileComparisonSelector.test.tsx', 'added', { additions: 240, deletions: 0 }),
      file('src/components/原始文件与新文件的差异比较.tsx', 'renamed', { oldPath: 'src/compare.tsx' }),
    ];
    useStore.setState({ files, activeFile: files[0]!.path });
  },
};
export const Narrow: Story = {
  ...LongPaths,
  render: () => (
    <div style={{ display: 'flex', width: 220, height: 540 }}>
      <FileTree />
    </div>
  ),
};
export const Empty: Story = {
  beforeEach: () => {
    useStore.setState({ files: [], activeFile: null });
  },
};
export const Loading: Story = {
  beforeEach: () => {
    useStore.setState({ files: [], filesLoading: true, activeFile: null });
  },
};
export const ErrorState: Story = {
  beforeEach: () => {
    useStore.setState({ filesError: '无法读取仓库，请确认目录仍然存在。' });
  },
};
export const CommitChanges: Story = {
  beforeEach: () => {
    useStore.setState({ targetKey: 'commit:abc1234', files: commitFiles });
  },
};
export const NestedDirectories: Story = {
  beforeEach: () => {
    const files = [
      file('src/features/order/OrderList.tsx', 'modified'),
      file('src/features/order/hooks/useOrder.ts', 'modified'),
      file('src/utils/a.ts', 'modified'),
      file('src/utils/b.ts', 'modified'),
      file('docs/guide.md', 'modified'),
    ];
    useStore.setState({ targetKey: 'commit:abc1234', files });
  },
};
export const OpenFile: Story = {
  beforeEach: () => {
    useStore.setState({ targetKey: 'commit:abc1234', files: commitFiles, activeFile: null });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '展开全部目录' }));
    await userEvent.click(canvas.getByRole('button', { name: '打开 src/App.tsx' }));
    await expect(useStore.getState().openFile).toHaveBeenCalledWith('src/App.tsx');
    await expect(canvas.queryByRole('checkbox', { name: /已读/ })).not.toBeInTheDocument();
  },
};
