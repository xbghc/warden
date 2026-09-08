import type {
  Comment,
  CommentSide,
  CommitsResponse,
  CreateCommentRequest,
  CreateIssueRequest,
  CreateTodoRequest,
  ExportResponse,
  FileDiff,
  FilesResponse,
  FullFileResponse,
  Issue,
  NvimInstancesResponse,
  Prefs,
  ReanchorResponse,
  RepoInfo,
  ReviewState,
  TargetKey,
  Todo,
  TodosResponse,
  UpdateCommentRequest,
  UpdateIssueRequest,
  UpdateTodoRequest,
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
  repo: () => req<RepoInfo>('GET', '/api/repo'),
  state: () => req<ReviewState>('GET', '/api/state'),
  patchPrefs: (prefs: Partial<Prefs>) => req<Prefs>('PATCH', '/api/prefs', prefs),

  files: (key: TargetKey) => req<FilesResponse>('GET', `/api/targets/${enc(key)}/files`),
  file: (key: TargetKey, path: string, hints: { oldPath?: string; untracked?: boolean } = {}) =>
    req<FileDiff>('GET', `/api/targets/${enc(key)}/file${q({ path, old: hints.oldPath, untracked: hints.untracked })}`),
  fullFile: (key: TargetKey, path: string, side: CommentSide) =>
    req<FullFileResponse>('GET', `/api/targets/${enc(key)}/file/full${q({ path, side })}`),
  setViewed: (key: TargetKey, path: string, viewed: boolean, contentHash: string) =>
    req<{ viewed: Record<string, string> }>('PUT', `/api/targets/${enc(key)}/viewed`, { path, viewed, contentHash }),

  createComment: (key: TargetKey, body: CreateCommentRequest) => req<Comment>('POST', `/api/targets/${enc(key)}/comments`, body),
  updateComment: (key: TargetKey, id: string, body: UpdateCommentRequest) =>
    req<Comment>('PATCH', `/api/targets/${enc(key)}/comments/${enc(id)}`, body),
  deleteComment: (key: TargetKey, id: string) => req<{ ok: true }>('DELETE', `/api/targets/${enc(key)}/comments/${enc(id)}`),
  reanchor: (key: TargetKey, files?: FileDiff[]) => req<ReanchorResponse>('POST', `/api/targets/${enc(key)}/comments/reanchor`, { files }),
  exportComments: (commentIds: string[]) => req<ExportResponse>('POST', '/api/comments/export', { commentIds }),

  issues: () => req<{ issues: Issue[] }>('GET', '/api/issues'),
  createIssue: (body: CreateIssueRequest) => req<Issue>('POST', '/api/issues', body),
  updateIssue: (id: string, body: UpdateIssueRequest) => req<Issue>('PATCH', `/api/issues/${enc(id)}`, body),
  deleteIssue: (id: string) => req<{ ok: true }>('DELETE', `/api/issues/${enc(id)}`),
  exportIssue: (id: string) => req<ExportResponse>('POST', `/api/issues/${enc(id)}/export`),

  todos: (branch?: string) => req<TodosResponse>('GET', `/api/todos${q({ branch })}`),
  createTodo: (body: CreateTodoRequest) => req<Todo>('POST', '/api/todos', body),
  updateTodo: (id: string, body: UpdateTodoRequest) => req<Todo>('PATCH', `/api/todos/${enc(id)}`, body),
  deleteTodo: (id: string) => req<{ ok: true }>('DELETE', `/api/todos/${enc(id)}`),

  /** Server-sent stream of repository changes for one worktree root. Caller owns `close()`. */
  events: (root: string) => new EventSource(`/api/events${q({ root })}`),

  commits: (params: { path?: string; q?: string; author?: string; firstParent?: boolean; offset?: number; limit?: number; root?: string; ref?: string }) =>
    req<CommitsResponse>('GET', `/api/commits${q(params)}`),

  nvimInstances: (root: string, rescan = false) => req<NvimInstancesResponse>('GET', `/api/nvim/instances${q({ root, rescan })}`),
  nvimSelect: (root: string, socket: string) => req<{ ok: true }>('POST', '/api/nvim/select', { root, socket }),
  nvimOpen: (socket: string, absPath: string, line: number) => req<{ ok: true }>('POST', '/api/nvim/open', { socket, absPath, line }),
};
