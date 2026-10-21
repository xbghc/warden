# Reviewing

What warden can put under review, and the ways to mark it done.

This guide describes the current implementation. The [workflow contract](workflow.md#review-first-then-squash)
places user review before squash and uses commit history for requirement acceptance; it does not
require an agent-delivery protocol or a separate final-approval flow.

Select a task in the left work plan, then a file. This directly opens its undelivered diff;
there is no separate review-mode switch. The baseline is the last delivered source tip, or the
primary baseline already incorporated by the workspace. Live uncommitted edits remain visible;
formal delivery in this version requires a clean committed source.

Delivery history and successful workspace-hook output are collapsed on the task page. Expand
**交付** to inspect previous batches or **工作区脚本** to inspect hook output. Failed hooks remain visible. The file-list heading shows
review progress once; layout controls use icons with accessible labels and tooltips.
The same [interface copy rules](design.md#interface-copy) apply to preview, history, synchronization
and settings. Operational consequences and recovery instructions stay beside their actions.

The task page is read-only for source files. Viewed marks support review. Preparation
isolates this delivery in the primary index; the page supports a message and ordinary Git commit
with hooks. No validation checkbox or readiness declaration is required. Failed hooks preserve
files; successful delivery preserves the workspace. See [Squash acceptance](worktrees.md#squash-acceptance).

The read-only target APIs below underpin diff rendering.
Checkpoint APIs remain available; the task page uses its delivery baseline for review.

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
| Working tree since a checkpoint (incl. untracked) | `checkpoint:<n>` | `git diff <checkpoint tree>`, see [Checkpoints](#checkpoints) |
| Worktree, since one of its checkpoints | `worktree:<path>:checkpoint:<n>` | same, run inside the worktree |

Refs accept anything git can resolve (`main`, `v1.2`, `HEAD~3`, a sha). `@` is `HEAD`.
Worktrees are discovered with `git worktree list`, and clone slots beside the main worktree (see
[Clone slots](worktrees.md#clone-slots)); both are made in *任务编排* and share the review
state of the main repository.
One whose directory is gone (git lists it as *prunable*) is not offered, and a remembered target
inside a removed worktree falls back to the working tree on the next load. Viewed flags kept under a
worktree's key stay in the state file until a branch is checked out into that slot again, which drops
them: they were about another branch.

Navigation stays together in the left sidebar: *主目录预览*, *提交历史*, ordered tasks and the
synchronization/settings sheets. Within a task, its file list selects the diff directly. Connection
selection is independent and belongs to the primary preview page.

Review presents one file list for the current comparison. Staging does not mark a file reviewed;
the [已读 mark](#viewed-files) records that separately and is invalidated when the diff changes.
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

Inline comments and their dedicated endpoints have been removed. Comment creation, editing, replies,
reanchoring and export requests return 404. Click a line number to copy its location, or Shift-click
to copy a range from the last copied line on the same side.

Review does not modify source files or the real index. File, hunk and line staging controls and the
legacy `POST /api/targets/:key/stage` endpoint have been removed; requests to that endpoint return
404. Staging and unstaging through external Git tools do not change the review scope or establish
that content has been read. Formal delivery still prepares and commits the selected delivery in
the primary checkout using the normal Git index and commit hooks.

## Debug code

Code written to poke at a problem and not meant to be committed can be marked in a comment. There is no
single convention for this, so warden takes the ones in use, in any comment syntax (`//`, `/*`, `#`,
`--`, `<!--`, `;`, `%`) and any case, as long as the marker opens the comment:

- a block between `debug:start` and `debug:end`, or `develblock:start` and `develblock:end` (the
  webpack-strip-block / gulp-strip-block spelling); markers included, blocks nest, and a block left
  open runs to the end of the file;
- a single line tagged `nocommit`, `no-commit` or `do not commit` (optionally `@nocommit` / `!nocommit`),
  the tag the usual pre-commit hooks look for.

With *忽略调试代码* enabled (the default), runs of debug lines fold into one striped row that opens
with a click. Folding changes presentation only: it
does not filter delivery content, modify the index or count a file as reviewed.

A hunk rarely shows the marker that opened the block its lines sit in, so warden reads both sides of a
file whole — only for the files `git grep` finds a marker in. Marker detection is textual: a marker
inside a string literal that follows a comment leader counts too.

## Viewed files

A file in any comparison can be marked *已读* — the
box beside it in the sidebar, or the one in the file header. A directory whose files are all read
recedes with a check. The mark is bound to a hash of the file's diff: when the diff changes (a `base`
target reads the working tree, so the agent's next edit does that) the mark is dropped and the file
is flagged *已变化*. Viewed marks belong to the exact comparison, including local views.

## Checkpoints

An agent works in rounds, and after the first one the question is no longer "what is uncommitted"
but "what did it do since I last looked". The working tree answers that only while the agent
neither stages nor commits, and a `base` target shows the whole branch every time. A checkpoint is
the working tree noted at the moment you choose, and `checkpoint:<n>` is one diff from it to the
working tree now — whatever was staged or committed in between does not show, only what changed.

- *新建检查点*, under the progress figure in 工作区, takes one: tracked and untracked files as they are
  on disk, ignored ones left out. *对比检查点 #n* beside it opens the newest. A checkpoint of a working
  tree that has not changed since the newest one is not taken twice; that one is handed back.
- In a checkpoint's view the picker reads *检查点 #n*, and the row under the figure switches to another
  checkpoint, takes a new one — the round is over, so the view moves on to it, empty — or deletes
  the one in front after asking.
- Files there carry the [已读 mark](#viewed-files), which the agent's next edit to a file drops.
  Deleting the checkpoint also deletes its marks.
- Checkpoints are numbered per worktree. Each worktree retains its newest 20; older checkpoints
  and their viewed marks are dropped. Reusing a slot for another branch clears its checkpoints.

Nothing of this is written to the repository. The snapshot is `git add --all` plus
`git write-tree` run against a copy of the index kept in warden's data directory, with
`GIT_OBJECT_DIRECTORY` pointing there too, so the tree and every blob git hashes for it land beside
the state file; files the index already has right are not hashed again, so taking one costs about
what changed. A diff runs `git diff <tree>` under another throwaway copy of the index with the
untracked files added as intent-to-add (which hashes nothing), reading the repository's objects
through `GIT_ALTERNATE_OBJECT_DIRECTORIES`. The alternates are only ever set for reads: git refreshes
the mtime of an object it finds in one while writing, and that would be a write to `.git`. Clean
filters configured for the repository run as they do for any `git add` (Git LFS keeps its cache in
`.git/lfs`).

## Auto-refresh

warden polls the worktree every 1.5 s while the page is open (`git status --porcelain
--untracked-files=all`, HEAD, the branch name, plus mtime and size of the paths status reports — enough to notice a second edit to an
already-modified file) and pushes a change event over `GET /api/events` (SSE). The page then re-runs
the normal refresh: reload the file list and the open diff. The current view and current file
are left alone, and the diff is scrolled back to where you were reading.
Turn it off with the *自动* toggle next to the refresh button; `r` still
refreshes by hand.

The same stream carries a `state` event when the state file's mtime moves, so changes made by
another Warden instance refresh the page.
