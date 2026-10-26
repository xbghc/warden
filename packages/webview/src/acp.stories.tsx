import type { Meta, StoryObj } from '@storybook/react-vite';
import type { AcpModel } from '@warden/shared';
import { AcpApp } from './acp';

const model: AcpModel = {
  panelId: 'orders-panel',
  record: {
    schemaVersion: 1,
    id: 'orders-conversation',
    binding: {
      repository: '/projects/orders',
      taskId: 'orders-filter',
      title: '订单筛选参数',
      workspace: '/projects/orders-2',
      branch: 'warden/orders-filter',
      identity: 'orders-filter-allocation',
    },
    canLoad: false,
    messages: [],
    updatedAt: '2026-10-25T00:00:00Z',
  },
  profiles: [{ id: 'configured-agent', label: '我的 Agent' }],
  status: 'disconnected',
  sending: false,
  permissions: [],
  authMethods: [],
  draft: '为订单列表增加筛选参数，保留旧调用方式。',
  draftVersion: 0,
  draftRevision: 0,
  draftChanges: [],
};
const meta = {
  title: 'Workbench/Agent conversation',
  component: AcpApp,
  args: { model, send: () => {} },
} satisfies Meta<typeof AcpApp>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewConversation: Story = {};
export const NoProfiles: Story = { args: { model: { ...model, profiles: [] } } };
export const WaitingForPermission: Story = {
  args: {
    model: {
      ...model,
      status: 'waiting_permission',
      record: {
        ...model.record,
        profileId: 'configured-agent',
        sessionId: 'agent-session',
        agentName: '我的 Agent',
        canLoad: true,
        messages: [
          { id: 'question', role: 'user', text: model.draft },
          { id: 'response', role: 'agent', text: '我会先查看现有参数处理，再补充筛选。' },
          { id: 'tool', role: 'tool', text: '读取 src/orders.ts\n工作区：/projects/orders-2', status: 'completed' },
        ],
      },
      permissions: [
        {
          id: 'permission-1',
          title: '更新订单参数处理',
          detail: '修改 /projects/orders-2/src/orders.ts\n增加可选的 status 查询参数。',
          options: [
            { id: 'once', kind: 'allow_once', label: '允许本次操作' },
            { id: 'reject', kind: 'reject_once', label: '拒绝本次操作' },
          ],
        },
      ],
    },
  },
};
export const Interrupted: Story = {
  args: {
    model: {
      ...model,
      status: 'error',
      error: 'Agent 连接已断开。请检查 Agent 登录状态后继续会话。',
      record: {
        ...model.record,
        profileId: 'configured-agent',
        sessionId: 'agent-session',
        canLoad: true,
        interrupted: true,
        messages: [{ id: 'uncertain', role: 'user', text: model.draft, uncertain: true }],
      },
    },
  },
};
export const UnsupportedRestore: Story = {
  args: { model: { ...model, record: { ...model.record, profileId: 'configured-agent', sessionId: 'agent-session' } } },
};

export const SessionControls: Story = {
  args: {
    model: {
      ...model,
      status: 'connected',
      record: {
        ...model.record,
        profileId: 'configured-agent',
        sessionId: 'agent-session',
        messages: [
          { id: 'thought', role: 'thought', text: '先检查参数默认值与调用位置。' },
          { id: 'answer', role: 'agent', text: '已找到需要调整的参数入口。' },
        ],
      },
      controls: {
        configuring: false,
        configOptions: [
          {
            id: 'model',
            name: '模型',
            type: 'select',
            currentValue: 'fast',
            category: 'model',
            options: [
              { value: 'fast', name: '快速', group: '常用模型' },
              { value: 'deep', name: '深入', group: '常用模型' },
            ],
          },
          { id: 'thinking', name: '显示思考', type: 'boolean', currentValue: false },
        ],
        commands: [{ name: 'explain', description: '解释选中内容', inputHint: '问题或路径' }],
        usage: { used: 1200, size: 8000, cost: { amount: 0.02, currency: 'USD' } },
        title: '订单参数兼容性',
        notices: [{ id: 'notice', title: '当前模型使用有限上下文', severity: 'info' }],
      },
    },
  },
};

export const LegacyModes: Story = {
  args: {
    model: {
      ...SessionControls.args!.model!,
      controls: {
        configuring: false,
        commands: [],
        notices: [],
        modes: {
          currentModeId: 'ask',
          availableModes: [
            { id: 'ask', name: '询问' },
            { id: 'code', name: '编码', description: '允许 Agent 使用自己的工具修改工作区' },
          ],
        },
      },
    },
  },
};
