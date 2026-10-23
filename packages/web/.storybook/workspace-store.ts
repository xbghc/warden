import { fn } from 'storybook/test';
import type { FileDiff, FileEntry } from '@warden/shared';
import { api } from '../src/api';
import { useStore } from '../src/store';
import { setupWorktreeStore } from './worktree-store';
import { setupWorkflowStore } from './workflow-store';

const diff: FileDiff = {
  path: 'src/App.tsx',
  status: 'modified',
  additions: 2,
  deletions: 1,
  binary: false,
  contentHash: 'workspace-preview',
  hunks: [
    {
      hash: 'workspace-hunk',
      oldStart: 10,
      oldLines: 5,
      newStart: 10,
      newLines: 6,
      header: 'OrderTotal',
      lines: [
        { type: 'context', oldLineNo: 10, newLineNo: 10, content: 'export function OrderTotal({ items }: Props) {' },
        { type: 'context', oldLineNo: 11, newLineNo: 11, content: '  const normalized = items ?? [];' },
        { type: 'del', oldLineNo: 12, content: '  const total = items.reduce((sum, item) => sum + item.price, 0);' },
        { type: 'add', newLineNo: 12, content: '  const total = calcTotal(normalized);' },
        { type: 'add', newLineNo: 13, content: '  if (normalized.length === 0) return <EmptyState />;' },
        { type: 'context', oldLineNo: 13, newLineNo: 14, content: '  return <Amount value={total} />;' },
        { type: 'context', oldLineNo: 14, newLineNo: 15, content: '}' },
      ],
    },
  ],
};

/** The real App with isolated fixtures: it never connects to a repository or event stream. */
export async function setupWorkspaceStore() {
  const cleanup = setupWorktreeStore();
  await setupWorkflowStore();
  const { worktrees } = await api.worktrees();
  const file: FileEntry = { ...diff };
  const setTarget = useStore.getState().setTarget;
  api.patchPrefs = fn(async (patch) => ({ ...useStore.getState().prefs, ...patch }));
  api.forkPoint = fn(async ({ base }) => ({ base, sha: 'abc1234', ahead: 2, behind: 0 }));
  api.file = fn(async () => diff);
  api.fullFile = fn(async (_key, path, side) => ({
    path,
    side,
    content: Array.from({ length: 9 }, () => '')
      .concat(diff.hunks[0]!.lines.filter((line) => line.type !== (side === 'old' ? 'add' : 'del')).map((line) => line.content))
      .join('\n'),
  }));
  api.events = fn(
    () =>
      Object.assign(new EventTarget(), {
        close: fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        readyState: 1,
        url: '',
        withCredentials: false,
        CONNECTING: 0 as const,
        OPEN: 1 as const,
        CLOSED: 2 as const,
      }) as EventSource,
  );
  useStore.setState((s) => ({
    repo: { ...s.repo!, branch: 'feature/order', worktrees },
    todos: s.todos.map((todo) => (todo.branch === 'main' ? { ...todo, branch: 'feature/order' } : todo)),
    prefs: { ...s.prefs, autoRefresh: false },
    files: [file],
    activeFile: diff.path,
    diffs: { [diff.path]: { status: 'ok', diff } },
    init: fn(async () => {}),
    reloadRepo: fn(async () => {}),
    setTarget: fn(async (key, options) => {
      await setTarget(key, options);
      useStore.setState({ files: [file] });
    }),
  }));
  return cleanup;
}
