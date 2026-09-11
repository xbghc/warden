import type { Meta, StoryObj } from '@storybook/react-vite';
import type { FileEntry } from '@warden/shared';
import { expect, fn, userEvent, within } from 'storybook/test';
import { useStore } from '../store';
import { FileTree } from './FileTree';

function file(path: string, status: FileEntry['status'], extra: Partial<FileEntry> = {}): FileEntry {
  return { path, status, additions: 12, deletions: 3, binary: false, contentHash: path, viewed: false, changed: false, ...extra };
}

const unstaged = [
  file('src/App.tsx', 'modified'),
  file('src/components/Empty.tsx', 'added', { untracked: true, deletions: 0 }),
  file('src/legacy.ts', 'deleted', { additions: 0 }),
  file('assets/logo.png', 'modified', { binary: true }),
  file('README.md', 'modified', { changed: true }),
];
const staged = [
  file('src/App.tsx', 'modified', { viewed: true }),
  file('src/utils/total.ts', 'renamed', { oldPath: 'src/total.ts' }),
];

const meta = {
  title: 'Review/FileTree',
  component: FileTree,
  decorators: [(Story) => <div style={{ display: 'flex', height: 540 }}><Story /></div>],
  beforeEach() {
    useStore.setState({
      unstaged, staged, files: unstaged, activeFile: 'src/App.tsx',
      openFile: fn(async (path: string) => { useStore.setState({ activeFile: path }); }),
      switchView: fn(async (targetKey: string, activeFile?: string | null) => {
        useStore.setState({ targetKey, activeFile, files: targetKey === 'staged' ? useStore.getState().staged : useStore.getState().unstaged });
      }),
      toggleViewed: fn(async (path: string, view = useStore.getState().targetKey) => {
        const key = view === 'staged' ? 'staged' : 'unstaged';
        const files = useStore.getState()[key].map((entry) => entry.path === path ? { ...entry, viewed: !entry.viewed, changed: false } : entry);
        useStore.setState({ [key]: files, ...(view === useStore.getState().targetKey ? { files } : {}) });
      }),
    });
  },
} satisfies Meta<typeof FileTree>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LocalChanges: Story = {};
export const FileTypes: Story = {
  beforeEach: () => {
    const files = ['App.tsx', 'index.ts', 'main.js', 'styles.css', 'README.md', 'package.json', 'vite.config.ts', 'Dockerfile', '.gitignore', 'script.py', 'logo.svg', 'data.unknown'].map((path) => file(path, 'modified'));
    useStore.setState({ files, unstaged: files, activeFile: 'App.tsx' });
  },
};
export const LongPaths: Story = {
  beforeEach: () => {
    const files = [
      file('src/components/ReviewCommentAttachmentSelector.tsx', 'modified', { additions: 1248, deletions: 365, changed: true }),
      file('src/components/ReviewCommentAttachmentSelector.test.tsx', 'added', { additions: 240, deletions: 0 }),
      file('src/components/原始文件与新文件的差异比较.tsx', 'renamed', { oldPath: 'src/compare.tsx' }),
    ];
    useStore.setState({ files, unstaged: files, activeFile: files[0]!.path });
  },
};
export const Narrow: Story = {
  ...LongPaths,
  render: () => <div style={{ display: 'flex', width: 220, height: 540 }}><FileTree /></div>,
};
export const Empty: Story = { beforeEach: () => { useStore.setState({ files: [], unstaged: [], staged: [], activeFile: null }); } };
export const Loading: Story = { beforeEach: () => { useStore.setState({ files: [], unstaged: [], staged: [], filesLoading: true, activeFile: null }); } };
export const Error: Story = { beforeEach: () => { useStore.setState({ filesError: '无法读取仓库，请确认目录仍然存在。' }); } };
export const CommitChanges: Story = { beforeEach: () => { useStore.setState({ targetKey: 'commit:abc1234' }); } };
export const MarkViewed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const checkboxes = canvas.getAllByRole('checkbox');
    await userEvent.click(checkboxes[0]!);
    await expect(checkboxes[0]!).toBeChecked();
    await expect(useStore.getState().toggleViewed).toHaveBeenCalledOnce();
  },
};
