import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import type { AcpMessage, AcpModel } from '@warden/shared';
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
      baseBranch: 'feature/orders',
      identity: 'orders-filter-allocation',
    },
    canLoad: false,
    messages: [],
    updatedAt: '2026-10-25T00:00:00Z',
  },
  profiles: [{ id: 'configured-agent', label: '我的 Agent' }],
  defaultProfileId: 'configured-agent',
  status: 'disconnected',
  sending: false,
  transcript: { epoch: 0, sequence: 0 },
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
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AcpApp>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewConversation: Story = { args: { model: { ...model, status: 'connecting' } } };
export const UnreportedToolOutcome: Story = {
  args: {
    model: {
      ...model,
      status: 'connected',
      draft: '',
      record: {
        ...model.record,
        messages: [
          { id: 'cancelled-user', role: 'user', text: 'Run the preview checks.', status: 'Turn cancelled' },
          { id: 'unfinished-tool', role: 'tool', text: 'Run preview checks\nLint passed. Starting tests…', status: 'in_progress', uncertain: true },
        ],
      },
    },
  },
};
export const Resuming: Story = {
  args: {
    model: {
      ...model,
      status: 'connecting',
      record: {
        ...model.record,
        profileId: 'configured-agent',
        sessionId: 'agent-session',
        canLoad: true,
        messages: [{ id: 'previous-reply', role: 'agent', text: '已找到需要调整的参数入口。' }],
      },
    },
  },
};
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
      error: 'The agent disconnected. Check its authentication state before resuming.',
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
export const AuthenticationRequired: Story = {
  args: {
    model: {
      ...model,
      status: 'error',
      error: 'The agent requires authentication. Choose a supported method, or log in externally and reconnect.',
      authMethods: [{ id: 'chat-gpt', name: 'ChatGPT', description: 'Sign in with ChatGPT' }],
    },
  },
};
export const ConnectionFailed: Story = {
  args: { model: { ...model, status: 'error', error: 'Opening the agent session timed out. Reconnect to try again.' } },
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
            id: 'mode',
            name: 'Mode',
            type: 'select',
            currentValue: 'code',
            category: 'mode',
            options: [
              { value: 'ask', name: 'Ask' },
              { value: 'code', name: 'Code' },
            ],
          },
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'fast',
            category: 'model',
            options: [
              { value: 'fast', name: 'Fast', group: 'Available models' },
              { value: 'deep', name: 'Deep', group: 'Available models' },
            ],
          },
          {
            id: 'effort',
            name: 'Effort',
            category: 'thought_level',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
          { id: 'thinking', name: '显示思考', type: 'boolean', currentValue: false },
        ],
        commands: [
          { name: 'explain', description: '解释选中内容', inputHint: '问题或路径' },
          { name: 'review', description: 'Review the current changes' },
        ],
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

export const Sidebar: Story = {
  args: { model: { ...model, status: 'connected', draft: '', presentation: 'sidebar' } },
  decorators: [
    (Story) => (
      <div style={{ width: '100%', maxWidth: 320 }}>
        <Story />
      </div>
    ),
  ],
};

export const SidebarPermission: Story = {
  ...Sidebar,
  args: { model: { ...WaitingForPermission.args!.model!, presentation: 'sidebar' } },
};

const longPermissionCommand = `printf "approved\\n" > /tmp/${'acceptance-'.repeat(12)}marker.txt`;
export const SidebarLongPermission: Story = {
  ...SidebarPermission,
  args: {
    model: {
      ...SidebarPermission.args!.model!,
      permissions: [
        {
          id: 'long-permission',
          title: 'Run command',
          detail: JSON.stringify({ command: JSON.stringify(longPermissionCommand), cwd: '/projects/orders-2' }, null, 2),
          command: JSON.stringify(longPermissionCommand),
          cwd: '/projects/orders-2',
          reason: 'Write a disposable acceptance marker.',
          options: [
            { id: 'once', kind: 'allow_once', label: 'Yes, proceed' },
            {
              id: 'always',
              kind: 'allow_always',
              label: `Yes, and don't ask again for commands that start with \`printf approved > /tmp/${'acceptance-'.repeat(12)}marker.txt\``,
            },
            { id: 'reject', kind: 'reject_once', label: 'No, and tell the agent what to do differently' },
          ],
        },
      ],
    },
  },
};

export const SidebarCommandOutcomes: Story = {
  ...Sidebar,
  args: {
    model: {
      ...Sidebar.args!.model!,
      record: {
        ...model.record,
        messages: [
          { id: 'diff', role: 'tool', text: 'git diff --no-index before.txt after.txt\nExit code: 1\n+ Added line', status: 'failed', exitCode: 1 },
          { id: 'test', role: 'tool', text: 'Run tests\nExit code: 0\nAll tests passed.', status: 'completed', exitCode: 0 },
          { id: 'signal', role: 'tool', text: 'Run development server\nSignal: SIGTERM', status: 'failed', exitSignal: 'SIGTERM' },
        ],
      },
    },
  },
};

export const SidebarComposer: Story = {
  ...Sidebar,
  args: { model: { ...SessionControls.args!.model!, presentation: 'sidebar', draft: '' } },
};

export const SidebarSlashCommands: Story = {
  ...SidebarComposer,
  args: { model: { ...SidebarComposer.args!.model!, draft: '/' } },
};

export const ApplyingConfiguration: Story = {
  ...Sidebar,
  args: {
    model: {
      ...SidebarComposer.args!.model!,
      controls: { ...SessionControls.args!.model!.controls!, configuring: true },
    },
  },
};

export const SidebarResponding: Story = {
  ...SidebarComposer,
  args: { model: { ...SidebarComposer.args!.model!, status: 'running', sending: true } },
};

export const SidebarLongSelectors: Story = {
  ...SidebarComposer,
  args: {
    model: {
      ...SidebarComposer.args!.model!,
      controls: {
        ...SessionControls.args!.model!.controls!,
        configOptions: SessionControls.args!.model!.controls!.configOptions!.map((option) =>
          option.type === 'select'
            ? { ...option, options: option.options.map((value) => ({ ...value, name: `${value.name} with a long agent-provided label` })) }
            : option,
        ),
      },
    },
  },
};

export const SidebarGroupedModels: Story = {
  ...SidebarComposer,
  args: {
    model: {
      ...SidebarComposer.args!.model!,
      controls: {
        ...SessionControls.args!.model!.controls!,
        configOptions: SessionControls.args!.model!.controls!.configOptions!.map((option) =>
          option.id === 'model'
            ? {
                ...option,
                options: [
                  { value: 'fast', name: 'Fast model with extended context', group: 'Recommended', description: 'For everyday changes and quick feedback.' },
                  { value: 'deep', name: 'Reasoning model for large codebases', group: 'Other models', description: 'For longer investigations across files.' },
                ],
              }
            : option,
        ),
      },
    },
  },
};

export const SidebarManyModels: Story = {
  ...SidebarGroupedModels,
  args: {
    model: {
      ...SidebarGroupedModels.args!.model!,
      controls: {
        ...SidebarGroupedModels.args!.model!.controls!,
        configOptions: SidebarGroupedModels.args!.model!.controls!.configOptions!.map((option) =>
          option.id === 'model' && option.type === 'select'
            ? {
                ...option,
                options: [
                  ...option.options,
                  ...Array.from({ length: 30 }, (_, index) => ({ value: `model-${index}`, name: `Workspace model ${index + 1}`, group: 'More models' })),
                ],
              }
            : option,
        ),
      },
    },
  },
};

export const SidebarLongHistory: Story = {
  ...Sidebar,
  args: {
    model: {
      ...SessionControls.args!.model!,
      presentation: 'sidebar',
      record: {
        ...SessionControls.args!.model!.record,
        messages: Array.from({ length: 30 }, (_, index) => ({
          id: `message-${index}`,
          role: index % 2 ? 'agent' : 'user',
          text:
            index % 2
              ? 'The filter now preserves the existing pagination behavior. Review src/orders.ts before running the preview tests.'
              : 'Keep the existing pagination defaults when no filter is supplied.',
        })),
      },
    },
  },
};

export const GroupedActivity: Story = {
  ...Sidebar,
  args: {
    model: {
      ...SessionControls.args!.model!,
      presentation: 'sidebar',
      record: {
        ...model.record,
        messages: [
          { id: 'request', role: 'user', text: 'Add filtering and check the result.' },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `tool-${index}`,
            role: 'tool' as const,
            text: `Inspect file ${index + 1}\nFile contents`,
            status: 'completed',
          })),
          { id: 'failure', role: 'tool', text: 'One check needs attention\nTest output', status: 'failed' },
          { id: 'reply', role: 'agent', text: 'Review [the implementation](src/orders.ts#L12) and [its tests](/projects/orders-2/test/orders.ts:8).' },
        ],
      },
    },
  },
};

export const FormattedReply: Story = {
  ...Sidebar,
  args: {
    model: {
      ...SessionControls.args!.model!,
      presentation: 'sidebar',
      draft: '',
      record: {
        ...SessionControls.args!.model!.record,
        messages: [
          { id: 'request', role: 'user', text: '检查分页默认值，并解释修改。' },
          { id: 'read', role: 'tool', text: 'Read src/orders.ts\nExisting pagination defaults are page=1 and limit=20.', status: 'completed' },
          {
            id: 'answer',
            role: 'agent',
            text: '## 保留现有默认值\n\n未传筛选条件时，旧调用方式保持兼容。\n\n- `page` 默认是 **1**。\n- `limit` 默认是 **20**。\n\n```ts\nconst page = input.page ?? 1;\nconst limit = input.limit ?? 20;\n```\n\n| 参数 | 默认值 |\n| --- | --- |\n| page | 1 |\n| limit | 20 |\n\n可以先查看任务 Diff，再运行预览测试。',
          },
        ],
      },
    },
  },
};

export const WritingFollowUp: Story = {
  ...Sidebar,
  args: {
    model: {
      ...SessionControls.args!.model!,
      presentation: 'sidebar',
      status: 'running',
      sending: true,
      draft: '接下来补充一个回归测试。',
      draftRevision: 1,
      submittedDraft: { version: 0, revision: 0 },
      record: {
        ...SessionControls.args!.model!.record,
        messages: [
          { id: 'request', role: 'user', text: '检查分页默认值。', uncertain: true, status: 'Sending' },
          { id: 'progress', role: 'agent', text: '正在检查现有调用，保留未传参数时的行为。' },
          { id: 'read', role: 'tool', text: 'Read src/orders.ts\nInspecting pagination defaults.', status: 'in_progress' },
        ],
      },
    },
  },
};

/**
 * A scripted turn played against the real component: prompt, thoughts, tools that run, finish and
 * fail, a permission request, then a streamed reply. Static stories cannot show scroll following,
 * layout shifts between tool states or the fold of finished activity; this one loops so they can be watched.
 */
const reply = [
  '## 保留现有默认值\n\n',
  '未传筛选条件时，旧调用方式保持兼容。\n\n',
  '- `page` 默认是 **1**。\n',
  '- `limit` 默认是 **20**。\n\n',
  '```ts\nconst page = input.page ?? 1;\n',
  'const limit = input.limit ?? 20;\n```\n\n',
  '筛选参数 `status` 是可选的，',
  '未提供时不改变查询结果。',
  '失败的那项检查来自一个与本次改动无关的快照，',
  '可以先查看任务 Diff，再运行预览测试。',
];
type Frame = { after: number; change(model: AcpModel): AcpModel };
const withMessages = (model: AcpModel, change: (messages: AcpMessage[]) => AcpMessage[]): AcpModel => ({
  ...model,
  record: { ...model.record, messages: change(model.record.messages) },
});
const tool = (id: string, title: string, outcome: Partial<AcpMessage>, runs = 900): Frame[] => [
  { after: 350, change: (model) => withMessages(model, (rows) => [...rows, { id, role: 'tool', text: `${title}\nRunning…`, status: 'in_progress' }]) },
  {
    after: runs,
    change: (model) => withMessages(model, (rows) => rows.map((row) => (row.id === id ? { ...row, text: `${title}\nOutput of ${title}`, ...outcome } : row))),
  },
];
const turn: Frame[] = [
  {
    after: 800,
    change: (model) => ({
      ...withMessages(model, (rows) => [...rows, { id: 'live-request', role: 'user', text: '检查分页默认值，并解释修改。' }]),
      status: 'running',
      sending: true,
      draft: '',
    }),
  },
  { after: 500, change: (model) => withMessages(model, (rows) => [...rows, { id: 'live-thought', role: 'thought', text: '先检查参数默认值与调用位置。' }]) },
  ...tool('live-read', 'Read src/orders.ts', { status: 'completed' }),
  ...tool('live-search', 'Search for listOrders callers', { status: 'completed' }, 600),
  ...tool('live-tests', 'pnpm test orders', { status: 'failed', exitCode: 1 }, 1800),
  {
    after: 400,
    change: (model) => ({
      ...model,
      status: 'waiting_permission',
      permissions: [
        {
          id: 'live-permission',
          title: 'Run command',
          detail: JSON.stringify({ command: 'pnpm test orders --update', cwd: '/projects/orders-2' }, null, 2),
          command: 'pnpm test orders --update',
          cwd: '/projects/orders-2',
          options: [
            { id: 'once', kind: 'allow_once', label: 'Yes, proceed' },
            { id: 'always', kind: 'allow_always', label: "Yes, and don't ask again for `pnpm test`" },
            { id: 'reject', kind: 'reject_once', label: 'No, and tell the agent what to do differently' },
          ],
        },
      ],
    }),
  },
  { after: 3000, change: (model) => ({ ...model, status: 'running', permissions: [] }) },
  ...tool('live-update', 'pnpm test orders --update', { status: 'completed', exitCode: 0 }, 1200),
  ...reply.map(
    (_, index): Frame => ({
      after: index ? 220 : 500,
      change: (model) =>
        withMessages(model, (rows) => [
          ...rows.filter((row) => row.id !== 'live-reply'),
          { id: 'live-reply', role: 'agent', text: reply.slice(0, index + 1).join('') },
        ]),
    }),
  ),
  { after: 400, change: (model) => ({ ...model, status: 'connected', sending: false }) },
];

function Replay({ start, send }: { start: AcpModel; send(action: never): void }) {
  const [current, setCurrent] = useState(start);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let step = 0;
    const next = () => {
      const frame = turn[step++];
      if (!frame) {
        // Rest on the finished turn, then play it again from the starting transcript.
        timer = setTimeout(() => {
          step = 0;
          setCurrent(start);
          next();
        }, 5000);
        return;
      }
      timer = setTimeout(() => {
        setCurrent(frame.change);
        next();
      }, frame.after);
    };
    next();
    return () => clearTimeout(timer);
  }, [start]);
  return <AcpApp model={current} send={send} />;
}

export const LiveTurn: Story = {
  ...Sidebar,
  args: { model: { ...SessionControls.args!.model!, presentation: 'sidebar', draft: '', record: { ...SessionControls.args!.model!.record, messages: [] } } },
  render: ({ model: start, send }) => <Replay start={start} send={send} />,
};

export const LiveTurnAfterLongHistory: Story = {
  ...LiveTurn,
  args: { model: { ...SidebarLongHistory.args!.model!, draft: '' } },
};
