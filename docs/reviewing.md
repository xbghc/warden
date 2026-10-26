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

Delivery history, task details and workspace-hook output open on demand from the sidebar task menu.
Choose **交付记录** to inspect previous batches or **初始化脚本** to inspect hook output. Failed hooks
keep visible feedback and recovery actions. Closing the inline details restores the commit form and its
draft. The native editor contains only the diff. File-list expansion is independent per task and survives
refresh or reselection; it does not replace the current file or reset its scroll. Icon actions expose
accessible names and hover/focus tooltips.
The same [interface copy rules](design.md#interface-copy) apply to preview, history, synchronization
and settings. Operational consequences and recovery instructions stay beside their actions.

The native task diff is read-only for source files. Enter a message and choose **提交到主开发分支**
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
synchronization/settings panels. Within a task, its file list selects the diff directly. Connection
selection is independent and remains available in each task row of the native tree.

Review presents the complete file list for the current comparison. Staging does not establish that
a file has been reviewed.
Local review opens `all`, including staged, unstaged and untracked content in the current working
files. Saved `working` or `staged` startup targets open `all` in the same workspace. Their read-only
APIs remain available for explicit comparisons against HEAD or the index.

The internal target model also supports branch and arbitrary-range reads for compatibility tests.
The product opens task comparisons and commits through native VS Code diff editors. It does not
provide the old browser branch-comparison form or a public HTTP target API.

## Read-only review

Diffs use immutable `warden-review:` documents and cannot modify source files or the real index.
Select a line or range and run **Warden: 复制审阅位置** (`Ctrl+Alt+C`, macOS `Cmd+Alt+C`) to copy
`path:start-end`. Native diff navigation, folding and search remain available.

The file tree and native diff title display Git file-mode changes, including executable-bit and
file-type changes. A mode-only change remains visible even when both read-only text snapshots are
identical; the snapshots themselves contain only the original file content.

Symbolic links display their destination text on both sides of the comparison, matching Git's
stored content. Live review does not read the linked file or directory; dangling links and links
outside the repository remain reviewable as link destinations.

There are no read markers, inline comments or staging controls. Staging and unstaging through
external Git tools do not change the review scope or establish that content has been read. Formal
delivery still prepares the selected delivery in primary and commits with normal Git hooks.
The retired viewed/comment/stage endpoints return 404 in the test-only compatibility adapter.

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

The extension observes repository and state changes, with periodic reconciliation when events are
missed. Live inventory and connection status refresh independently of committed review snapshots.
A committed task comparison stays pinned until the user opens its current differences again; a
changed source, delivery boundary or primary HEAD invalidates delivery from the old review.

Each native document has a persisted immutable snapshot, so reopening an editor after an extension
reload cannot silently display a newer file under the old review identity. A missing snapshot asks
the user to reopen the comparison. No local server, SSE stream or browser polling is involved.
