import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setupDemoStore } from '../../.storybook/demo-store';
import { useStore } from '../store';
import { TopBar } from './TopBar';

const meta = {
  title: 'Layout/TopBar', component: TopBar,
  parameters: { layout: 'fullscreen', docs: { story: { height: '240px' } } },
  beforeEach: setupDemoStore,
} satisfies Meta<typeof TopBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Refreshing: Story = { beforeEach: () => { useStore.setState({ filesLoading: true, nvimScanning: true }); } };
export const Commit: Story = { beforeEach: () => { useStore.setState({ targetKey: 'commit:abc1234' }); } };
export const CompareRefs: Story = { beforeEach: () => { useStore.setState({ targetKey: 'range:main..feature/review' }); } };
export const Worktree: Story = { beforeEach: () => { useStore.setState({ targetKey: 'worktree:/workspace/warden-review:working', root: '/workspace/warden-review' }); } };
export const NvimUnavailable: Story = { beforeEach: () => { useStore.setState((s) => ({ nvim: { ...s.nvim!, nvimAvailable: false, instances: [], selected: undefined } })); } };
export const MultipleEditors: Story = { beforeEach: () => { useStore.setState((s) => ({ nvim: { ...s.nvim!, instances: [...s.nvim!.instances, { socket: '/tmp/nvim.43.0', cwd: '/workspace/warden/src', pid: 43 }] } })); } };
export const ChangeView: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Split' }));
    await expect(useStore.getState().prefs.viewMode).toBe('split');
    await userEvent.click(canvas.getByRole('button', { name: '自动刷新' }));
    await expect(canvas.getByRole('button', { name: '自动刷新' })).toHaveAttribute('aria-pressed', 'false');
  },
};
