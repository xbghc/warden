import type {
  BranchInfo,
  RemoveWorktreeResponse,
  SlotKind,
  TargetKey,
  Todo,
  TodoStatus,
  WorktreeDetail as CheckoutDetail,
  WorktreeInfo,
  WorktreeSlot,
} from '@warden/shared';

// Retired HTTP contracts remain local to the regression harness.

/** A release newer than the running one; `GET /api/update` answers `null` when there is none. */
export interface UpdateNotice {
  current: string;
  latest: string;
  /** Command that installs it, matched to how this copy was started (npx, or a global install). */
  command: string;
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

/** Additional presentation data for the retired workspace management page. */
export interface WorktreeDetail extends CheckoutDetail {
  comparison?: WorktreeComparison;
  /** The upstream the branch is set to track when that ref no longer exists, as in `[origin/topic: gone]`. */
  upstreamGone?: string;
  comparisonError?: string;
  /** A free clone/shared slot's local branches, separate from base branch choices. */
  branches?: BranchInfo[];
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

/** `GET /api/worktrees/remotes?branch=`: `<remote>/<branch>` for each remote that has the branch. */
export interface RemoteBranchesResponse {
  remotes: string[];
}

/** What became of the branch, as after a removal. */
export type ReleaseWorktreeResponse = RemoveWorktreeResponse;

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
