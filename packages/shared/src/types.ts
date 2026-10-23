// ---------------------------------------------------------------------------
// Core data model shared between server and web. Keep this file free of any
// runtime dependency so it can be bundled into both sides.
// ---------------------------------------------------------------------------

export type TargetKey = string;

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileSummary {
  path: string;
  /** Old path when the file was renamed. */
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** sha1 of the diff content of this file; used to detect content changes. */
  contentHash: string;
  /** True when the file is untracked in the working tree (only for working/all targets). */
  untracked?: boolean;
  /**
   * A merge, rebase or cherry-pick stopped on this file (working view only). Its diff is against
   * HEAD, conflict markers and all; it is resolved in the terminal and `git add`ed, not staged here.
   */
  conflicted?: boolean;
  oldMode?: string;
  newMode?: string;
}

export interface FileDiff extends FileSummary {
  hunks: Hunk[];
}

export interface Hunk {
  /** sha1 of hunk content. */
  hash: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the trailing `@@` on the hunk header (function context). */
  header: string;
  lines: DiffLine[];
}

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  oldLineNo?: number;
  newLineNo?: number;
  content: string;
  /** Set when the line is the last of the file and has no trailing newline. */
  noNewline?: boolean;
}

export type DiffSide = 'old' | 'new';

export type ViewMode = 'unified' | 'split';
export type Panel = 'orchestration' | 'diff' | 'commits';

export interface Prefs {
  viewMode: ViewMode;
  lastTarget?: TargetKey;
  /** The content last opened; selecting a target or file opens its diff directly. */
  lastPanel?: Panel;
  /** Re-run the refresh cycle when the watcher reports a repository change. */
  autoRefresh: boolean;
  /** How the last new slot was made; the checkout form offers the same kind first next time. */
  slotKind?: SlotKind;
}

/**
 * What a slot is. `shared`: a linked worktree of Warden's external shared repository.
 * `clone`: a repository of its own beside the main checkout — its own `.git`,
 * hooks and refs, talking to the server by itself — for repositories whose tooling does not cope
 * with linked worktrees. `worktree`: a linked worktree sharing the main checkout's `.git`.
 */
export type SlotKind = 'shared' | 'clone' | 'worktree';

export type TodoStatus = 'open' | 'done';

/** A branch-scoped note that survives commits. */
export interface Todo {
  id: string;
  /** Branch the todo was created on; short sha when HEAD was detached. */
  branch: string;
  title: string;
  /** Markdown, may be empty. */
  body: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewState {
  schemaVersion: 1;
  repoRoot: string;
  /** Opaque historical target metadata retained for compatibility. */
  targets: Record<TargetKey, Record<string, unknown>>;
  todos: Todo[];
  prefs: Prefs;
  /** A requirement branch and the small changes that are integrated into it. */
  workflow?: DevelopmentWorkflow;
  workspaceConfig?: WorkspaceConfig;
  /** Durable ownership record for the independent preview and an interrupted publication. */
  connectionPreview?: PreviewResponse & {
    directory?: string;
    tree?: string;
    sandbox?: string;
    snapshot?: string;
    migrating?: boolean;
    pending?: { tree: string; sandbox: string; snapshot: string; response: PreviewResponse };
  };
  historyDraft?: HistoryPreviewResponse & {
    sandbox: string;
    branch: string;
    applying?: boolean;
    backups?: SafetyBackup[];
  };
}

export interface WorkspaceConfig {
  hooks: { create?: string; reuse?: string };
  previewSetup?: string;
}

export interface WorkspaceHookResult {
  event: 'create' | 'reuse';
  command: string;
  status: 'running' | 'succeeded' | 'failed';
  exitCode?: number | null;
  output?: string;
}

export interface DevelopmentWorkflow {
  developmentBranch: string;
  changes: WorkflowTask[];
}

export interface ChangePlan {
  id: string;
  title: string;
  developmentBranch: string;
  body?: string;
  acceptance?: string;
  /** Legacy planning metadata; never blocks allocation. */
  dependsOn?: string[];
  agent?: string;
  /** Kept when importing old checklists; a checked box is not evidence of a Git commit. */
  legacyTodo?: { branch: string; status: TodoStatus };
  createdAt: string;
}

export interface PlannedChange extends ChangePlan {
  status: 'planned' | 'archived';
  branch?: never;
  worktree?: never;
  base?: never;
  submittedHead?: never;
  integration?: never;
  sync?: never;
  cleanupError?: never;
}

export type WorkflowTask = PlannedChange | DevelopmentChange;

export interface DevelopmentChange extends ChangePlan {
  branch: string;
  worktree: string;
  /** The exact development commit this task last incorporated. */
  base: string;
  /** Source tip of the last delivery; excludes already delivered commits until the next rebase. */
  sourceBase?: string;
  deliveries?: ChangeDelivery[];
  status: 'working' | 'ready' | 'integrating' | 'accepted';
  createdAt: string;
  /** An explicit handoff: the agent must stop writing until it resumes the task. */
  submittedHead?: string;
  sync?: { status: 'pending' | 'conflict' | 'error'; message: string; target: string };
  /** Kept through interrupted synchronization; removed after successful bookkeeping. */
  rebaseBackups?: SafetyBackup[];
  /** Recorded before staging on the development checkout. A commit exists only after validation. */
  integration?: {
    id?: string;
    source: string;
    sourceBase?: string;
    tree?: string;
    /** Fingerprint of the composed delivery, before any user or hook edits. */
    indexFingerprint?: string;
    parent: string;
    worktree?: string;
    prepared?: boolean;
    commit?: string;
    message: string;
    error?: string;
  };
  acceptedAt?: string;
  cleanupError?: string;
  workspaceHook?: WorkspaceHookResult;
}

export interface ChangeDelivery {
  id: string;
  source: string;
  sourceBase: string;
  parent: string;
  commit: string;
  message: string;
  createdAt: string;
}

export interface RebaseCheck {
  changeId: string;
  sourceHead: string;
  developmentHead: string;
  status: 'current' | 'ready' | 'conflict' | 'blocked' | 'unknown';
  checkedAt: string;
  message?: string;
  files?: string[];
}

export interface RebaseResponse {
  checks: RebaseCheck[];
}

export interface RebaseBatchRequest {
  items: { changeId: string; sourceHead: string; developmentHead: string }[];
}

export interface RebaseBatchResponse {
  results: { changeId: string; status: 'updated' | 'skipped' | 'failed'; message?: string }[];
}

export interface PreviewResponse {
  developmentBranch?: string;
  developmentHead?: string;
  worktree?: string;
  connectedIds: string[];
  status: 'disconnected' | 'current' | 'stale' | 'paused';
  updatedAt?: string;
  message?: string;
  files: { path: string; changeIds: string[] }[];
  conflicts?: string[];
  syncStatus?: 'pending' | 'updating' | 'synced' | 'conflict' | 'error';
  baselineTree?: string;
  sources?: { changeId: string; observedTree: string; appliedTree?: string; status: 'pending' | 'updating' | 'synced' | 'conflict' | 'error' }[];
  setup?: { command: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; exitCode?: number | null; output?: string };
}

export interface HistoryEntry {
  sha: string;
  parents: string[];
  message: string;
  author: string;
  date: string;
  changeId?: string;
  deliveryId?: string;
}

export interface HistoryResponse {
  branch: string;
  head: string;
  /** Oldest first; only the latest 100 commits are offered for selection. */
  commits: HistoryEntry[];
}

export interface HistoryPreviewRequest {
  head: string;
  start: string;
  commits: { sha: string; message: string }[];
}

export interface HistoryPreviewResponse {
  id?: string;
  head: string;
  newHead?: string;
  canApply: boolean;
  contentChanged: boolean;
  conflicts: string[];
  message?: string;
  commits: { source: string; sha: string; message: string }[];
}

export interface WorkflowResponse {
  workflow: DevelopmentWorkflow | null;
  workspaceConfig?: WorkspaceConfig;
  developmentHead?: string;
  preparation?: DevelopmentPreparation;
  error?: string;
  /** Notes on other branches can be explicitly brought into this requirement's plan. */
  legacyTodos?: Todo[];
}

/** Live, read-only inspection of the one task being validated on the development branch. */
export interface DevelopmentPreparation {
  changeId: string;
  worktree?: string;
  state: 'testing' | 'committed' | 'blocked';
  head?: string;
  indexFingerprint?: string;
  canCommit?: boolean;
  canRecord?: boolean;
  changed?: boolean;
  message?: string;
}

export interface CreateChangeRequest {
  title: string;
  body?: string;
  acceptance?: string;
  /** Legacy planning metadata; never blocks allocation. */
  dependsOn?: string[];
  /** Adopt an existing numbered checkout instead of creating a task branch. */
  worktree?: string;
}

export interface UpdateChangeRequest {
  title?: string;
  body?: string;
  acceptance?: string;
  /** Legacy planning metadata; never blocks allocation. */
  dependsOn?: string[];
  status?: 'planned' | 'archived';
}

export interface StartChangeRequest {
  agent?: string;
  kind?: SlotKind;
  worktree?: string;
}

export interface PrepareChangeRequest {
  sourceHead: string;
  developmentHead: string;
  sourceBase?: string;
}

export interface DeliverChangeRequest extends PrepareChangeRequest {
  message: string;
}

export type AcceptChangeRequest = { mode: 'commit'; developmentHead: string; indexFingerprint: string; message: string } | { mode: 'record'; commit: string };

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string;
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  /**
   * A slot that is a clone of its own rather than a linked worktree (see `SlotKind`). Its branches
   * are its own: nothing is exchanged with the main checkout or the other slots, each one fetches
   * from and pushes to the server by itself.
   */
  clone?: boolean;
  /** A task worktree in Warden's external common repository, independent of the primary Git store. */
  shared?: boolean;
  /** A clone's remote default branch (`origin/main`): what it is compared with, and where a new branch starts. */
  trunk?: string;
}

/**
 * Commits a worktree's HEAD has that `base` lacks (`ahead`), and the other way round (`behind`).
 * `upstream`: `base` is the branch's upstream, so the two are what is not pushed and what is not
 * pulled yet. `base`: the checkout has no upstream, or one that is gone, and `base` is the branch
 * the main worktree has checked out right now — the base a sibling worktree is reviewed against,
 * which need not be `main`; nothing ahead there means merged. `trunk`: a clone with no upstream, or
 * one that is gone, counted against its remote's default branch (`origin/main`, as `origin/HEAD`
 * names it), the branch its work goes into — a clone shares nothing with the main worktree to be
 * compared with; nothing ahead means merged there.
 */
export interface WorktreeComparison {
  kind: 'upstream' | 'base' | 'trunk';
  /** As git abbreviates it (`origin/topic`, `develop`), or `HEAD abc1234` for a detached main worktree. */
  base: string;
  ahead: number;
  behind: number;
}

/** A worktree as the management panel lists it: the review-time fields plus what removing it needs. */
export interface WorktreeDetail extends WorktreeInfo {
  /** Entries `git status` reports; -1 means status could not be read and the slot is not reusable. */
  dirty: number;
  /** git still lists it but its directory is gone; removing it drops the entry, nothing else. */
  prunable: boolean;
  /**
   * The directory is there but is not a checkout of this repository — another repository was cloned
   * or initialised where a slot used to be. warden writes nothing in it.
   */
  foreign?: boolean;
  /** A rebase, merge, cherry-pick, revert or bisect is under way in it, which a release or reuse would throw away. */
  busy?: string;
  /**
   * Its number when the checkout is one of warden's slots — `<repo>-<n>` beside the main worktree,
   * the directories that outlive their branch and get checked out into again. A worktree made
   * anywhere else has none.
   */
  slot?: number;
  /** A slot with nothing on it, detached and clean, that the next checkout may take over. */
  free: boolean;
  comparison?: WorktreeComparison;
  /** The upstream the branch is set to track when that ref no longer exists, as in `[origin/topic: gone]`. */
  upstreamGone?: string;
  comparisonError?: string;
  /** A free clone/shared slot's local branches, separate from primary development-branch choices. */
  branches?: BranchInfo[];
}

export interface BranchInfo {
  name: string;
  sha: string;
  /** Worktree the branch is checked out in, if any; a branch can be in only one at a time. */
  worktree?: string;
}

/** A slot by number, with the directory that is, or would be, its checkout. */
export interface WorktreeSlot {
  slot: number;
  path: string;
}

export interface WorktreesResponse {
  worktrees: WorktreeDetail[];
  /** Local branches only: a remote can carry thousands, so `GET /api/worktrees/remotes` asks about one name. */
  branches: BranchInfo[];
  /** The slot a checkout makes when it takes no free one: the lowest number with no directory yet. */
  newSlot: WorktreeSlot;
  /** How the form offers to make that slot: the kind made last time, shared until then. */
  slotKind: SlotKind;
  /** The main worktree's remote default branch, which a new clone starts a branch from unless told otherwise. */
  trunk?: string;
}

export interface CreateWorktreeRequest {
  branch: string;
  /**
   * Where a new `branch` starts. Omitted, a local branch is checked out, one only a remote has is
   * checked out tracking it, and any other name starts from main/master. For a name that already
   * exists it is refused, except as the remote branch to track when several remotes have the name.
   */
  base?: string;
  /**
   * The slot to check out into: a free one, or a number no slot has yet, which is made. Omitted,
   * the lowest free slot, else a new one. Never a path — the server composes those.
   */
  slot?: number;
  /** How a new slot is made; a slot that exists is what it is. Omitted, a worktree. */
  kind?: SlotKind;
  /**
   * Into a clone: `git fetch --all` there first, so the branch and its base are read as the server
   * has them now rather than as of the clone's last fetch. Reaches the server with the user's own
   * credentials; a fetch that fails stops the checkout.
   */
  fetch?: boolean;
}

/** `GET /api/worktrees/remotes?branch=`: `<remote>/<branch>` for each remote that has the branch. */
export interface RemoteBranchesResponse {
  remotes: string[];
}

export interface CreateWorktreeResponse {
  worktree: WorktreeInfo;
  slot: number;
  /** The slot was there and was switched to the branch: its directory, dependencies included, is as it was. */
  reused: boolean;
}

export interface ReleaseWorktreeRequest {
  path: string;
  /** Discard the uncommitted changes; only ever sent after the reviewer confirmed a 409 (`worktree_dirty`). */
  force?: boolean;
  /**
   * Also `git branch -d` the branch it held; one that is not merged is kept and reported. In a
   * clone, only a branch whose upstream is there and has all of it: without one, `-d` would check
   * the detached HEAD, which is the branch itself.
   */
  deleteBranch?: boolean;
}

/** What became of the branch, as after a removal. */
export type ReleaseWorktreeResponse = RemoveWorktreeResponse;

export interface RemoveWorktreeRequest {
  path: string;
  /**
   * `--force`: only ever sent after the reviewer confirmed a 409 (`worktree_dirty`, `needs_force`).
   * For a clone, the confirmation that what the directory alone holds may go with it.
   */
  force?: boolean;
  /** Also `git branch -d` the worktree's branch; a branch that is not merged is kept and reported. A clone's branches go with it. */
  deleteBranch?: boolean;
}

export interface RemoveWorktreeResponse {
  ok: true;
  branchDeleted: boolean;
  /** Verified local copy retained before the operation. */
  backup?: SafetyBackup;
  /** Why the branch was kept, when deleting it was asked for. */
  branchError?: string;
}

export interface SafetyBackup {
  id: string;
  path: string;
  reason: 'release' | 'remove' | 'rebase' | 'history';
  createdAt: string;
  worktree: string;
  head: string;
}

export interface RepoInfo {
  /** Root of the repository/worktree the server was started in. */
  root: string;
  /** Root of the main worktree (shared state is keyed by this). */
  commonRoot: string;
  branch: string;
  head: string;
  worktrees: WorktreeInfo[];
  /** Default target key (last used comparison or `all`). */
  defaultTarget: TargetKey;
  /** Trunk a `base` target is offered against by default: `main` or `master`, whichever exists. */
  defaultBase?: string;
}

/** A release newer than the running one; `GET /api/update` answers `null` when there is none. */
export interface UpdateNotice {
  current: string;
  latest: string;
  /** Command that installs it, matched to how this copy was started (npx, or a global install). */
  command: string;
}

export type FileEntry = FileSummary;

export interface FilesResponse {
  targetKey: TargetKey;
  /** Root directory of the worktree this target refers to. */
  root: string;
  files: FileEntry[];
}

export interface FullFileResponse {
  path: string;
  side: DiffSide;
  /** null when the file doesn't exist on that side. */
  content: string | null;
}

/** A branch or tag that points at a commit, as `git log --decorate` lists them. */
export interface CommitRef {
  name: string;
  kind: 'branch' | 'tag';
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  parents: string[];
  /** Branches (local and remote) and tags on this commit; the branch HEAD sits on comes first. */
  refs: CommitRef[];
  /** HEAD of the worktree the log was taken in is this commit. */
  head: boolean;
}

export interface CommitsResponse {
  commits: CommitInfo[];
  hasMore: boolean;
}

/** Where HEAD forked off a base ref: what the Commits panel reports beside its *Branch vs* field. */
export interface ForkPointResponse {
  /** The ref the fork point was computed against, as requested. */
  base: string;
  /** `merge-base(base, HEAD)`: the last commit the branch shares with `base`. */
  sha: string;
  /** Commits on HEAD that `base` does not have. */
  ahead: number;
  /** Commits that landed on `base` after the fork. */
  behind: number;
}

/** Reorder: put the item right before `before`, or last when null. */
export interface MoveRequest {
  before: string | null;
}

export interface CreateTodoRequest {
  title: string;
  body?: string;
  /** Defaults to the current branch of `root` (or of the repository root). */
  branch?: string;
  root?: string;
  status?: TodoStatus;
  /** Put the new todo right after this one; omitted = at the top of the list. */
  after?: string;
}

export interface UpdateTodoRequest {
  title?: string;
  body?: string;
  status?: TodoStatus;
}

export interface TodosResponse {
  todos: Todo[];
  /** Branch the listing was filtered by, when one was requested. */
  branch?: string;
}

/** Payload of the `changed` SSE event emitted by the repository watcher. */
export interface ChangeEvent {
  type: 'changed';
  head: string;
  branch: string;
  at: string;
}

/** The state file was written by this server or another Warden instance. */
export interface StateEvent {
  type: 'state';
  at: string;
}

export interface ApiError {
  error: string;
  code?: string;
}
