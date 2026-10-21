import { create } from 'zustand';
import type {
  ChangeEvent,
  Checkpoint,
  Comment,
  CommentSide,
  CreateCommentRequest,
  CreateTodoRequest,
  FileDiff,
  FileEntry,
  Panel,
  Prefs,
  RepoInfo,
  TargetKey,
  Todo,
  UpdateCommentRequest,
  UpdateNotice,
  UpdateTodoRequest,
  ViewMode,
} from '@warden/shared';
import { awaitsAgent, commentScopeKey, formatTargetKey, insertAfter, moveBefore, tryParseTargetKey } from '@warden/shared';
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

export interface EditorTarget {
  /** The comparison the selected line numbers belong to. */
  view: TargetKey;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
}

export type RailFilter = 'file' | 'all' | 'unexported' | 'replied';

export interface JumpTarget {
  file: string;
  side: CommentSide;
  line: number;
  nonce: number;
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
  /** Checkpoints of the worktree under review, oldest first. */
  checkpoints: Checkpoint[];
  filesLoading: boolean;
  filesError: string | null;
  activeFile: string | null;
  diffs: Record<string, DiffState>;
  comments: Comment[];
  todos: Todo[];
  /** All comments across targets (loaded with the todo tab, for the comments todos link). */
  allComments: Comment[];
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
  onStateChanged(): Promise<void>;
  loadCheckpoints(): Promise<void>;
  /** Takes the worktree as it is now; a checkpoint target in front moves on to the new one. */
  createCheckpoint(): Promise<void>;
  deleteCheckpoint(id: number): Promise<void>;
  setAutoRefresh(on: boolean): void;
  setIgnoreDebug(on: boolean): void;
  consumeRestoreScroll(): boolean;
  openFile(path: string, force?: boolean): Promise<void>;
  setActiveFile(path: string | null): void;
  setViewMode(mode: ViewMode): void;
  toggleViewed(path: string): Promise<void>;
  /** Posts to `view` (the one the lines were picked in), or to the view in front. */
  createComment(body: CreateCommentRequest, view?: TargetKey): Promise<Comment | undefined>;
  updateComment(id: string, body: UpdateCommentRequest): Promise<Comment | undefined>;
  deleteComment(id: string): Promise<void>;
  /** The reviewer's side of a comment's thread; false when it did not go through. */
  replyToComment(id: string, body: string): Promise<boolean>;
  exportComments(ids: string[]): Promise<void>;
  copyAllComments(): Promise<void>;
  /** Every comment in the state file, whatever its pool: what a todo's linked comments are looked up in. */
  loadAllComments(): Promise<void>;
  /** Link a comment to a todo, or to a new one titled after the comment when `todoId` is null. */
  linkComment(commentId: string, todoId: string | null): Promise<void>;
  unlinkComment(todoId: string, commentId: string): Promise<void>;
  setPanel(panel: Panel): void;
  setIncludeExported(v: boolean): void;
  toggleSelectComment(id: string): void;
  clearSelectedComments(): void;
  jumpToComment(comment: Comment): Promise<void>;
  setReattaching(id: string | null): void;
  setEditor(editor: EditorTarget | null): void;
  focusComment(id: string | null, scroll?: boolean): Promise<void>;
  setRailFilter(filter: RailFilter): void;
  /** The comments tab, open, showing `filter`: where a count of comments elsewhere leads. */
  showComments(filter: RailFilter): void;
  /** Bumped on every state event, for views that summarise the state file and have no other cue. */
  stateSeq: number;
  setRailOpen(open: boolean): void;
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

  /**
   * Bring out the review rail when it has something to show. Everything that writes a
   * comment goes through here, because the editor and the cards only exist inside the rail: with
   * it shut, clicking + on a line would otherwise do nothing visible.
   */
  const openRail = () => {
    get().setRailOpen(true);
  };

  /** What a hand-off does to the comments in memory, until the next load says the same. */
  const markHanded = (ids: string[]) => {
    const now = new Date().toISOString();
    const handed = (c: Comment): Comment => (ids.includes(c.id) ? { ...c, status: c.status === 'active' ? 'exported' : c.status, exportedAt: now } : c);
    set((s) => ({ comments: s.comments.map(handed), allComments: s.allComments.map(handed) }));
  };

  /** The refresh in progress, which a refresh asked for meanwhile waits on (see refresh). */
  let refreshRun: Promise<void> | null = null;

  /** `keep` leaves a diff already on screen there while the new one loads, rather than a placeholder. */
  const loadDiff = async (path: string, keep = false): Promise<FileDiff | undefined> => {
    const { targetKey, files } = get();
    const entry = files.find((f) => f.path === path);
    if (!(keep && get().diffs[path]?.status === 'ok')) set((s) => ({ diffs: { ...s.diffs, [path]: { status: 'loading' } } }));
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
    update: null,
    initError: null,
    prefs: { viewMode: 'unified', autoRefresh: true, railOpen: false, ignoreDebug: true },
    targetKey: 'all',
    root: '',
    files: [],
    checkpoints: [],
    filesLoading: false,
    filesError: null,
    activeFile: null,
    diffs: {},
    comments: [],
    todos: [],
    allComments: [],
    panel: 'orchestration',
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
    stateSeq: 0,
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
          allComments: Object.values(state.targets).flatMap((t) => t.comments),
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
      if (options?.reveal !== false) get().setPanel('diff');
      // The checkpoints are the worktree's, not the target's: moving between its targets keeps them.
      const sameWorktree = tryParseTargetKey(key)?.worktree === tryParseTargetKey(get().targetKey)?.worktree;
      set({
        targetKey: key,
        files: [],
        ...(sameWorktree ? {} : { checkpoints: [] }),
        diffs: {},
        activeFile: null,
        comments: [],
        filesError: null,
        selectedCommentIds: [],
        reattaching: null,
        editor: null,
        focusedCommentId: null,
      });
      api.patchPrefs({ lastTarget: key }).catch(() => undefined);
      await get().loadFiles();
      if (get().targetKey !== key) return;
      // A review starts by reading, so the diff opens on the first file rather than on a page
      // that explains how to open one. Refreshes keep whatever is already in front.
      const first = get().files[0];
      // A slow listing must not reopen the diff after the user has left for another panel.
      if (first && !get().activeFile && get().panel === 'diff') await get().openFile(first.path);
    },

    async loadFiles() {
      const key = get().targetKey;
      set({ filesLoading: true, filesError: null });
      // Another page may have taken or dropped one; they are listed wherever the files are.
      void get().loadCheckpoints();
      try {
        // Re-attach comments first so the listings carry fresh comment state.
        await api.reanchor(key).catch(() => undefined);
        const keep = (files: FileEntry[]) => (get().activeFile && files.some((f) => f.path === get().activeFile) ? get().activeFile : null);

        const res = await api.files(key);
        if (get().targetKey !== key) return;
        set({
          files: res.files,
          root: res.root,
          comments: res.comments,
          filesLoading: false,
          activeFile: keep(res.files),
        });
      } catch (e) {
        if (get().targetKey !== key) return;
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

    async loadCheckpoints() {
      const key = get().targetKey;
      try {
        const { checkpoints } = await api.checkpoints(key);
        if (get().targetKey === key) set({ checkpoints });
      } catch {
        // A worktree that is gone fails its listing too, which says so; this has nothing to add.
      }
    },

    async createCheckpoint() {
      const key = get().targetKey;
      try {
        const res = await api.createCheckpoint(key);
        get().showToast(res.unchanged ? `工作区和检查点 #${res.checkpoint.id} 一样，没有新建` : `已建检查点 #${res.checkpoint.id}`);
        // Taking one from a checkpoint view is closing that round: the next starts from the new one.
        if (tryParseTargetKey(key)?.kind === 'checkpoint' && res.targetKey !== key) await get().setTarget(res.targetKey);
        else await get().loadCheckpoints();
      } catch (e) {
        fail(e);
      }
    },

    async deleteCheckpoint(id) {
      const key = get().targetKey;
      const target = tryParseTargetKey(key);
      try {
        await api.deleteCheckpoint(key, id);
        get().showToast(`已删除检查点 #${id}`);
        if (target?.kind === 'checkpoint' && target.id === id) {
          // Back to the newest one left, or to the working tree when that was the last.
          const wt = target.worktree ? { worktree: target.worktree } : {};
          const next = get()
            .checkpoints.filter((c) => c.id !== id)
            .at(-1);
          await get().setTarget(formatTargetKey(next ? { kind: 'checkpoint', id: next.id, ...wt } : { kind: 'all', ...wt }));
        } else await get().loadCheckpoints();
      } catch (e) {
        fail(e);
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

    setIgnoreDebug(on) {
      set((s) => ({ prefs: { ...s.prefs, ignoreDebug: on } }));
      api.patchPrefs({ ignoreDebug: on }).catch(fail);
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

    async toggleViewed(path) {
      // Apply the response only if the user is still reviewing the same comparison.
      const key = get().targetKey;
      const entry = get().files.find((f) => f.path === path);
      if (!entry) return;
      const patch = (p: Partial<FileEntry>) => set((s) => (s.targetKey === key ? { files: s.files.map((f) => (f.path === path ? { ...f, ...p } : f)) } : {}));
      const next = !entry.viewed;
      patch({ viewed: next, changed: false });
      try {
        await api.setViewed(key, path, next, entry.contentHash);
      } catch (e) {
        fail(e);
        patch({ viewed: !next });
      }
    },

    async createComment(body, view) {
      try {
        const c = await api.createComment(view ?? get().targetKey, body);
        // The pool in front is the view's own unless the reviewer has since left for another one.
        const here = commentScopeKey(c.targetKey) === commentScopeKey(get().targetKey);
        set((s) => ({ comments: here ? [...s.comments, c] : s.comments, editor: null, focusedCommentId: here ? c.id : s.focusedCommentId }));
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
          todos: s.todos.map((t) => (t.commentIds?.includes(id) ? { ...t, commentIds: t.commentIds.filter((x) => x !== id) } : t)),
          allComments: s.allComments.filter((x) => x.id !== id),
        }));
      } catch (e) {
        fail(e);
      }
    },

    async replyToComment(id, body) {
      try {
        const c = await api.replyComment(get().targetKey, id, body);
        set((s) => ({ comments: s.comments.map((x) => (x.id === id ? c : x)) }));
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async onStateChanged() {
      // What only the state file says changed — an agent's `warden reply` above all, and the
      // checkpoint a hand-off takes. The pool is re-read, not re-anchored: nothing about the code moved.
      const key = get().targetKey;
      set((s) => ({ stateSeq: s.stateSeq + 1 }));
      void get().loadCheckpoints();
      if (get().panel === 'orchestration') {
        void get().loadAllComments();
        void get().loadTodos();
      }
      try {
        const res = await api.comments(key);
        if (get().targetKey === key) set({ comments: res.comments });
      } catch {
        /* the next repository refresh carries them anyway */
      }
    },

    async exportComments(ids) {
      if (ids.length === 0) {
        get().showToast('没有可复制的评论');
        return;
      }
      try {
        // The text first, the clipboard next, and only then the hand-off: a clipboard that refused
        // the text must not leave the comments marked as delivered.
        const res = await api.exportComments(ids, true);
        await copyText(res.text);
        await api.exportComments(res.commentIds);
        markHanded(res.commentIds);
        get().showToast(`已复制 ${res.count} 条评论`);
      } catch (e) {
        fail(e);
      }
    },

    async copyAllComments() {
      const { comments, includeExported } = get();
      const ids = comments.filter((c) => awaitsAgent(c) || (includeExported && c.status === 'exported')).map((c) => c.id);
      await get().exportComments(ids);
    },

    async loadAllComments() {
      try {
        const state = await api.state();
        set({ allComments: Object.values(state.targets).flatMap((t) => t.comments) });
      } catch (e) {
        fail(e);
      }
    },

    async linkComment(commentId, todoId) {
      const todo = todoId ? get().todos.find((t) => t.id === todoId) : undefined;
      if (todo) {
        if (todo.commentIds?.includes(commentId)) return;
        await get().updateTodo(todo.id, { commentIds: [...(todo.commentIds ?? []), commentId] });
        get().showToast(`已加入待办「${todo.title}」`);
        return;
      }
      const comment = get().comments.find((c) => c.id === commentId) ?? get().allComments.find((c) => c.id === commentId);
      if (!comment) return;
      // The comment's first line is what the task is about; the reviewer retitles it in place.
      const title =
        comment.body
          .split('\n')
          .find((l) => l.trim())
          ?.trim()
          .slice(0, 80) || comment.filePath;
      const created = await get().createTodo({ title, body: '', branch: branchOf(get().repo, get().root), commentIds: [commentId] });
      if (created) get().showToast(`已新建待办「${created.title}」`);
    },

    async unlinkComment(todoId, commentId) {
      const todo = get().todos.find((t) => t.id === todoId);
      if (!todo) return;
      await get().updateTodo(todoId, { commentIds: (todo.commentIds ?? []).filter((x) => x !== commentId) });
    },

    setPanel(panel) {
      if (panel === get().panel) return;
      set((s) => ({ panel, prefs: { ...s.prefs, lastPanel: panel } }));
      api.patchPrefs({ lastPanel: panel }).catch(fail);
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
      // Historical comments retain the comparison their line numbers refer to.
      if (comment.targetKey !== get().targetKey) {
        await get().setTarget(comment.targetKey);
      }
      await get().openFile(comment.filePath);
      openRail();
      set({
        railFilter: 'all',
        focusedCommentId: comment.id,
        jumpTo: { file: comment.filePath, side: comment.side, line: comment.endLine, nonce: Date.now() },
      });
    },

    setReattaching(id) {
      set({ reattaching: id, editor: id ? null : get().editor });
      if (id) get().showToast('点击或拖选代码行，重新定位评论');
    },

    setEditor(editor) {
      set({ editor, focusedCommentId: editor ? null : get().focusedCommentId });
      // The editor is a card in the rail, so writing a comment has to bring the rail out.
      if (editor) openRail();
    },

    async focusComment(id, scroll = true) {
      set({ focusedCommentId: id });
      if (id) openRail();
      if (!id || !scroll) return;
      const c = get().comments.find((x) => x.id === id) ?? get().allComments.find((x) => x.id === id);
      if (!c || c.status === 'orphaned') return;
      await get().jumpToComment(c);
    },

    setRailFilter(filter) {
      set({ railFilter: filter });
    },
    showComments(filter) {
      get().setPanel('diff');
      set({ railFilter: filter });
      openRail();
    },
    setRailOpen(open) {
      if (get().prefs.railOpen === open) return;
      set((s) => ({ prefs: { ...s.prefs, railOpen: open } }));
      api.patchPrefs({ railOpen: open }).catch(fail);
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
          run: () =>
            void get().createTodo({ title: todo.title, body: todo.body, branch: todo.branch, status: todo.status, commentIds: todo.commentIds, after: prev }),
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
          for (const t of [...gone].reverse())
            await get().createTodo({ title: t.title, body: t.body, branch: t.branch, status: t.status, commentIds: t.commentIds });
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
        // Through the server even without comments: with them, the copy is a hand-off it records,
        // once the clipboard has taken the text.
        const res = await api.exportTodo(id, true);
        await copyText(res.text);
        if (res.count) {
          await api.exportTodo(id);
          markHanded(res.commentIds);
        }
        get().showToast(res.count ? `已复制待办（含 ${res.count} 条评论）` : '已复制待办');
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
