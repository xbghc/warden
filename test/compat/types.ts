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
