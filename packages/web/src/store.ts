import { create } from 'zustand';
import type {
  ChangeEvent,
  Comment,
  CommentSide,
  CreateCommentRequest,
  CreateIssueRequest,
  CreateTodoRequest,
  FileDiff,
  FileEntry,
  Issue,
  NvimInstancesResponse,
  Prefs,
  RepoInfo,
  TargetKey,
  Todo,
  UpdateCommentRequest,
  UpdateIssueRequest,
  UpdateTodoRequest,
  ViewMode,
} from '@warden/shared';
import { isLocalTarget, localViewKeys, tryParseTargetKey } from '@warden/shared';
import { api, ApiError } from './api';
import { copyText } from './lib/clipboard';
import { todoText } from './lib/todos';

/** Branch the todo list is scoped to: the worktree currently in view, else the repository's. */
export function branchOf(repo: RepoInfo | null, root: string): string {
  if (!repo) return '';
  return repo.worktrees.find((w) => w.path === root)?.branch ?? repo.branch;
}

export type DiffState = { status: 'loading' } | { status: 'ok'; diff: FileDiff } | { status: 'error'; message: string };
export type Panel = 'diff' | 'commits' | 'issues';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

export interface EditorTarget {
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
}

export type RailFilter = 'file' | 'all' | 'unexported';
/** The two notebooks of the right-hand rail. */
export type RailTab = 'comments' | 'todos';

export interface JumpTarget {
  file: string;
  side: CommentSide;
  line: number;
  nonce: number;
}

export interface AppStore {
  repo: RepoInfo | null;
  initError: string | null;
  prefs: Prefs;
  targetKey: TargetKey;
  root: string;
  /** Files of the current view. For a local target this mirrors one of the three lists below. */
  files: FileEntry[];
  /** Unstaged (index -> working tree); shown as its own sidebar block for local targets. */
  unstaged: FileEntry[];
  /** Staged (HEAD -> index); the reviewer's "already reviewed" pile. */
  staged: FileEntry[];
  /** HEAD -> working tree; only fetched while `all` is the active view. */
  allFiles: FileEntry[];
  filesLoading: boolean;
  filesError: string | null;
  activeFile: string | null;
  diffs: Record<string, DiffState>;
  comments: Comment[];
  issues: Issue[];
  todos: Todo[];
  /** All comments across targets (loaded with the issues panel). */
  allComments: Comment[];
  nvim: NvimInstancesResponse | null;
  nvimScanning: boolean;
  panel: Panel;
  includeExported: boolean;
  selectedCommentIds: string[];
  jumpTo: JumpTarget | null;
  toast: Toast | null;
  reattaching: string | null;
  refreshNonce: number;
  /** A refresh is in flight; a change arriving now is coalesced into one follow-up pass. */
  refreshing: boolean;
  refreshPending: boolean;
  lastRefreshAt: string | null;
  /** Set for the duration of one refresh so the diff view restores its scroll position. */
  restoreScroll: boolean;
  /** Selection a new comment is being written for (rendered in the comment rail). */
  editor: EditorTarget | null;
  /** Comment highlighted in both the rail and the diff. */
  focusedCommentId: string | null;
  railFilter: RailFilter;
  railTab: RailTab;

  init(): Promise<void>;
  setTarget(key: TargetKey): Promise<void>;
  /** Move between the local views without dropping comments, selection or the editor draft. */
  switchView(key: TargetKey, nextActiveFile?: string | null): Promise<void>;
  loadFiles(): Promise<void>;
  refresh(): Promise<void>;
  onRepoChanged(event: ChangeEvent): void;
  setAutoRefresh(on: boolean): void;
  consumeRestoreScroll(): boolean;
  openFile(path: string, force?: boolean): Promise<void>;
  setActiveFile(path: string | null): void;
  setViewMode(mode: ViewMode): void;
  /** `view` defaults to the current one; the two sidebar blocks pass their own. */
  toggleViewed(path: string, view?: TargetKey): Promise<void>;
  createComment(body: CreateCommentRequest): Promise<Comment | undefined>;
  updateComment(id: string, body: UpdateCommentRequest): Promise<Comment | undefined>;
  deleteComment(id: string): Promise<void>;
  exportComments(ids: string[]): Promise<void>;
  copyAllComments(): Promise<void>;
  loadIssues(): Promise<void>;
  createIssue(body: CreateIssueRequest): Promise<Issue | undefined>;
  updateIssue(id: string, body: UpdateIssueRequest): Promise<void>;
  deleteIssue(id: string): Promise<void>;
  exportIssue(id: string): Promise<void>;
  scanNvim(force?: boolean): Promise<void>;
  selectNvim(socket: string): Promise<void>;
  openInNvim(filePath: string, line: number): Promise<void>;
  setPanel(panel: Panel): void;
  setIncludeExported(v: boolean): void;
  toggleSelectComment(id: string): void;
  clearSelectedComments(): void;
  jumpToComment(comment: Comment): Promise<void>;
  setReattaching(id: string | null): void;
  setEditor(editor: EditorTarget | null): void;
  focusComment(id: string | null, scroll?: boolean): Promise<void>;
  setRailFilter(filter: RailFilter): void;
  setRailTab(tab: RailTab): void;
  loadTodos(): Promise<void>;
  createTodo(body: CreateTodoRequest): Promise<Todo | undefined>;
  updateTodo(id: string, body: UpdateTodoRequest): Promise<void>;
  deleteTodo(id: string): Promise<void>;
  /** Copy one todo to the clipboard — its title and body, nothing about where it lives. */
  copyTodo(id: string): Promise<void>;
  showToast(message: string, kind?: Toast['kind']): void;
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

  /** The listing behind a view key, whether or not it is the one in front. */
  const entriesOf = (view: TargetKey): FileEntry[] => {
    const s = get();
    if (view === s.targetKey) return s.files;
    const t = tryParseTargetKey(view);
    if (!t || !isLocalTarget(t)) return [];
    return t.kind === 'working' ? s.unstaged : t.kind === 'staged' ? s.staged : s.allFiles;
  };

  /** Patch one entry in the list behind `view`, and in `files` when that view is in front. */
  const patchEntry = (view: TargetKey, path: string, patch: Partial<FileEntry>) => {
    const t = tryParseTargetKey(view);
    const kind = t && isLocalTarget(t) ? t.kind : null;
    const apply = (list: FileEntry[]) => list.map((f) => (f.path === path ? { ...f, ...patch } : f));
    set((s) => ({
      ...(kind === 'working' ? { unstaged: apply(s.unstaged) } : {}),
      ...(kind === 'staged' ? { staged: apply(s.staged) } : {}),
      ...(kind === 'all' ? { allFiles: apply(s.allFiles) } : {}),
      ...(view === s.targetKey ? { files: apply(s.files) } : {}),
    }));
  };

  const loadDiff = async (path: string): Promise<FileDiff | undefined> => {
    const { targetKey, files } = get();
    const entry = files.find((f) => f.path === path);
    set((s) => ({ diffs: { ...s.diffs, [path]: { status: 'loading' } } }));
    try {
      const diff = await api.file(targetKey, path, { oldPath: entry?.oldPath, untracked: entry?.untracked });
      if (get().targetKey !== targetKey) return undefined;
      set((s) => ({ diffs: { ...s.diffs, [path]: { status: 'ok', diff } } }));
      return diff;
    } catch (e) {
      if (get().targetKey !== targetKey) return undefined;
      set((s) => ({ diffs: { ...s.diffs, [path]: { status: 'error', message: errMsg(e) } } }));
      return undefined;
    }
  };

  return {
    repo: null,
    initError: null,
    prefs: { viewMode: 'unified', nvimSocketByRoot: {}, autoRefresh: true },
    targetKey: 'working',
    root: '',
    files: [],
    unstaged: [],
    staged: [],
    allFiles: [],
    filesLoading: false,
    filesError: null,
    activeFile: null,
    diffs: {},
    comments: [],
    issues: [],
    todos: [],
    allComments: [],
    nvim: null,
    nvimScanning: false,
    panel: 'diff',
    includeExported: false,
    selectedCommentIds: [],
    jumpTo: null,
    toast: null,
    reattaching: null,
    refreshNonce: 0,
    refreshing: false,
    refreshPending: false,
    lastRefreshAt: null,
    restoreScroll: false,
    editor: null,
    focusedCommentId: null,
    railFilter: 'file',
    railTab: 'comments',

    async init() {
      try {
        const [repo, state] = await Promise.all([api.repo(), api.state()]);
        set({ repo, prefs: state.prefs, issues: state.issues, todos: state.todos, root: repo.root });
        await get().setTarget(repo.defaultTarget || 'working');
      } catch (e) {
        set({ initError: errMsg(e) });
      }
    },

    async setTarget(key) {
      set({
        targetKey: key,
        files: [],
        unstaged: [],
        staged: [],
        allFiles: [],
        diffs: {},
        activeFile: null,
        comments: [],
        filesError: null,
        selectedCommentIds: [],
        reattaching: null,
        panel: 'diff',
        editor: null,
        focusedCommentId: null,
      });
      api.patchPrefs({ lastTarget: key }).catch(() => undefined);
      await get().loadFiles();
    },

    async switchView(key, nextActiveFile) {
      const target = tryParseTargetKey(key);
      if (!target || !isLocalTarget(target)) {
        await get().setTarget(key);
        return;
      }
      const { unstaged, staged, allFiles } = get();
      const activeFile = nextActiveFile !== undefined ? nextActiveFile : get().activeFile;
      const cached = target.kind === 'working' ? unstaged : target.kind === 'staged' ? staged : allFiles;
      // A file present in both views has different hunks in each, so cached diffs cannot carry over.
      // Everything else — comments, the editor draft, the selection — deliberately survives.
      set({ targetKey: key, files: cached, diffs: {}, filesError: null, activeFile });
      api.patchPrefs({ lastTarget: key }).catch(() => undefined);
      // `all` is only listed while it is the view in front, so it has to be fetched on arrival.
      if (target.kind === 'all') await get().loadFiles();
      if (activeFile && get().files.some((f) => f.path === activeFile)) await loadDiff(activeFile);
    },

    async loadFiles() {
      const key = get().targetKey;
      const target = tryParseTargetKey(key);
      set({ filesLoading: true, filesError: null });
      try {
        // Re-attach comments first so the listings carry fresh comment state.
        await api.reanchor(key).catch(() => undefined);
        const keep = (files: FileEntry[]) => (get().activeFile && files.some((f) => f.path === get().activeFile) ? get().activeFile : null);

        if (target && isLocalTarget(target)) {
          const [workingKey, stagedKey] = localViewKeys(key);
          const [working, indexed, all] = await Promise.all([
            api.files(workingKey!),
            api.files(stagedKey!),
            target.kind === 'all' ? api.files(key) : Promise.resolve(null),
          ]);
          if (get().targetKey !== key) return;
          const files = target.kind === 'working' ? working.files : target.kind === 'staged' ? indexed.files : all!.files;
          // Comments are scope-wide, so any of the three listings carries the same set.
          const listing = all ?? working;
          set({
            unstaged: working.files,
            staged: indexed.files,
            allFiles: all?.files ?? [],
            files,
            root: listing.root,
            comments: listing.comments,
            filesLoading: false,
            activeFile: keep(files),
          });
          if (listing.root !== get().nvim?.root) void get().scanNvim();
          return;
        }

        const res = await api.files(key);
        if (get().targetKey !== key) return;
        set({
          files: res.files,
          unstaged: [],
          staged: [],
          allFiles: [],
          root: res.root,
          comments: res.comments,
          filesLoading: false,
          activeFile: keep(res.files),
        });
        if (res.root !== get().nvim?.root) void get().scanNvim();
      } catch (e) {
        if (get().targetKey !== key) return;
        set({ filesLoading: false, filesError: errMsg(e), files: [] });
      }
    },

    async refresh() {
      // A change landing mid-refresh is coalesced into a single follow-up pass.
      if (get().refreshing) {
        set({ refreshPending: true });
        return;
      }
      const { activeFile } = get();
      set({ refreshing: true, restoreScroll: true, diffs: {}, refreshNonce: get().refreshNonce + 1 });
      try {
        await get().loadFiles();
        if (activeFile && get().files.some((f) => f.path === activeFile)) await loadDiff(activeFile);
        set({ lastRefreshAt: new Date().toISOString() });
      } finally {
        set({ refreshing: false });
      }
      if (get().refreshPending) {
        set({ refreshPending: false });
        await get().refresh();
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
      set({ activeFile: path, panel: 'diff' });
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

    async toggleViewed(path, view) {
      // `viewed` is per view, so a file staged halfway can be marked read in one block and not the other.
      const key = view ?? get().targetKey;
      const entry = entriesOf(key).find((f) => f.path === path);
      if (!entry) return;
      const next = !entry.viewed;
      patchEntry(key, path, { viewed: next, changed: false });
      try {
        await api.setViewed(key, path, next, entry.contentHash);
      } catch (e) {
        fail(e);
        patchEntry(key, path, { viewed: !next });
      }
    },

    async createComment(body) {
      try {
        const c = await api.createComment(get().targetKey, body);
        set((s) => ({ comments: [...s.comments, c], editor: null, focusedCommentId: c.id }));
        return c;
      } catch (e) {
        fail(e);
        return undefined;
      }
    },

    async updateComment(id, body) {
      try {
        const c = await api.updateComment(get().targetKey, id, body);
        set((s) => ({ comments: s.comments.map((x) => (x.id === id ? c : x)), reattaching: s.reattaching === id ? null : s.reattaching }));
        return c;
      } catch (e) {
        fail(e);
        return undefined;
      }
    },

    async deleteComment(id) {
      try {
        await api.deleteComment(get().targetKey, id);
        set((s) => ({
          comments: s.comments.filter((x) => x.id !== id),
          selectedCommentIds: s.selectedCommentIds.filter((x) => x !== id),
          focusedCommentId: s.focusedCommentId === id ? null : s.focusedCommentId,
          issues: s.issues.map((i) => (i.commentIds.includes(id) ? { ...i, commentIds: i.commentIds.filter((x) => x !== id) } : i)),
        }));
      } catch (e) {
        fail(e);
      }
    },

    async exportComments(ids) {
      if (ids.length === 0) {
        get().showToast('没有可复制的评论');
        return;
      }
      try {
        const res = await api.exportComments(ids);
        await copyText(res.text);
        const now = new Date().toISOString();
        set((s) => ({
          comments: s.comments.map((c) => (res.commentIds.includes(c.id) ? { ...c, status: c.status === 'active' ? 'exported' : c.status, exportedAt: now } : c)),
        }));
        get().showToast(`已复制 ${res.count} 条评论到剪贴板`);
      } catch (e) {
        fail(e);
      }
    },

    async copyAllComments() {
      const { comments, includeExported } = get();
      const ids = comments.filter((c) => c.status === 'active' || (includeExported && c.status === 'exported')).map((c) => c.id);
      await get().exportComments(ids);
    },

    async loadIssues() {
      try {
        const state = await api.state();
        const allComments = Object.values(state.targets).flatMap((t) => t.comments);
        set({ issues: state.issues, allComments });
      } catch (e) {
        fail(e);
      }
    },

    async createIssue(body) {
      try {
        const issue = await api.createIssue(body);
        set((s) => ({ issues: [...s.issues, issue], selectedCommentIds: [] }));
        get().showToast(`已创建 Issue「${issue.title}」`);
        return issue;
      } catch (e) {
        fail(e);
        return undefined;
      }
    },

    async updateIssue(id, body) {
      try {
        const issue = await api.updateIssue(id, body);
        set((s) => ({ issues: s.issues.map((i) => (i.id === id ? issue : i)) }));
      } catch (e) {
        fail(e);
      }
    },

    async deleteIssue(id) {
      try {
        await api.deleteIssue(id);
        set((s) => ({ issues: s.issues.filter((i) => i.id !== id) }));
      } catch (e) {
        fail(e);
      }
    },

    async exportIssue(id) {
      try {
        const res = await api.exportIssue(id);
        await copyText(res.text);
        const now = new Date().toISOString();
        set((s) => ({
          comments: s.comments.map((c) => (res.commentIds.includes(c.id) ? { ...c, status: c.status === 'active' ? 'exported' : c.status, exportedAt: now } : c)),
        }));
        get().showToast(`已复制 Issue（含 ${res.count} 条评论）到剪贴板`);
      } catch (e) {
        fail(e);
      }
    },

    async scanNvim(force = false) {
      const root = get().root || get().repo?.root;
      if (!root) return;
      set({ nvimScanning: true });
      try {
        const res = await api.nvimInstances(root, force);
        set({ nvim: res, nvimScanning: false });
      } catch (e) {
        set({ nvimScanning: false });
        fail(e);
      }
    },

    async selectNvim(socket) {
      const root = get().root;
      set((s) => (s.nvim ? { nvim: { ...s.nvim, selected: socket } } : {}));
      try {
        await api.nvimSelect(root, socket);
      } catch (e) {
        fail(e);
      }
    },

    async openInNvim(filePath, line) {
      const { nvim, root } = get();
      const socket = nvim?.selected;
      if (!socket) {
        get().showToast(nvim && nvim.instances.length > 1 ? '请先在顶部选择一个 nvim 实例' : '未发现在此仓库打开的 nvim', 'error');
        return;
      }
      const absPath = `${root.replace(/\/+$/, '')}/${filePath}`;
      try {
        await api.nvimOpen(socket, absPath, line);
      } catch (e) {
        fail(e);
        if (e instanceof ApiError && e.code === 'nvim_gone') void get().scanNvim(true);
      }
    },

    setPanel(panel) {
      set({ panel });
      if (panel === 'issues') void get().loadIssues();
    },

    setIncludeExported(v) {
      set({ includeExported: v });
    },

    toggleSelectComment(id) {
      set((s) => ({
        selectedCommentIds: s.selectedCommentIds.includes(id) ? s.selectedCommentIds.filter((x) => x !== id) : [...s.selectedCommentIds, id],
      }));
    },

    clearSelectedComments() {
      set({ selectedCommentIds: [] });
    },

    async jumpToComment(comment) {
      // The comment may have moved to another local view since it was written; follow it there
      // rather than reloading the whole target.
      if (comment.targetKey !== get().targetKey) {
        await get().switchView(comment.targetKey);
      }
      set({ panel: 'diff' });
      await get().openFile(comment.filePath);
      set({ jumpTo: { file: comment.filePath, side: comment.side, line: comment.endLine, nonce: Date.now() } });
    },

    setReattaching(id) {
      set({ reattaching: id, editor: id ? null : get().editor });
      if (id) get().showToast('在 diff 中点击或拖选行，将评论重新附着到该位置');
    },

    setEditor(editor) {
      set({ editor, focusedCommentId: editor ? null : get().focusedCommentId });
    },

    async focusComment(id, scroll = true) {
      set({ focusedCommentId: id });
      if (!id || !scroll) return;
      const c = get().comments.find((x) => x.id === id) ?? get().allComments.find((x) => x.id === id);
      if (!c || c.status === 'orphaned') return;
      await get().jumpToComment(c);
    },

    setRailFilter(filter) {
      set({ railFilter: filter });
    },
    setRailTab(tab) {
      set({ railTab: tab });
      if (tab === 'todos') void get().loadTodos();
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
        set((s) => ({ todos: [...s.todos, todo] }));
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
      try {
        await api.deleteTodo(id);
        set((s) => ({ todos: s.todos.filter((t) => t.id !== id) }));
      } catch (e) {
        fail(e);
      }
    },

    async copyTodo(id) {
      const todo = get().todos.find((t) => t.id === id);
      if (!todo) return;
      try {
        await copyText(todoText(todo));
        get().showToast('已复制 Todo 到剪贴板');
      } catch (e) {
        fail(e);
      }
    },

    showToast(message, kind = 'info') {
      const id = ++toastSeq;
      set({ toast: { id, message, kind } });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, kind === 'error' ? 6000 : 3000);
    },
  };
});
