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
  HunkSelection,
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
import { insertAfter, isLocalTarget, localViewKeys, moveBefore, stageModeFor, tryParseTargetKey, type StageMode } from '@warden/shared';
import { api, ApiError } from './api';
import { copyText } from './lib/clipboard';
import { todoText } from './lib/todos';

/** Branch the todo list is scoped to: the worktree currently in view, else the repository's. */
export function branchOf(repo: RepoInfo | null, root: string): string {
  if (!repo) return '';
  return repo.worktrees.find((w) => w.path === root)?.branch ?? repo.branch;
}

export type DiffState = { status: 'loading' } | { status: 'ok'; diff: FileDiff } | { status: 'error'; message: string };
export type Panel = 'diff' | 'commits' | 'issues' | 'worktrees';

/** The one thing a toast can offer besides its text: the way back (撤消). */
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

export interface EditorTarget {
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
}

export type RailFilter = 'file' | 'all' | 'unexported';
/** The two notebooks of the right-hand rail. */
export type RailTab = 'comments' | 'todos';

/**
 * Rows picked for staging in the open diff: a drag over one hunk, kept as the positions it
 * started and ended on plus the changed lines those rows show (see `Row.indices`). Positions
 * mean nothing once the diff or the layout changes, so the pick is dropped with them.
 */
export interface StageSelection {
  filePath: string;
  hunkIndex: number;
  anchor: number;
  head: number;
  /** Indices into `hunk.lines` of the changed lines picked. */
  lines: number[];
}

/** Whether the view in front stages, unstages, or neither (a commit, a range, `all`). */
export function useStageMode(): StageMode | undefined {
  return useStore((s) => {
    const t = tryParseTargetKey(s.targetKey);
    return t ? stageModeFor(t) : undefined;
  });
}

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
  stageSel: StageSelection | null;
  /** A stage request is in flight; the controls wait for it rather than queue a second one. */
  staging: boolean;

  init(): Promise<void>;
  setTarget(key: TargetKey): Promise<void>;
  /** Re-reads /api/repo after a worktree was made or removed; the target is left alone. */
  reloadRepo(): Promise<void>;
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
  /** No confirmation: the toast offers 撤消 instead, as a task list would. */
  deleteIssue(id: string): Promise<void>;
  deleteIssues(ids: string[]): Promise<void>;
  /** Put the issue right before `before` in the list, or last. */
  moveIssue(id: string, before: string | null): Promise<void>;
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
  deleteTodos(ids: string[]): Promise<void>;
  moveTodo(id: string, before: string | null): Promise<void>;
  /** Copy one todo to the clipboard — its title and body, nothing about where it lives. */
  copyTodo(id: string): Promise<void>;
  setStageSel(sel: StageSelection | null): void;
  /**
   * Stage (Unstaged view) or unstage (Staged view) lines of a file; no hunks means the whole file.
   * `view` defaults to the one in front — the sidebar blocks pass their own. Resolves to whether
   * the index changed.
   */
  stageLines(path: string, hunks?: HunkSelection[], view?: TargetKey): Promise<boolean>;
  /** Stage or unstage whatever `stageSel` holds. */
  stageSelection(): Promise<void>;
  showToast(message: string, kind?: Toast['kind'], action?: ToastAction): void;
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
    stageSel: null,
    staging: false,

    async init() {
      try {
        const [repo, state] = await Promise.all([api.repo(), api.state()]);
        set({ repo, prefs: state.prefs, issues: state.issues, todos: state.todos, root: repo.root });
        await get().setTarget(repo.defaultTarget || 'working');
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
        stageSel: null,
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
      set({ targetKey: key, files: cached, diffs: {}, filesError: null, activeFile, stageSel: null });
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
      set({ refreshing: true, restoreScroll: true, diffs: {}, stageSel: null, refreshNonce: get().refreshNonce + 1 });
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
      set((s) => ({ activeFile: path, panel: 'diff', stageSel: s.stageSel?.filePath === path ? s.stageSel : null }));
      const cur = get().diffs[path];
      if (!force && cur && cur.status !== 'error') return;
      await loadDiff(path);
    },

    setActiveFile(path) {
      set({ activeFile: path });
      if (path) void get().openFile(path);
    },

    setViewMode(mode) {
      // Row positions are per layout, so a pick made in the other one no longer names anything.
      set((s) => ({ prefs: { ...s.prefs, viewMode: mode }, stageSel: null }));
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
        set((s) => ({ issues: insertAfter(s.issues, issue, body.after), selectedCommentIds: [] }));
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
      const issues = get().issues;
      const idx = issues.findIndex((i) => i.id === id);
      const issue = issues[idx];
      if (!issue) return;
      const prev = issues[idx - 1]?.id;
      try {
        await api.deleteIssue(id);
        set((s) => ({ issues: s.issues.filter((i) => i.id !== id) }));
        get().showToast(`已删除「${issue.title}」`, 'info', {
          label: '撤消',
          run: () => void get().createIssue({ title: issue.title, body: issue.body, commentIds: issue.commentIds, status: issue.status, after: prev }),
        });
      } catch (e) {
        fail(e);
      }
    },

    async deleteIssues(ids) {
      const gone: Issue[] = [];
      for (const id of ids) {
        const issue = get().issues.find((i) => i.id === id);
        if (!issue) continue;
        try {
          await api.deleteIssue(id);
          gone.push(issue);
          set((s) => ({ issues: s.issues.filter((i) => i.id !== id) }));
        } catch (e) {
          fail(e);
          break;
        }
      }
      if (gone.length === 0) return;
      get().showToast(`已删除 ${gone.length} 个 Issue`, 'info', {
        label: '撤消',
        run: async () => {
          // Each goes back on top, last first, so they end up in the order they were in.
          for (const i of [...gone].reverse()) await get().createIssue({ title: i.title, body: i.body, commentIds: i.commentIds, status: i.status });
        },
      });
    },

    async moveIssue(id, before) {
      const prev = get().issues;
      const next = moveBefore(prev, id, before);
      if (!next) return;
      set({ issues: next });
      try {
        const res = await api.moveIssue(id, before);
        set({ issues: res.issues });
      } catch (e) {
        fail(e);
        set({ issues: prev });
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
          label: '撤消',
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
      get().showToast(`已删除 ${gone.length} 条 Todo`, 'info', {
        label: '撤消',
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

    setStageSel(sel) {
      set({ stageSel: sel });
    },

    async stageLines(path, hunks, view) {
      const key = view ?? get().targetKey;
      const target = tryParseTargetKey(key);
      if (!target || !stageModeFor(target)) return false;
      if (get().staging) return false;
      // The diff in front is the freshest hash for the open file; the listing serves the others.
      const open = key === get().targetKey ? get().diffs[path] : undefined;
      const contentHash = open?.status === 'ok' ? open.diff.contentHash : entriesOf(key).find((f) => f.path === path)?.contentHash;
      if (!contentHash) return false;
      set({ staging: true });
      try {
        await api.stage(key, { path, contentHash, hunks });
      } catch (e) {
        set({ staging: false });
        fail(e);
        // The selection was made on a diff that is no longer what git sees: show what is.
        if (e instanceof ApiError && (e.code === 'diff_changed' || e.code === 'apply_failed')) void get().refresh();
        return false;
      }
      const before = get().files.map((f) => f.path);
      const active = get().activeFile;
      set({ staging: false, stageSel: null });
      await get().refresh();
      // A file that left the view (all of it moved) hands over to its neighbour, as `j` would.
      if (active && active === path && key === get().targetKey && !get().files.some((f) => f.path === active)) {
        const files = get().files;
        const next = files[Math.min(Math.max(before.indexOf(active), 0), files.length - 1)];
        if (next) void get().openFile(next.path);
      }
      return true;
    },

    async stageSelection() {
      const sel = get().stageSel;
      if (!sel || sel.lines.length === 0) return;
      await get().stageLines(sel.filePath, [{ index: sel.hunkIndex, lines: sel.lines }]);
    },

    showToast(message, kind = 'info', action) {
      const id = ++toastSeq;
      set({ toast: { id, message, kind, ...(action ? { action } : {}) } });
      if (toastTimer) clearTimeout(toastTimer);
      // Long enough to read and reach for the button when there is one.
      toastTimer = setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, action ? 8000 : kind === 'error' ? 6000 : 3000);
    },
  };
});
