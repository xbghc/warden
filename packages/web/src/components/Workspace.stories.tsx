import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { setupWorkbenchFixture } from '../../.storybook/workbench-fixture';
import { useWorkbench } from '../workbench-store';
import { useWorkbenchData } from '../workbench-data';
import { useWorkflow } from '../workflow-store';
import { api } from '../api';
import { App } from './App';

const meta = {
  title: 'Workbench/Main flows',
  component: App,
  parameters: { layout: 'fullscreen', docs: { story: { height: '900px' } } },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh', minHeight: 600 }}>
        <Story />
      </div>
    ),
  ],
  beforeEach: setupWorkbenchFixture,
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedPreview: Story = {};
export const TaskReview: Story = { beforeEach: () => useWorkbench.getState().openTask('orders') };
export const PlannedTask: Story = { beforeEach: () => useWorkbench.getState().openTask('retry') };
export const Settings: Story = { beforeEach: () => useWorkbench.getState().setSheet('settings') };
export const BatchRebase: Story = { beforeEach: () => useWorkbench.getState().setSheet('sync') };
export const History: Story = { beforeEach: () => useWorkbench.getState().openView('history') };
export const StalePreview: Story = {
  beforeEach: async () => {
    const current = await api.preview();
    api.preview = fn(async () => ({
      ...current,
      status: 'stale' as const,
      message: '后续变更与现有组合冲突；主目录仍呈现最近成功的预览。',
      conflicts: ['src/order.ts'],
    }));
    await useWorkbenchData.getState().refresh();
  },
};
export const InitialConnectionConflict: Story = {
  beforeEach: () => {
    api.connectPreview = fn(async () => {
      throw new Error('连接失败：src/order.ts 与现有贡献冲突。原连接保持不变。');
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('switch', { name: '连接 统一库存不足的错误提示' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('原连接保持不变');
    await expect(canvas.getByRole('switch', { name: '连接 统一库存不足的错误提示' })).not.toBeChecked();
  },
};
export const WebCommit: Story = {
  ...TaskReview,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '准备合入…' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: '准备合入' }));
    await userEvent.click(await dialog.findByRole('button', { name: '提交到主开发分支' }));
    await waitFor(() => expect(api.acceptChange).toHaveBeenCalled());
    await expect(useWorkflow.getState().data!.workflow!.changes.find((task) => task.id === 'orders')!.status).toBe('working');
  },
};
export const HookRejected: Story = {
  beforeEach: async () => {
    await api.prepareChange('orders', { sourceHead: 'def5678', developmentHead: 'abc1234' });
    await useWorkflow.getState().refresh();
    useWorkbench.getState().openTask('orders');
    api.acceptChange = fn(async () => {
      throw new Error('pre-commit: lint failed；暂存内容已保留。');
    });
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: '提交到主开发分支…' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: '提交到主开发分支' }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent('暂存内容已保留');
  },
};
export const ArrangeHistory: Story = {
  ...History,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: '历史编排起点' }), 'a100001');
    await userEvent.click(canvas.getByRole('button', { name: '调整历史' }));
    await userEvent.click(canvas.getByRole('button', { name: '上移提交 3' }));
    await userEvent.click(canvas.getByRole('button', { name: '预览改写' }));
    await expect(await canvas.findByRole('button', { name: '应用到 feature/order' })).toBeEnabled();
    await expect(api.applyHistory).not.toHaveBeenCalled();
  },
};

export const InterruptedPreparation: Story = {
  beforeEach: async () => {
    await api.prepareChange('orders', { sourceHead: 'def5678', developmentHead: 'abc1234' });
    const getWorkflow = api.workflow;
    const prepare = api.prepareChange;
    let interrupted = true;
    api.workflow = fn(async () => {
      const result = await getWorkflow();
      if (interrupted) {
        const task = result.workflow!.changes.find((row) => row.id === 'orders')!;
        if (task.integration) {
          task.integration.prepared = false;
          task.integration.error = '准备操作中断，已有内容保留。';
        }
        result.preparation = { ...result.preparation!, state: 'blocked', canCommit: false, message: '本次准备尚未完成。' };
      }
      return result;
    });
    api.prepareChange = fn(async (id, request) => {
      const result = await prepare(id, request);
      interrupted = false;
      return result;
    });
    await useWorkflow.getState().refresh();
    useWorkbench.getState().openTask('orders');
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: '重试准备…' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: '重试准备' }));
    await waitFor(() => expect(api.prepareChange).toHaveBeenCalledWith('orders', { sourceHead: 'def5678', developmentHead: 'abc1234' }));
    await expect(await dialog.findByRole('button', { name: '提交到主开发分支' })).toBeEnabled();
  },
};
