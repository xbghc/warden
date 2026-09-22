import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { setupWorktreeStore } from '../../.storybook/worktree-store';
import { api } from '../api';
import { useStore } from '../store';
import { Sidebar } from './Sidebar';
import { CommitsPanel } from './CommitsPanel';
import { WorktreesPanel } from './WorktreesPanel';

function NavigationPreview() {
  const panel = useStore((s) => s.panel);
  return (
    <div style={{ display: 'flex', height: 640, overflow: 'hidden' }}>
      <Sidebar />
      <main style={{ flex: 1, minWidth: 0, display: 'flex', overflow: 'auto' }}>
        {panel === 'commits' ? <CommitsPanel active /> : panel === 'worktrees' ? <WorktreesPanel /> : <div className="muted empty">从左侧选择文件查看变更</div>}
      </main>
    </div>
  );
}

const meta = {
  title: 'Layout/Sidebar',
  component: Sidebar,
  render: () => <NavigationPreview />,
  parameters: { layout: 'fullscreen', docs: { story: { height: '680px' } } },
  beforeEach: () => {
    const cleanup = setupWorktreeStore();
    api.forkPoint = fn(async ({ base }) => ({ base, sha: 'abc1234', ahead: 2, behind: 1 }));
    const files = [
      { path: 'README.md', status: 'modified' as const, additions: 5, deletions: 1, binary: false, viewed: false, changed: false, contentHash: 'demo' },
    ];
    useStore.setState({
      files,
      unstaged: files,
      staged: [],
      openFile: fn(async (activeFile) => {
        useStore.setState({ activeFile });
      }),
      toggleViewed: fn(async () => {}),
      reloadRepo: fn(async () => {}),
    });
    return cleanup;
  },
} satisfies Meta<typeof Sidebar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WorkingTree: Story = {};
export const Commits: Story = {
  beforeEach: () => {
    useStore.setState({ panel: 'commits' });
  },
};
export const Worktrees: Story = {
  beforeEach: () => {
    useStore.setState({ panel: 'worktrees' });
  },
};
export const SwitchView: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = canvas.getByRole('combobox', { name: '切换视图' });
    await expect(picker).toHaveValue('working');
    await userEvent.selectOptions(picker, 'commits');
    await expect(await canvas.findByText('审阅整条分支')).toBeVisible();
    await expect(await canvas.findByText('补充评论导出')).toBeVisible();
    await userEvent.selectOptions(picker, 'worktrees');
    await expect(await canvas.findByText('检出分支')).toBeVisible();
    await expect(await canvas.findByText('feature/review')).toBeVisible();
    await userEvent.selectOptions(picker, 'working');
    await expect(await canvas.findByText('README.md')).toBeVisible();
    await expect(canvas.queryByText('检出分支')).not.toBeInTheDocument();
  },
};
export const CommitTarget: Story = {
  beforeEach: () => {
    useStore.setState({ targetKey: 'commit:def5678', setTarget: fn(async (targetKey) => useStore.setState({ targetKey, panel: 'diff' })) });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = canvas.getByRole('combobox', { name: '切换视图' });
    await expect(picker).toHaveValue('target');
    await expect(canvas.getByRole('option', { name: '提交 def5678' })).toBeInTheDocument();
    await userEvent.selectOptions(picker, 'commits');
    await userEvent.selectOptions(picker, 'target');
    await expect(picker).toHaveValue('target');
    await userEvent.selectOptions(picker, 'working');
    await expect(useStore.getState().setTarget).toHaveBeenCalledWith('working');
    await expect(picker).toHaveValue('working');
    await expect(canvas.queryByRole('option', { name: '提交 def5678' })).not.toBeInTheDocument();
  },
};
