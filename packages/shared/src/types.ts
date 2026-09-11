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
  /** sha1 of the diff content of this file; used to validate `viewed` state. */
  contentHash: string;
  /** True when the file is untracked in the working tree (only for working/all targets). */
  untracked?: boolean;
  oldMode?: string;
  newMode?: string;
}

export interface FileDiff extends FileSummary {
  hunks: Hunk[];
}

export interface Hunk {
  /** sha1 of hunk content (see anchoring rules). */
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

export type CommentSide = 'old' | 'new';
export type CommentStatus = 'active' | 'exported' | 'orphaned';

export interface CommentAnchor {
  /** sha1 of the full hunk content the comment lives in. */
  hunkHash: string;
  /** sha1 of every covered line (same side). */
  lineHashes: string[];
  /** hashes of up to 3 lines above the range (same side). */
  contextBefore: string[];
  /** hashes of up to 3 lines below the range (same side). */
  contextAfter: string[];
  /** Index of the first covered line among the side-lines of the hunk. */
  hunkLineOffset: number;
}

export interface Comment {
  id: string;
  targetKey: TargetKey;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  /** Original text of the covered lines (for export & orphaned display). */
  codeSnippet: string[];
  body: string;
  status: CommentStatus;
  anchor: CommentAnchor;
  createdAt: string;
  updatedAt: string;
  exportedAt?: string;
}

export type IssueStatus = 'open' | 'closed';

export interface Issue {
  id: string;
  title: string;
  body: string;
  status: IssueStatus;
  commentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type ViewMode = 'unified' | 'split';

export interface Prefs {
  viewMode: ViewMode;
  lastTarget?: TargetKey;
  /** repo/worktree root -> nvim socket path */
  nvimSocketByRoot: Record<string, string>;
  /** Re-run the refresh cycle when the watcher reports a repository change. */
  autoRefresh: boolean;
  /**
   * Whether the right-hand rail is showing. It costs 360px of the code column — most of it on a
   * laptop in split view — so it stays shut until there is something to put in it.
   */
  railOpen: boolean;
}

export interface TargetState {
  /** filePath -> contentHash at the time it was marked viewed */
  viewed: Record<string, string>;
  comments: Comment[];
  /**
   * HEAD sha recorded at the last reanchor of this scope. A different HEAD on the next reanchor
   * means a commit happened, which is what turns "no longer locatable" into a deletion.
   */
  head?: string;
}

export type TodoStatus = 'open' | 'done';

/** A branch-scoped note. Unlike comments, todos are not anchored to code and survive commits. */
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
  targets: Record<TargetKey, TargetState>;
  issues: Issue[];
  todos: Todo[];
  prefs: Prefs;
}

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
}

/** A worktree as the management panel lists it: the review-time fields plus what removing it needs. */
export interface WorktreeDetail extends WorktreeInfo {
  /** Entries `git status` reports: modified, staged and untracked paths together. */
  dirty: number;
  /** git still lists it but its directory is gone; removing it drops the entry, nothing else. */
  prunable: boolean;
  comparison?: { base: string; ahead: number; behind: number; merged: boolean };
  comparisonError?: string;
}

export interface TmuxSession {
  id: string;
  name: string;
  path: string;
}
export interface TmuxSessionsResponse {
  sessions: TmuxSession[];
}
export interface TmuxWindowResponse {
  session: string;
  window: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  /** Worktree the branch is checked out in, if any; a branch can be in only one at a time. */
  worktree?: string;
}

export interface WorktreesResponse {
  worktrees: WorktreeDetail[];
  branches: BranchInfo[];
  /** `<parent of the main worktree>/<repo>-`: a new worktree's path is suggested as this plus its branch. */
  pathPrefix: string;
}

export interface CreateWorktreeRequest {
  path: string;
  branch: string;
  /** Create `branch` from this ref; omitted = check out a branch that exists. */
  base?: string;
}

export interface RemoveWorktreeRequest {
  path: string;
  /** `--force`: only ever sent after the reviewer confirmed a 409 (`worktree_dirty`, `needs_force`). */
  force?: boolean;
  /** Also `git branch -d` the worktree's branch; a branch that is not merged is kept and reported. */
  deleteBranch?: boolean;
}

export interface RemoveWorktreeResponse {
  ok: true;
  branchDeleted: boolean;
  /** Why the branch was kept, when deleting it was asked for. */
  branchError?: string;
}

export interface RepoInfo {
  /** Root of the repository/worktree the server was started in. */
  root: string;
  /** Root of the main worktree (shared state is keyed by this). */
  commonRoot: string;
  branch: string;
  head: string;
  worktrees: WorktreeInfo[];
  /** Default target key (last used or `working`). */
  defaultTarget: TargetKey;
  /** Trunk a `base` target is offered against by default: `main` or `master`, whichever exists. */
  defaultBase?: string;
}

export interface FileEntry extends FileSummary {
  viewed: boolean;
  /** The file changed since it was marked as viewed (viewed flag was dropped). */
  changed: boolean;
}

export interface FilesResponse {
  targetKey: TargetKey;
  /** Root directory of the worktree this target refers to. */
  root: string;
  files: FileEntry[];
  comments: Comment[];
}

export interface FullFileResponse {
  path: string;
  side: CommentSide;
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

export interface NvimInstance {
  socket: string;
  cwd: string;
  pid?: number;
}

export interface NvimInstancesResponse {
  root: string;
  nvimAvailable: boolean;
  instances: NvimInstance[];
  /** Socket currently selected for this root (persisted preference, validated). */
  selected?: string;
  scannedAt: string;
}

export interface ExportResponse {
  text: string;
  count: number;
  commentIds: string[];
}

export interface CreateCommentRequest {
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  body: string;
}

export interface UpdateCommentRequest {
  body?: string;
  /** Re-attach to a new selection. */
  side?: CommentSide;
  startLine?: number;
  endLine?: number;
}

/** Lines of one hunk to stage or unstage; `lines` omitted means the whole hunk. */
export interface HunkSelection {
  /** Index of the hunk in the file diff. */
  index: number;
  /** Indices into `hunk.lines`; context lines are ignored. */
  lines?: number[];
}

export interface StageRequest {
  path: string;
  /** `contentHash` of the diff the selection was made on; a different diff on the server is a 409. */
  contentHash: string;
  /** Omitted: the whole file, mode change included. */
  hunks?: HunkSelection[];
}

export interface StageResponse {
  ok: true;
  /** Changed (add/del) lines the patch carried. */
  lines: number;
}

export interface ReanchorRequest {
  files?: FileDiff[];
}

export interface ReanchorResponse {
  comments: Comment[];
}

export interface ExportRequest {
  commentIds: string[];
}

export interface CreateIssueRequest {
  title: string;
  body?: string;
  commentIds?: string[];
  status?: IssueStatus;
  /** Put the new issue right after this one; omitted = at the top of the list. */
  after?: string;
}

/** Reorder: put the item right before `before`, or last when null. */
export interface MoveRequest {
  before: string | null;
}

export interface UpdateIssueRequest {
  title?: string;
  body?: string;
  status?: IssueStatus;
  commentIds?: string[];
}

export interface NvimOpenRequest {
  socket: string;
  absPath: string;
  line: number;
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

export interface ApiError {
  error: string;
  code?: string;
}
