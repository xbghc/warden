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
}

export interface TargetState {
  /** filePath -> contentHash at the time it was marked viewed */
  viewed: Record<string, string>;
  comments: Comment[];
}

export interface ReviewState {
  schemaVersion: 1;
  repoRoot: string;
  targets: Record<TargetKey, TargetState>;
  issues: Issue[];
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

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  parents: string[];
}

export interface CommitsResponse {
  commits: CommitInfo[];
  hasMore: boolean;
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

export interface ApiError {
  error: string;
  code?: string;
}
