# Reviewing

What Warden can put under review. Users must review all content they intend to commit; Warden
does not track per-file read status or ask for a review-completion declaration.

This guide describes the current implementation. The [workflow contract](workflow.md#review-first-then-squash)
places user review before squash and uses commit history for requirement acceptance; it does not
require an agent-delivery protocol or a separate final-approval flow.

Select a task in the left work plan, then a file. This directly opens its undelivered diff;
there is no separate review-mode switch. The baseline is the last delivered source tip, or the
primary baseline already incorporated by the workspace. Live uncommitted edits remain visible;
formal delivery in this version requires a clean committed source.

Delivery history and successful workspace-hook output are collapsed on the task page. Expand
**交付** to inspect previous batches or **工作区脚本** to inspect hook output. Failed hooks remain visible. The file-list heading shows
the total number of changed files; layout controls use icons with accessible labels and tooltips.
The same [interface copy rules](design.md#interface-copy) apply to preview, history, synchronization
and settings. Operational consequences and recovery instructions stay beside their actions.

The task page is read-only for source files. Enter a message and choose **提交到主开发分支**
to deliver the complete reviewed increment with ordinary Git hooks. Preparation is internal to that
action, with recovery controls shown only when interrupted. No validation checkbox or readiness declaration is required. Failed hooks preserve
files; successful delivery preserves the workspace. See [Squash acceptance](worktrees.md#squash-acceptance).

The read-only target APIs below underpin diff rendering.
Task review pins the source commit, delivery boundary and primary HEAD. Background refresh does
not advance a committed comparison. If any version changes, refresh the task review and inspect the
complete new delivery. VS Code closes the task’s older diff tabs when a newer review version opens.
Recovery review pins the primary HEAD and index fingerprint, or the exact manual commit.
These checks bind content versions; they do not count viewed files or certify a completed review.

## Targets (what is being reviewed)

| Target | Key | Git equivalent |
|---|---|---|
| Working tree, uncommitted (incl. untracked) | `working` | `git diff` + `git diff --no-index /dev/null <file>` |
| Staged | `staged` | `git diff --cached` |
| Working tree, everything vs HEAD | `all` | `git diff HEAD` (+ untracked) |
| Branch, everything since it forked off a base (committed or not) | `base:<ref>` | `git diff $(git merge-base <ref> HEAD)` (+ untracked) |
| One commit | `commit:<sha>` | `git diff <sha>^ <sha>` |
| Two refs | `range:<base>..<head>` | `git diff <base>...<head>` |
| Worktree, working tree | `worktree:<path>:working` | same, run inside the worktree |
| Worktree, branch vs base | `worktree:<path>:range:<base>..<head>` | same, run inside the worktree |
| Worktree, everything since base | `worktree:<path>:base:<ref>` | same, run inside the worktree |

Refs accept anything git can resolve (`main`, `v1.2`, `HEAD~3`, a sha). `@` is `HEAD`.
Worktrees are discovered with `git worktree list`, and clone slots beside the main worktree (see
[Clone slots](worktrees.md#clone-slots)); both are made in *任务编排* and share the review
state of the main repository.
One whose directory is gone (git lists it as *prunable*) is not offered, and a remembered target
inside a removed worktree falls back to the working tree on the next load. Reusing a slot for another
branch clears its historical target metadata.

Navigation stays together in the left sidebar: *预览*, *提交历史*, ordered tasks and the
synchronization/settings sheets. Within a task, its file list selects the diff directly. Connection
selection is independent and belongs to the independent preview page.

Review presents the complete file list for the current comparison. Staging does not establish that
a file has been reviewed.
Local review opens `all`, including staged, unstaged and untracked content in the current working
files. Saved `working` or `staged` startup targets open `all` in the same workspace. Their read-only
APIs remain available for explicit comparisons against HEAD or the index.

`base:<ref>` is for a branch a coding agent has been working on, committing as it goes: one tree with
everything since the branch forked off `<ref>` — the commits plus whatever is still uncommitted or
untracked. The diff runs against the merge base, so commits that landed on `<ref>` after the fork are
not listed as reverted (which is what a plain `git diff <ref>` would do). The *相对于* field under
*审阅整条分支* suggests the base for you — the main worktree's branch when a sibling worktree is under
review, otherwise `main` or `master` — and takes any ref. Under it the form names the fork point (the
merge base with that ref, `GET /api/fork-point`) with how many commits the branch is ahead of it and how
many landed on the base since, and the list marks that commit with a *分叉自* chip and a rule above it:
what sits above is the branch's own work.

## Read-only review

Read markers and `PUT /api/targets/:key/viewed` have been removed; requests return 404.
Inline comments and their dedicated endpoints have been removed. Comment creation, editing, replies,
reanchoring and export requests return 404. Click a line number to copy its location, or Shift-click
to copy a range from the last copied line on the same side.

Review does not modify source files or the real index. File, hunk and line staging controls and the
legacy `POST /api/targets/:key/stage` endpoint have been removed; requests to that endpoint return
404. Staging and unstaging through external Git tools do not change the review scope or establish
that content has been read. Formal delivery still prepares and commits the selected delivery in
the primary checkout using the normal Git index and commit hooks.

## Complete delivery content

Warden recommends small deliveries that can be reviewed in full. An accepted commit advances the
primary baseline; the next delivery excludes the previous one. There is no “since I last looked”
checkpoint comparison. Checkpoint routes return 404 and checkpoint target keys are unsupported.
Old checkpoint selections migrate to the full working-tree comparison in the same workspace.
Internal snapshots still support preview composition and recovery; they are not review controls.

Mock code is edited in primary alongside other human code. Content already incorporated by a task
belongs to its baseline. Uncommitted primary edits block task delivery until the user handles them.
Comments such as `debug:start`, `debug:end` and `nocommit` have no special meaning to Warden:
all changed lines remain ordinary review and delivery content. Context expansion and manual code
folding remain available.

## Auto-refresh

warden polls the worktree every 1.5 s while the page is open (`git status --porcelain
--untracked-files=all`, HEAD, the branch name, plus mtime and size of the paths status reports — enough to notice a second edit to an
already-modified file) and pushes a change event over `GET /api/events` (SSE). The page then re-runs
the normal refresh for the selected comparison: reload its file list and open diff. A committed
task comparison stays pinned until its explicit refresh action. The current view and current file
are left alone, and the diff is scrolled back to where you were reading.
Turn it off with the *自动* toggle next to the refresh button; `r` still
refreshes by hand.

The same stream carries a `state` event when the state file's mtime moves, so changes made by
another Warden instance refresh the page.
