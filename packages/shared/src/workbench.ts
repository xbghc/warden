import type {
  HistoryPreviewRequest,
  HistoryPreviewResponse,
  HistoryResponse,
  PreviewResponse,
  RebaseBatchResponse,
  RebaseResponse,
  WorkflowResponse,
  WorkflowTask,
  WorkspaceConfig,
} from './types.js';
import type { TaskReview } from './review.js';

export type Surface = 'task' | 'preview' | 'history' | 'settings' | 'rebase';
export interface WorkbenchError {
  scope: string;
  message: string;
  code?: string;
}
export interface WorkbenchModel {
  session: string;
  repository: string;
  surface: Surface;
  workflow?: WorkflowResponse;
  task?: WorkflowTask;
  creating: boolean;
  preview?: PreviewResponse;
  hasPreviewCommand: boolean;
  history?: HistoryResponse;
  historyDraft?: HistoryPreviewRequest;
  historyPreview?: HistoryPreviewResponse;
  checks?: RebaseResponse;
  rebaseResult?: RebaseBatchResponse;
  review?: TaskReview;
  reviewCurrent: boolean;
  message: string;
  busy?: string;
  errors: WorkbenchError[];
}

export type WorkbenchAction =
  | { type: 'setup.repository' | 'setup.branch' | 'settings.agents' }
  | { type: 'task.create'; title: string; body: string }
  | { type: 'task.update'; taskId: string; title: string; body: string }
  | { type: 'task.start'; taskId: string; kind: 'shared' | 'clone'; agent?: string }
  | { type: 'task.review' | 'task.hook' | 'task.resume' | 'task.copy' | 'task.brief' | 'task.restore' | 'task.chat'; taskId: string }
  | { type: 'task.deliver'; taskId: string; message: string }
  | { type: 'task.message'; taskId: string; message: string }
  | { type: 'preview.refresh' | 'preview.setup' | 'preview.terminal' | 'preview.run' | 'preview.copy' | 'rebase.check' | 'history.discard' }
  | { type: 'settings.save'; config: WorkspaceConfig }
  | { type: 'history.draft'; draft: HistoryPreviewRequest }
  | { type: 'history.preview'; draft: HistoryPreviewRequest }
  | { type: 'history.apply'; id: string; head: string }
  | { type: 'rebase.run'; items: { changeId: string; sourceHead: string; developmentHead: string }[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('操作参数格式错误');
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 10000): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('操作文本格式错误');
  return value;
}
function identity(value: unknown): string {
  const text = string(value, 300);
  if (!text) throw new Error('操作标识不能为空');
  return text;
}
function historyDraft(value: unknown): HistoryPreviewRequest {
  const draft = object(value);
  if (!Array.isArray(draft.commits) || !draft.commits.length || draft.commits.length > 100) throw new Error('历史范围必须包含 1–100 个提交');
  return {
    head: identity(draft.head),
    start: identity(draft.start),
    commits: draft.commits.map((entry) => {
      const commit = object(entry);
      return { sha: identity(commit.sha), message: string(commit.message) };
    }),
  };
}

/** Only this finite, validated vocabulary crosses the webview boundary. */
export function parseWorkbenchAction(value: unknown): WorkbenchAction {
  const action = object(value);
  switch (action.type) {
    case 'setup.repository':
    case 'setup.branch':
    case 'settings.agents':
      return { type: action.type };
    case 'task.create':
      return { type: action.type, title: string(action.title, 200), body: string(action.body) };
    case 'task.update':
      return { type: action.type, taskId: identity(action.taskId), title: string(action.title, 200), body: string(action.body) };
    case 'task.start':
      if (action.kind !== 'shared' && action.kind !== 'clone') throw new Error('工作区类型无效');
      if ('worktree' in action) throw new Error('工作区目录由 Warden 分配');
      return {
        type: action.type,
        taskId: identity(action.taskId),
        kind: action.kind,
        ...(action.agent === undefined ? {} : { agent: string(action.agent, 100) }),
      };
    case 'task.review':
    case 'task.hook':
    case 'task.resume':
    case 'task.copy':
    case 'task.brief':
    case 'task.restore':
    case 'task.chat':
      return { type: action.type, taskId: identity(action.taskId) };
    case 'task.message':
      return { type: action.type, taskId: identity(action.taskId), message: string(action.message) };
    case 'task.deliver':
      return { type: action.type, taskId: identity(action.taskId), message: string(action.message) };
    case 'preview.refresh':
    case 'preview.setup':
    case 'preview.terminal':
    case 'preview.run':
    case 'preview.copy':
    case 'rebase.check':
    case 'history.discard':
      return { type: action.type };
    case 'settings.save': {
      const config = object(action.config);
      const hooks = object(config.hooks);
      return { type: action.type, config: { hooks: { create: string(hooks.create), reuse: string(hooks.reuse) }, previewSetup: string(config.previewSetup) } };
    }
    case 'history.draft':
    case 'history.preview':
      return { type: action.type, draft: historyDraft(action.draft) };
    case 'history.apply':
      return { type: action.type, id: identity(action.id), head: identity(action.head) };
    case 'rebase.run':
      if (!Array.isArray(action.items) || action.items.length > 1000) throw new Error('同步范围无效');
      return {
        type: action.type,
        items: action.items.map((entry) => {
          const item = object(entry);
          // An unavailable workspace has no observed source head. Preserve its empty value
          // so the engine can report that selected item without aborting the other items.
          return { changeId: identity(item.changeId), sourceHead: string(item.sourceHead, 300), developmentHead: identity(item.developmentHead) };
        }),
      };
    default:
      throw new Error('未知界面操作');
  }
}
