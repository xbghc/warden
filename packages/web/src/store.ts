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
  HunkSelection,
  NvimInstancesResponse,
  Prefs,
  RepoInfo,
  TargetKey,
  Todo,
  UpdateCommentRequest,
  UpdateNotice,
  UpdateTodoRequest,
  ViewMode,
} from '@warden/shared';
import {
  awaitsAgent,
  commentScopeKey,
  formatTargetKey,
  insertAfter,
  isLocalTarget,
  localViewKeys,
  moveBefore,
  stageModeFor,
  tracksViewed,
  tryParseTargetKey,
  type StageMode,
} from '@warden/shared';
import { api, ApiError } from './api';
import { copyText } from './lib/clipboard';

/** Branch the todo list is scoped to: the worktree currently in view, else the repository's. */
export function branchOf(repo: RepoInfo | null, root: string): string {
  if (!repo) return '';
  return repo.worktrees.find((w) => w.path === root)?.branch ?? repo.branch;
}

export type DiffState = { status: 'loading' } | { status: 'ok'; diff: FileDiff } | { status: 'error'; message: string };
/** What the middle of the window is showing. */
export type Panel = 'diff' | 'commits' | 'worktrees';

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
  /**
   * The view the lines were picked in. Switching between the local views keeps the draft, but its
   * line numbers belong to this view's diff: in another one they point at other code.
   */
  view: TargetKey;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
}

export type RailFilter = 'file' | 'all' | 'unexported' | 'replied';
/** The three notebooks of the right-hand rail — everything the reviewer writes. */
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

/** Whether the target in front keeps the 已读 mark; the local views leave that to staging. */
export function useTracksViewed(): boolean {
  return useStore((s) => {
    const t = tryParseTargetKey(s.targetKey);
    return !!t && tracksViewed(t);
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
  /** A newer warden on npm, once the server's check has come back with one. */
  update: UpdateNotice | null;
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
  /** Width the sidebar was dragged to, in px; kept here so it survives a panel switch. */
  sidebarWidth: number;
  /**
   * The sidebar's slot element. The commit and worktree panels render their own controls into it
   * through a portal: the controls belong in the left column, but their state is bound up with
   * the list in the middle, and splitting the two would mean lifting a dozen fields.
   */
  sideSlot: HTMLElement | null;
  /** A stage request is in flight; the controls wait for it rather than queue a second one. */
  staging: boolean;

  init(): Promise<void>;
  setTarget(key: TargetKey): Promise<void>;
  /** Re-reads /api/repo after a worktree was made or removed; the target is left alone. */
  reloadRepo(): Promise<void>;
  copyUpdateCommand(): Promise<void>;
  /** Move between the local views without dropping comments, selection or the editor draft. */
  switchView(key: TargetKey, nextActiveFile?: string | null): Promise<void>;
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
  /** `view` defaults to the current one; the two sidebar blocks pass their own. */
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
  /** The comments tab, open, showing `filter`: where a count of comments elsewhere leads. */
  showComments(filter: RailFilter): void;
  /** Bumped on every state event, for views that summarise the state file and have no other cue. */
  stateSeq: number;
  /** Picking a tab also opens the rail; shutting it is the ✕, the top bar's switch or Esc. */
  setRailTab(tab: RailTab): void;
  setRailOpen(open: boolean): void;
  setSidebarWidth(px: number): void;
  setSideSlot(el: HTMLElement | null): void;
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

  /**
   * Bring the rail out on the tab that is about to have something in it. Everything that writes a
   * comment goes through here, because the editor and the cards only exist inside the rail: with
   * it shut, clicking + on a line would otherwise do nothing visible.
   */
  const openRail = (tab: RailTab) => {
    set({ railTab: tab });
    get().setRailOpen(true);
  };

  /** What a hand-off does to the comments in memory, until the next load says the same. */
  const markHanded = (ids: string[]) => {
    const now = new Date().toISOString();
    const handed = (c: Comment): Comment => (ids.includes(c.id) ? { ...c, status: c.status === 'active' ? 'exported' : c.status, exportedAt: now } : c);
    set((s) => ({ comments: s.comments.map(handed), allComments: s.allComments.map(handed) }));
  };

  /** The listing behind a view key, whether or not it is the one in front. */
  const entriesOf = (view: TargetKey): FileEntry[] => {
    const s = get();
    if (view === s.targetKey) return s.files;
    const t = tryParseTargetKey(view);
    if (!t || !isLocalTarget(t)) return [];
    return t.kind === 'working' ? s.unstaged : t.kind === 'staged' ? s.staged : s.allFiles;
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
    update: null,
    initError: null,
    prefs: { viewMode: 'unified', nvimSocketByRoot: {}, autoRefresh: true, railOpen: false, ignoreDebug: true },
    targetKey: 'working',
    root: '',
    files: [],
    unstaged: [],
    staged: [],
    allFiles: [],
    checkpoints: [],
    filesLoading: false,
    filesError: null,
    activeFile: null,
    diffs: {},
    comments: [],
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
    stateSeq: 0,
    railTab: 'comments',
    stageSel: null,
    staging: false,
    sidebarWidth: 280,
    sideSlot: null,

    async init() {
      // Nothing waits on this: the server holds the answer until its registry request settles, and a
      // page that never hears back is simply one without the notice.
      void api.update().then(
        (update) => set({ update }),
        () => {},
      );
      try {
        const [repo, state] = await Promise.all([api.repo(), api.state()]);
        set({ repo, prefs: state.prefs, todos: state.todos, allComments: Object.values(state.targets).flatMap((t) => t.comments), root: repo.root });
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

    async setTarget(key) {
      // The checkpoints are the worktree's, not the target's: moving between its targets keeps them.
      const sameWorktree = tryParseTargetKey(key)?.worktree === tryParseTargetKey(get().targetKey)?.worktree;
      set({
        targetKey: key,
        files: [],
        unstaged: [],
        staged: [],
        allFiles: [],
        ...(sameWorktree ? {} : { checkpoints: [] }),
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
      // A review starts by reading, so the diff opens on the first file rather than on a page
      // that explains how to open one. Refreshes keep whatever is already in front.
      const first = get().files[0];
      if (first && !get().activeFile) await get().openFile(first.path);
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
      // Another page may have taken or dropped one; they are listed wherever the files are.
      void get().loadCheckpoints();
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
          await get().setTarget(formatTargetKey(next ? { kind: 'checkpoint', id: next.id, ...wt } : { kind: 'working', ...wt }));
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

    async toggleViewed(path) {
      // Only a target with a single tree keeps the mark (`tracksViewed`), so the listing in front is
      // the one the entry is in — unless the target was switched while the request was out.
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
      if (get().railTab === 'todos') void get().loadAllComments();
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
        get().showToast(`已复制 ${res.count} 条评论到剪贴板`);
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
      // No check against the last scan: nvim comes and goes while the page stays open, so the
      // server finds the instance when the click arrives, and the header catches up afterwards.
      const { nvim, root } = get();
      const absPath = `${root.replace(/\/+$/, '')}/${filePath}`;
      try {
        const res = await api.nvimOpen({ root, socket: nvim?.selected, absPath, line });
        if (res.socket !== nvim?.selected) void get().scanNvim();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'nvim_none') get().showToast('没有在这个仓库里打开的 nvim', 'error');
        else if (e instanceof ApiError && e.code === 'nvim_ambiguous') get().showToast('这个仓库里开着多个 nvim，在顶栏的 nvim 设置里选一个', 'error');
        else fail(e);
        void get().scanNvim();
      }
    },

    setPanel(panel) {
      set({ panel });
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
      // The editor is a card in the rail, so writing a comment has to bring the rail out.
      if (editor) openRail('comments');
    },

    async focusComment(id, scroll = true) {
      set({ focusedCommentId: id });
      if (id) openRail('comments');
      if (!id || !scroll) return;
      const c = get().comments.find((x) => x.id === id) ?? get().allComments.find((x) => x.id === id);
      if (!c || c.status === 'orphaned') return;
      await get().jumpToComment(c);
    },

    setRailFilter(filter) {
      set({ railFilter: filter });
    },
    showComments(filter) {
      set({ railFilter: filter });
      openRail('comments');
    },
    setRailTab(tab) {
      set({ railTab: tab });
      get().setRailOpen(true);
      if (tab === 'todos') {
        void get().loadTodos();
        void get().loadAllComments();
      }
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
        label: '撤消',
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
        get().showToast(res.count ? `已复制待办（含 ${res.count} 条评论）到剪贴板` : '已复制待办到剪贴板');
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
        await api.stage(key, { path, contentHash, hunks, skipDebug: get().prefs.ignoreDebug });
      } catch (e) {
        set({ staging: false });
        if (e instanceof ApiError && e.code === 'debug_only') {
          get().showToast('剩下的改动都是调试代码，没有暂存；确实要暂存的话，展开后逐行选中', 'info');
          return false;
        }
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
      toastTimer = setTimeout(
        () => {
          if (get().toast?.id === id) set({ toast: null });
        },
        action ? 8000 : kind === 'error' ? 6000 : 3000,
      );
    },
  };
});
