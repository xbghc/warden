import { fn } from 'storybook/test';
import type { Comment, Issue, Todo } from '@warden/shared';
import { parseTargetKey } from '@warden/shared';
import { useStore, type AppStore } from '../src/store';

const timestamp = '2026-09-11T02:00:00.000Z';
export function demoComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1', targetKey: 'working', filePath: 'src/App.tsx', side: 'new', startLine: 12, endLine: 13,
    codeSnippet: ['const total = items.reduce((sum, item) => sum + item.price, 0);'],
    body: '请复用 **calcTotal**，确保折扣计算一致。', status: 'active',
    anchor: { hunkHash: 'demo', lineHashes: [], contextBefore: [], contextAfter: [], hunkLineOffset: 0 },
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

/** Shared in-memory fixtures. Every API-backed action reachable from these stories is mocked. */
export function setupDemoStore() {
  const comments = [
    demoComment(),
    demoComment({ id: 'comment-2', startLine: 25, endLine: 25, body: '请补充空列表的测试。', status: 'exported', exportedAt: timestamp }),
    demoComment({ id: 'comment-3', filePath: 'src/utils/total.ts', body: '请补充金额舍入的边界测试。', status: 'orphaned' }),
  ];
  const issues: Issue[] = [
    { id: 'issue-1', title: '统一金额计算逻辑', body: '复用 `calcTotal`，并补充边界情况测试。', status: 'open', commentIds: ['comment-1'], createdAt: timestamp, updatedAt: timestamp },
    { id: 'issue-2', title: '空列表状态', body: '已补充占位提示。', status: 'closed', commentIds: [], createdAt: timestamp, updatedAt: timestamp },
  ];
  const todos: Todo[] = [
    { id: 'todo-1', branch: 'main', title: '补充空列表测试', body: '- [ ] 空列表\n- [ ] 折扣金额', status: 'open', createdAt: timestamp, updatedAt: timestamp },
    { id: 'todo-2', branch: 'main', title: '检查键盘操作', body: '已验证 Tab 和 Enter。', status: 'done', createdAt: timestamp, updatedAt: timestamp },
    { id: 'todo-3', branch: 'feature/review', title: '完善评论导出', body: '保留文件名和行号。', status: 'open', createdAt: timestamp, updatedAt: timestamp },
  ];
  let sequence = 0;
  const changeTarget = async (targetKey: string) => {
    useStore.setState({ targetKey, root: parseTargetKey(targetKey).worktree ?? '/workspace/warden' });
  };
  useStore.setState({
    root: '/workspace/warden', activeFile: 'src/App.tsx', comments, allComments: comments, issues, todos,
    repo: {
      root: '/workspace/warden', commonRoot: '/workspace/warden', branch: 'main', head: 'abc1234', defaultTarget: 'working',
      worktrees: [
        { path: '/workspace/warden', head: 'abc1234', branch: 'main', isMain: true, detached: false, bare: false },
        { path: '/workspace/warden-review', head: 'def5678', branch: 'feature/review', isMain: false, detached: false, bare: false },
      ],
    },
    nvim: { root: '/workspace/warden', nvimAvailable: true, selected: '/tmp/nvim.42.0', instances: [{ socket: '/tmp/nvim.42.0', cwd: '/workspace/warden', pid: 42 }], scannedAt: timestamp },
    lastRefreshAt: timestamp,
    setTarget: fn(changeTarget), switchView: fn(changeTarget),
    setPanel: fn<AppStore['setPanel']>((panel) => useStore.setState({ panel })),
    setViewMode: fn<AppStore['setViewMode']>((viewMode) => useStore.setState((s) => ({ prefs: { ...s.prefs, viewMode } }))),
    setAutoRefresh: fn<AppStore['setAutoRefresh']>((autoRefresh) => useStore.setState((s) => ({ prefs: { ...s.prefs, autoRefresh } }))),
    refresh: fn(async () => { useStore.setState({ lastRefreshAt: new Date().toISOString() }); }),
    scanNvim: fn(async () => {}),
    selectNvim: fn<AppStore['selectNvim']>(async (selected) => { useStore.setState((s) => ({ nvim: s.nvim ? { ...s.nvim, selected } : null })); }),
    focusComment: fn<AppStore['focusComment']>(async (focusedCommentId) => { useStore.setState({ focusedCommentId }); }),
    jumpToComment: fn<AppStore['jumpToComment']>(async (comment) => { useStore.setState({ activeFile: comment.filePath, focusedCommentId: comment.id, panel: 'diff' }); }),
    createComment: fn<AppStore['createComment']>(async (request) => {
      const comment = demoComment({ ...request, id: `new-comment-${++sequence}`, targetKey: useStore.getState().targetKey });
      useStore.setState((s) => ({ comments: [...s.comments, comment], editor: null }));
      return comment;
    }),
    updateComment: fn<AppStore['updateComment']>(async (id, patch) => {
      useStore.setState((s) => ({ comments: s.comments.map((c) => c.id === id ? { ...c, ...patch } : c) }));
      return useStore.getState().comments.find((c) => c.id === id);
    }),
    deleteComment: fn<AppStore['deleteComment']>(async (id) => { useStore.setState((s) => ({ comments: s.comments.filter((c) => c.id !== id), selectedCommentIds: s.selectedCommentIds.filter((x) => x !== id) })); }),
    exportComments: fn(async () => {}), copyAllComments: fn(async () => {}),
    loadIssues: fn(async () => {}), loadTodos: fn(async () => {}),
    exportIssue: fn(async () => {}), exportTodos: fn(async () => {}),
    createIssue: fn<AppStore['createIssue']>(async (request) => {
      const issue: Issue = { ...request, body: request.body ?? '', commentIds: request.commentIds ?? [], id: `new-issue-${++sequence}`, status: 'open', createdAt: timestamp, updatedAt: timestamp };
      useStore.setState((s) => ({ issues: [...s.issues, issue], selectedCommentIds: [] }));
      return issue;
    }),
    updateIssue: fn<AppStore['updateIssue']>(async (id, patch) => { useStore.setState((s) => ({ issues: s.issues.map((i) => i.id === id ? { ...i, ...patch } : i) })); }),
    deleteIssue: fn<AppStore['deleteIssue']>(async (id) => { useStore.setState((s) => ({ issues: s.issues.filter((i) => i.id !== id) })); }),
    createTodo: fn<AppStore['createTodo']>(async (request) => {
      const todo: Todo = { ...request, body: request.body ?? '', branch: request.branch ?? 'main', id: `new-todo-${++sequence}`, status: 'open', createdAt: timestamp, updatedAt: timestamp };
      useStore.setState((s) => ({ todos: [...s.todos, todo] }));
      return todo;
    }),
    updateTodo: fn<AppStore['updateTodo']>(async (id, patch) => { useStore.setState((s) => ({ todos: s.todos.map((t) => t.id === id ? { ...t, ...patch } : t) })); }),
    deleteTodo: fn<AppStore['deleteTodo']>(async (id) => { useStore.setState((s) => ({ todos: s.todos.filter((t) => t.id !== id) })); }),
  });
}
