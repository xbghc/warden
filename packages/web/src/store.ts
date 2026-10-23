import { create } from 'zustand';
import type {
  ChangeEvent,
  CreateTodoRequest,
  FileDiff,
  FileEntry,
  Panel,
  Prefs,
  RepoInfo,
  TargetKey,
  Todo,
  UpdateNotice,
  UpdateTodoRequest,
  ViewMode,
} from '@warden/shared';
import { insertAfter, moveBefore } from '@warden/shared';
import { api, ApiError } from './api';
import { copyText } from './lib/clipboard';

/** Branch the todo list is scoped to: the worktree currently in view, else the repository's. */
export function branchOf(repo: RepoInfo | null, root: string): string {
  if (!repo) return '';
  return repo.worktrees.find((w) => w.path === root)?.branch ?? repo.branch;
}

export type DiffState = { status: 'loading' } | { status: 'ok'; diff: FileDiff } | { status: 'error'; message: string };

/** The one thing a toast can offer besides its text: the way back (撤销). */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: ToastAction;
}

export interface AppStore {
  repo: RepoInfo | null;
  /** A newer warden on npm, once the server's check has come back with one. */
  update: UpdateNotice | null;
  initError: string | null;
  prefs: Prefs;
  targetKey: TargetKey;
  root: string;
  files: FileEntry[];
  filesLoading: boolean;
  filesError: string | null;
  activeFile: string | null;
  diffs: Record<string, DiffState>;
  todos: Todo[];
  panel: Panel;
  toast: Toast | null;
  refreshNonce: number;
  /** A refresh is in flight; a change arriving now is coalesced into one follow-up pass. */
  refreshing: boolean;
  refreshPending: boolean;
  lastRefreshAt: string | null;
  /** Set for the duration of one refresh so the diff view restores its scroll position. */
  restoreScroll: boolean;
  /** Width the sidebar was dragged to, in px; kept here so it survives a panel switch. */
  sidebarWidth: number;
  /**
   * The review sidebar's slot element. The commit panel renders its controls through a portal:
   * they belong in the left column, but their state stays with the list in the middle.
   */
  sideSlot: HTMLElement | null;
  /** Portal host for the legacy checkout management preview. */
  worktreeSlot: HTMLElement | null;

  init(): Promise<void>;
  setTarget(key: TargetKey, options?: { reveal?: boolean }): Promise<void>;
  /** Re-reads /api/repo after a worktree was made or removed; the target is left alone. */
  reloadRepo(): Promise<void>;
  copyUpdateCommand(): Promise<void>;
  loadFiles(): Promise<void>;
  refresh(): Promise<void>;
  onRepoChanged(event: ChangeEvent): void;
  setAutoRefresh(on: boolean): void;
  consumeRestoreScroll(): boolean;
  openFile(path: string, force?: boolean): Promise<void>;
  setActiveFile(path: string | null): void;
  setViewMode(mode: ViewMode): void;
  setPanel(panel: Panel): void;
  setSidebarWidth(px: number): void;
  setSideSlot(el: HTMLElement | null): void;
  setWorktreeSlot(el: HTMLElement | null): void;
  loadTodos(): Promise<void>;
  createTodo(body: CreateTodoRequest): Promise<Todo | undefined>;
  updateTodo(id: string, body: UpdateTodoRequest): Promise<void>;
  deleteTodo(id: string): Promise<void>;
  deleteTodos(ids: string[]): Promise<void>;
  moveTodo(id: string, before: string | null): Promise<void>;
  /** Copy one todo to the clipboard — its title and body, nothing about where it lives. */
  copyTodo(id: string): Promise<void>;
  showToast(message: string, kind?: Toast['kind'], action?: ToastAction): void;
  /** Copy a short piece of text (a path, a location) and say what went, or why it did not. */
  copyToClipboard(text: string): Promise<void>;
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const useStore = create<AppStore>((set, get) => {
  const fail = (e: unknown) => get().showToast(errMsg(e), 'error');

  /** The refresh in progress, which a refresh asked for meanwhile waits on (see refresh). */
  let refreshRun: Promise<void> | null = null;
  let targetVersion = 0;

  /** `keep` leaves a diff already on screen there while the new one loads, rather than a placeholder. */
  const loadDiff = async (path: string, keep = false): Promise<FileDiff | undefined> => {
    const { targetKey, files } = get();
    const version = targetVersion;
    const entry = files.find((f) => f.path === path);
    if (!(keep && get().diffs[path]?.status === 'ok')) set((s) => ({ diffs: { ...s.diffs, [path]: { status: 'loading' } } }));
    try {
      const diff = await api.file(targetKey, path, { oldPath: entry?.oldPath, untracked: entry?.untracked });
      if (get().targetKey !== targetKey || version !== targetVersion) return undefined;
      set((s) => ({ diffs: { ...s.diffs, [path]: { status: 'ok', diff } } }));
      return diff;
    } catch (e) {
      if (get().targetKey !== targetKey || version !== targetVersion) return undefined;
      set((s) => ({ diffs: { ...s.diffs, [path]: { status: 'error', message: errMsg(e) } } }));
      return undefined;
    }
  };

  return {
    repo: null,
    update: null,
    initError: null,
    prefs: { viewMode: 'unified', autoRefresh: true },
    targetKey: 'all',
    root: '',
    files: [],
    filesLoading: false,
    filesError: null,
    activeFile: null,
    diffs: {},
    todos: [],
    panel: 'orchestration',
    toast: null,
    refreshNonce: 0,
    refreshing: false,
    refreshPending: false,
    lastRefreshAt: null,
    restoreScroll: false,
    sidebarWidth: 280,
    sideSlot: null,
    worktreeSlot: null,

    async init() {
      // Nothing waits on this: the server holds the answer until its registry request settles, and a
      // page that never hears back is simply one without the notice.
      void api.update().then(
        (update) => set({ update }),
        () => {},
      );
      try {
        const [repo, state] = await Promise.all([api.repo(), api.state()]);
        set({
          repo,
          prefs: state.prefs,
          panel: state.prefs.lastPanel ?? 'orchestration',
          todos: state.todos,
          root: repo.root,
          initError: null,
        });
        await get().setTarget(repo.defaultTarget || 'all', { reveal: false });
      } catch (e) {
        set({ initError: errMsg(e) });
      }
    },

    async reloadRepo() {
      try {
        set({ repo: await api.repo() });
      } catch (e) {
        fail(e);
      }
    },

    async copyUpdateCommand() {
      const update = get().update;
      if (!update) return;
      try {
        await copyText(update.command);
        get().showToast('已复制更新命令，更新后重启 warden 生效');
      } catch (e) {
        fail(e);
      }
    },

    async setTarget(key, options) {
      const version = ++targetVersion;
      if (options?.reveal !== false) get().setPanel('diff');
      set({
        targetKey: key,
        files: [],
        diffs: {},
        activeFile: null,
        filesError: null,
      });
      api.patchPrefs({ lastTarget: key }).catch(() => undefined);
      await get().loadFiles();
      if (get().targetKey !== key || version !== targetVersion) return;
      // A review starts by reading, so the diff opens on the first file rather than on a page
      // that explains how to open one. Refreshes keep whatever is already in front.
      const first = get().files[0];
      // A slow listing must not reopen the diff after the user has left for another panel.
      if (first && !get().activeFile && get().panel === 'diff') await get().openFile(first.path);
    },

    async loadFiles() {
      const key = get().targetKey;
      const version = targetVersion;
      set({ filesLoading: true, filesError: null });
      try {
        const keep = (files: FileEntry[]) => (get().activeFile && files.some((f) => f.path === get().activeFile) ? get().activeFile : null);

        const res = await api.files(key);
        if (get().targetKey !== key || version !== targetVersion) return;
        set({
          files: res.files,
          root: res.root,
          filesLoading: false,
          activeFile: keep(res.files),
        });
      } catch (e) {
        if (get().targetKey !== key || version !== targetVersion) return;
        set({ filesLoading: false, filesError: errMsg(e), files: [] });
      }
    },

    async refresh() {
      // Coalesce changes arriving mid-refresh into one follow-up pass for all callers.
      if (get().refreshing) {
        set({ refreshPending: true });
        return refreshRun ?? undefined;
      }
      refreshRun = (async () => {
        const { activeFile, diffs } = get();
        // The open file's diff stays on screen while it reloads. An agent writing other files moves
        // the listing, not this diff. Replacing it with a placeholder would discard expanded
        // context and folds even when the displayed content is unchanged.
        const shown = activeFile ? diffs[activeFile] : undefined;
        const before = shown?.status === 'ok' ? shown.diff.contentHash : undefined;
        set({
          refreshing: true,
          restoreScroll: true,
          diffs: activeFile && shown ? { [activeFile]: shown } : {},
          refreshNonce: get().refreshNonce + 1,
        });
        try {
          await get().loadFiles();
          const after = activeFile && get().files.some((f) => f.path === activeFile) ? await loadDiff(activeFile, true) : undefined;
          // Only a changed diff remounts the view and consumes restoreScroll.
          if (after?.contentHash === before && before !== undefined) set({ restoreScroll: false });
          set({ lastRefreshAt: new Date().toISOString() });
        } finally {
          set({ refreshing: false });
        }
        if (get().refreshPending) {
          set({ refreshPending: false });
          await get().refresh();
        }
      })();
      try {
        await refreshRun;
      } finally {
        refreshRun = null;
      }
    },

    onRepoChanged(event) {
      const root = get().root;
      set((s) => {
        if (!s.repo) return {};
        const worktrees = s.repo.worktrees.map((w) => (w.path === root ? { ...w, head: event.head, branch: event.branch } : w));
        const atRepoRoot = root === s.repo.root;
        return { repo: { ...s.repo, worktrees, ...(atRepoRoot ? { head: event.head, branch: event.branch } : {}) } };
      });
      if (get().prefs.autoRefresh) void get().refresh();
    },

    setAutoRefresh(on) {
      set((s) => ({ prefs: { ...s.prefs, autoRefresh: on } }));
      api.patchPrefs({ autoRefresh: on }).catch(fail);
    },

    consumeRestoreScroll() {
      if (!get().restoreScroll) return false;
      set({ restoreScroll: false });
      return true;
    },

    async openFile(path, force = false) {
      get().setPanel('diff');
      set({ activeFile: path });
      const cur = get().diffs[path];
      if (!force && cur && cur.status !== 'error') return;
      await loadDiff(path);
    },

    setActiveFile(path) {
      set({ activeFile: path });
      if (path) void get().openFile(path);
    },

    setViewMode(mode) {
      set((s) => ({ prefs: { ...s.prefs, viewMode: mode } }));
      api.patchPrefs({ viewMode: mode }).catch(fail);
    },

    setPanel(panel) {
      if (panel === get().panel) return;
      set((s) => ({ panel, prefs: { ...s.prefs, lastPanel: panel } }));
      api.patchPrefs({ lastPanel: panel }).catch(fail);
    },

    setSidebarWidth(px) {
      set({ sidebarWidth: Math.round(px) });
    },
    setSideSlot(el) {
      set({ sideSlot: el });
    },
    setWorktreeSlot(el) {
      set({ worktreeSlot: el });
    },

    async loadTodos() {
      try {
        const res = await api.todos();
        set({ todos: res.todos });
      } catch (e) {
        fail(e);
      }
    },

    async createTodo(body) {
      try {
        const todo = await api.createTodo({ ...body, root: body.root ?? get().root });
        set((s) => ({ todos: insertAfter(s.todos, todo, body.after) }));
        return todo;
      } catch (e) {
        fail(e);
        return undefined;
      }
    },

    async updateTodo(id, body) {
      try {
        const todo = await api.updateTodo(id, body);
        set((s) => ({ todos: s.todos.map((t) => (t.id === id ? todo : t)) }));
      } catch (e) {
        fail(e);
      }
    },

    async deleteTodo(id) {
      const todos = get().todos;
      const idx = todos.findIndex((t) => t.id === id);
      const todo = todos[idx];
      if (!todo) return;
      const prev = todos[idx - 1]?.id;
      try {
        await api.deleteTodo(id);
        set((s) => ({ todos: s.todos.filter((t) => t.id !== id) }));
        get().showToast(`已删除「${todo.title}」`, 'info', {
          label: '撤销',
          run: () => void get().createTodo({ title: todo.title, body: todo.body, branch: todo.branch, status: todo.status, after: prev }),
        });
      } catch (e) {
        fail(e);
      }
    },

    async deleteTodos(ids) {
      const gone: Todo[] = [];
      for (const id of ids) {
        const todo = get().todos.find((t) => t.id === id);
        if (!todo) continue;
        try {
          await api.deleteTodo(id);
          gone.push(todo);
          set((s) => ({ todos: s.todos.filter((t) => t.id !== id) }));
        } catch (e) {
          fail(e);
          break;
        }
      }
      if (gone.length === 0) return;
      get().showToast(`已删除 ${gone.length} 条待办`, 'info', {
        label: '撤销',
        run: async () => {
          for (const t of [...gone].reverse()) await get().createTodo({ title: t.title, body: t.body, branch: t.branch, status: t.status });
        },
      });
    },

    async moveTodo(id, before) {
      const prev = get().todos;
      const next = moveBefore(prev, id, before);
      if (!next) return;
      set({ todos: next });
      try {
        const res = await api.moveTodo(id, before);
        set({ todos: res.todos });
      } catch (e) {
        fail(e);
        set({ todos: prev });
      }
    },

    async copyToClipboard(text) {
      try {
        await copyText(text);
        get().showToast('已复制');
      } catch (e) {
        fail(e);
      }
    },

    async copyTodo(id) {
      const todo = get().todos.find((t) => t.id === id);
      if (!todo) return;
      try {
        const res = await api.exportTodo(id);
        await copyText(res.text);
        get().showToast('已复制待办');
      } catch (e) {
        fail(e);
      }
    },

    showToast(message, kind = 'info', action) {
      const id = ++toastSeq;
      set({ toast: { id, message, kind, ...(action ? { action } : {}) } });
      if (toastTimer) clearTimeout(toastTimer);
      // Long enough to read and reach for the button when there is one.
      toastTimer = setTimeout(
        () => {
          if (get().toast?.id === id) set({ toast: null });
        },
        action ? 8000 : kind === 'error' ? 6000 : 3000,
      );
    },
  };
});
