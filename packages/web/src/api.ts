import type {
  PreviewResponse,
  RebaseResponse,
  RebaseBatchRequest,
  RebaseBatchResponse,
  HistoryResponse,
  HistoryPreviewRequest,
  HistoryPreviewResponse,
  WorkspaceConfig,
  WorkflowResponse,
  DevelopmentChange,
  WorkflowTask,
  StartChangeRequest,
  UpdateChangeRequest,
  CreateChangeRequest,
  PrepareChangeRequest,
  AcceptChangeRequest,
  CheckpointsResponse,
  Comment,
  CommentSide,
  CommitsResponse,
  CreateCheckpointResponse,
  CreateCommentRequest,
  CreateTodoRequest,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  ExportResponse,
  FileDiff,
  FilesResponse,
  ForkPointResponse,
  FullFileResponse,
  Prefs,
  ReanchorResponse,
  ReleaseWorktreeRequest,
  ReleaseWorktreeResponse,
  RemoteBranchesResponse,
  RemoveWorktreeRequest,
  RemoveWorktreeResponse,
  RepoInfo,
  ReviewState,
  TargetKey,
  Todo,
  TodosResponse,
  UpdateCommentRequest,
  UpdateNotice,
  UpdateTodoRequest,
  WorktreesResponse,
} from '@warden/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; code?: string };
    throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code);
  }
  return data as T;
}

const enc = encodeURIComponent;
const q = (params: Record<string, string | number | boolean | undefined>): string => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    parts.push(`${enc(k)}=${enc(v === true ? '1' : String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
};

export const api = {
  preview: () => req<PreviewResponse>('GET', '/api/preview'),
  connectPreview: (connectedIds: string[]) => req<PreviewResponse>('PUT', '/api/preview', { connectedIds }),
  refreshPreview: () => req<PreviewResponse>('POST', '/api/preview/refresh', {}),
  rebaseChecks: () => req<RebaseResponse>('GET', '/api/workflow/rebase-checks'),
  rebaseWorkspaces: (body: RebaseBatchRequest) => req<RebaseBatchResponse>('POST', '/api/workflow/rebase', body),
  history: () => req<HistoryResponse>('GET', '/api/history'),
  previewHistory: (body: HistoryPreviewRequest) => req<HistoryPreviewResponse>('POST', '/api/history/preview', body),
  applyHistory: (id: string, head: string) => req<HistoryResponse>('POST', '/api/history/apply', { id, head }),
  saveWorkspaceConfig: (body: WorkspaceConfig) => req<WorkspaceConfig>('PUT', '/api/workspace/config', body),
  retryWorkspaceHook: (id: string) => req<DevelopmentChange>('POST', `/api/workflow/changes/${enc(id)}/hook`),
  workflow: () => req<WorkflowResponse>('GET', '/api/workflow'),
  configureWorkflow: (developmentBranch: string) => req<WorkflowResponse>('PUT', '/api/workflow', { developmentBranch }),
  createChange: (body: CreateChangeRequest) => req<WorkflowTask>('POST', '/api/workflow/changes', body),
  updateChange: (id: string, body: UpdateChangeRequest) => req<WorkflowTask>('PATCH', `/api/workflow/changes/${enc(id)}`, body),
  startChange: (id: string, body: StartChangeRequest) => req<DevelopmentChange>('POST', `/api/workflow/changes/${enc(id)}/start`, body),
  moveChange: (id: string, before: string | null) => req<WorkflowResponse>('POST', `/api/workflow/changes/${enc(id)}/move`, { before }),
  importTodo: (id: string) => req<WorkflowResponse>('POST', `/api/workflow/import-todos/${enc(id)}`),
  syncChange: (id: string, sourceHead: string) => req<DevelopmentChange>('POST', `/api/workflow/changes/${enc(id)}/sync`, { sourceHead }),
  prepareChange: (id: string, body: PrepareChangeRequest) => req<DevelopmentChange>('POST', `/api/workflow/changes/${enc(id)}/prepare`, body),
  acceptChange: (id: string, body: AcceptChangeRequest) => req<DevelopmentChange>('POST', `/api/workflow/changes/${enc(id)}/accept`, body),
  repo: () => req<RepoInfo>('GET', '/api/repo'),
  state: () => req<ReviewState>('GET', '/api/state'),
  update: () => req<UpdateNotice | null>('GET', '/api/update'),
  patchPrefs: (prefs: Partial<Prefs>) => req<Prefs>('PATCH', '/api/prefs', prefs),

  files: (key: TargetKey) => req<FilesResponse>('GET', `/api/targets/${enc(key)}/files`),
  file: (key: TargetKey, path: string, hints: { oldPath?: string; untracked?: boolean } = {}) =>
    req<FileDiff>('GET', `/api/targets/${enc(key)}/file${q({ path, old: hints.oldPath, untracked: hints.untracked })}`),
  fullFile: (key: TargetKey, path: string, side: CommentSide) => req<FullFileResponse>('GET', `/api/targets/${enc(key)}/file/full${q({ path, side })}`),
  setViewed: (key: TargetKey, path: string, viewed: boolean, contentHash: string) =>
    req<{ viewed: Record<string, string> }>('PUT', `/api/targets/${enc(key)}/viewed`, { path, viewed, contentHash }),

  checkpoints: (key: TargetKey) => req<CheckpointsResponse>('GET', `/api/targets/${enc(key)}/checkpoints`),
  createCheckpoint: (key: TargetKey) => req<CreateCheckpointResponse>('POST', `/api/targets/${enc(key)}/checkpoints`),
  deleteCheckpoint: (key: TargetKey, id: number) => req<{ ok: true }>('DELETE', `/api/targets/${enc(key)}/checkpoints/${id}`),

  createComment: (key: TargetKey, body: CreateCommentRequest) => req<Comment>('POST', `/api/targets/${enc(key)}/comments`, body),
  updateComment: (key: TargetKey, id: string, body: UpdateCommentRequest) => req<Comment>('PATCH', `/api/targets/${enc(key)}/comments/${enc(id)}`, body),
  comments: (key: TargetKey) => req<{ comments: Comment[] }>('GET', `/api/targets/${enc(key)}/comments`),
  replyComment: (key: TargetKey, id: string, body: string) => req<Comment>('POST', `/api/targets/${enc(key)}/comments/${enc(id)}/replies`, { body }),
  deleteComment: (key: TargetKey, id: string) => req<{ ok: true }>('DELETE', `/api/targets/${enc(key)}/comments/${enc(id)}`),
  reanchor: (key: TargetKey, files?: FileDiff[]) => req<ReanchorResponse>('POST', `/api/targets/${enc(key)}/comments/reanchor`, { files }),
  exportComments: (commentIds: string[], preview = false) => req<ExportResponse>('POST', '/api/comments/export', { commentIds, preview }),

  todos: (branch?: string) => req<TodosResponse>('GET', `/api/todos${q({ branch })}`),
  createTodo: (body: CreateTodoRequest) => req<Todo>('POST', '/api/todos', body),
  updateTodo: (id: string, body: UpdateTodoRequest) => req<Todo>('PATCH', `/api/todos/${enc(id)}`, body),
  exportTodo: (id: string, preview = false) => req<ExportResponse>('POST', `/api/todos/${enc(id)}/export`, { preview }),
  deleteTodo: (id: string) => req<{ ok: true }>('DELETE', `/api/todos/${enc(id)}`),
  moveTodo: (id: string, before: string | null) => req<TodosResponse>('POST', `/api/todos/${enc(id)}/move`, { before }),

  /** Server-sent stream of repository changes for one worktree root. Caller owns `close()`. */
  events: (root: string) => new EventSource(`/api/events${q({ root })}`),

  commits: (params: { path?: string; q?: string; author?: string; firstParent?: boolean; offset?: number; limit?: number; root?: string; ref?: string }) =>
    req<CommitsResponse>('GET', `/api/commits${q(params)}`),
  forkPoint: (params: { root?: string; base: string }) => req<ForkPointResponse>('GET', `/api/fork-point${q(params)}`),

  worktrees: () => req<WorktreesResponse>('GET', '/api/worktrees'),
  /** `slot`: a clone slot, whose remote branches are its own; omitted, the main worktree's. */
  remoteBranches: (branch: string, slot?: number) => req<RemoteBranchesResponse>('GET', `/api/worktrees/remotes${q({ branch, slot })}`),
  createWorktree: (body: CreateWorktreeRequest) => req<CreateWorktreeResponse>('POST', '/api/worktrees', body),
  releaseWorktree: (body: ReleaseWorktreeRequest) => req<ReleaseWorktreeResponse>('POST', '/api/worktrees/release', body),
  removeWorktree: (body: RemoveWorktreeRequest) => req<RemoveWorktreeResponse>('POST', '/api/worktrees/remove', body),
};
