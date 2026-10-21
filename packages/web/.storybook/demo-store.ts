import { fn } from 'storybook/test';
import type { Todo } from '@warden/shared';
import { parseTargetKey } from '@warden/shared';
import { branchOf, useStore, type AppStore } from '../src/store';

const timestamp = '2026-09-11T02:00:00.000Z';
/** Shared in-memory fixtures. Every API-backed action reachable from these stories is mocked. */
export function setupDemoStore() {
  const todos: Todo[] = [
    {
      id: 'todo-1',
      branch: 'main',
      title: '统一金额计算逻辑',
      body: '复用 `calcTotal`，并补充边界情况测试。',
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    { id: 'todo-2', branch: 'main', title: '检查键盘操作', body: '已验证 Tab 和 Enter。', status: 'done', createdAt: timestamp, updatedAt: timestamp },
    {
      id: 'todo-3',
      branch: 'feature/review',
      title: '完善文件位置复制',
      body: '保留文件名和行号。',
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  let sequence = 0;
  const changeTarget = async (targetKey: string, options?: { reveal?: boolean }) => {
    useStore.setState({
      targetKey,
      root: parseTargetKey(targetKey).worktree ?? '/workspace/warden',
      ...(options?.reveal === false ? {} : { panel: 'diff' as const }),
    });
  };
  useStore.setState({
    panel: 'diff',
    root: '/workspace/warden',
    activeFile: 'src/App.tsx',
    todos,
    repo: {
      root: '/workspace/warden',
      commonRoot: '/workspace/warden',
      branch: 'main',
      head: 'abc1234',
      defaultTarget: 'working',
      worktrees: [
        { path: '/workspace/warden', head: 'abc1234', branch: 'main', isMain: true, detached: false, bare: false },
        { path: '/workspace/warden-review', head: 'def5678', branch: 'feature/review', isMain: false, detached: false, bare: false },
      ],
    },
    lastRefreshAt: timestamp,
    deleteTodos: fn(async () => {}),
    moveTodo: fn(async () => {}),
    setTarget: fn(changeTarget),
    setPanel: fn<AppStore['setPanel']>((panel) => useStore.setState({ panel })),
    setViewMode: fn<AppStore['setViewMode']>((viewMode) => useStore.setState((s) => ({ prefs: { ...s.prefs, viewMode } }))),
    setAutoRefresh: fn<AppStore['setAutoRefresh']>((autoRefresh) => useStore.setState((s) => ({ prefs: { ...s.prefs, autoRefresh } }))),
    refresh: fn(async () => {
      useStore.setState({ lastRefreshAt: new Date().toISOString() });
    }),
    loadTodos: fn(async () => {}),
    copyTodo: fn(async () => {}),
    createTodo: fn<AppStore['createTodo']>(async (request) => {
      const todo: Todo = {
        ...request,
        body: request.body ?? '',
        branch: request.branch ?? branchOf(useStore.getState().repo, useStore.getState().root),
        id: `new-todo-${++sequence}`,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      useStore.setState((s) => ({ todos: [...s.todos, todo] }));
      return todo;
    }),
    updateTodo: fn<AppStore['updateTodo']>(async (id, patch) => {
      useStore.setState((s) => ({ todos: s.todos.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    }),
    deleteTodo: fn<AppStore['deleteTodo']>(async (id) => {
      useStore.setState((s) => ({ todos: s.todos.filter((t) => t.id !== id) }));
    }),
  });
}
