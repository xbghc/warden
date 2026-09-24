# Reviewing

What warden can put under review, and the ways to mark it done.

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
Worktrees are discovered with `git worktree list` (and made in the *Worktree* view, see below) and
share the review state of the main repository.
One whose directory is gone (git lists it as *prunable*) is not offered, and a remembered target
inside a removed worktree falls back to the working tree on the next load. The comments and viewed
flags kept under a worktree's key stay in the state file until a branch is checked out into that
slot again, which drops them: they were about another branch.

The sidebar is the navigation, and the only navigation: the picker at its top — *工作区*, *提交历史*,
*Worktree* — fills the left column with the controls for what the middle is showing, and the top bar
carries none of it. There is no separate target switcher: *工作区*'s two blocks *are* the working
tree, a commit is picked from the *提交历史* list, and the *审阅整条分支* and *对比两个 ref* forms below
its filters open the other two. While a commit, range or branch is under review the picker gains an
entry naming it — *提交 89d8ba2*, *main..feature*, *分支 vs main* — and reads that while its files are
in front, so the control at the top of the column says what the files below belong to; *工作区* is
then the way back.

`working`, `staged` and `all` are the three **local views** of one worktree. While any of them is
selected the sidebar shows two blocks — 未暂存 (`working`) and 已暂存 (`staged`) — instead of a
single tree, and clicking a file switches to the view it belongs to. A file that is only partly
staged appears in both. Above them sits the one figure in the app: how many of the files under review
are fully staged, which is what "staged means reviewed" amounts to. Switching between the three keeps
your comments, the draft you are typing and the current selection; only the diff is reloaded. `all`
has no control of its own (a saved `lastTarget` can still restore it; *审阅整条分支* against `@` shows
the same diff). Commit, range and `base` targets keep the single tree, and their figure counts 已读
instead, since nothing can be staged there.

So there is one mark of "done" per kind of target, never two. In the local views it is staging and
nothing else: a row has no 已读 box, and which block a file sits in is the whole of its review state.
Everywhere else it is the [已读 mark](#viewed-files).

`base:<ref>` is for a branch a coding agent has been working on, committing as it goes: one tree with
everything since the branch forked off `<ref>` — the commits plus whatever is still uncommitted or
untracked. The diff runs against the merge base, so commits that landed on `<ref>` after the fork are
not listed as reverted (which is what a plain `git diff <ref>` would do). The *相对于* field under
*审阅整条分支* suggests the base for you — the main worktree's branch when a sibling worktree is under
review, otherwise `main` or `master` — and takes any ref. Under it the form names the fork point (the
merge base with that ref, `GET /api/fork-point`) with how many commits the branch is ahead of it and how
many landed on the base since, and the list marks that commit with a *分叉自* chip and a rule above it:
what sits above is the branch's own work. Unlike the three local views, `base` keeps its own
pool of comments and a commit never deletes them: the round under review is not over when the agent
commits, so a comment whose lines changed stays *orphaned*, snippet and all, until you have checked
the fix and delete or re-attach it.

## Staging

The Staged block is the "reviewed" pile, and warden can move lines into it without a trip to the
terminal. In the Unstaged view every changed line has a small box at the left edge; press it and drag
to pick a range inside one hunk (in split view a replacement is one row, so its old and new line go
together). The picked rows are outlined in ink, a bar at the bottom of the diff says how many lines
are in, and `s` or the bar's button stages them. Each hunk header has *暂存此 hunk*, the file header
and the sidebar rows have *暂存文件* / *暂存*. The Staged view has the same controls the other way
round: *取消暂存* takes lines back out of the index.

A partial pick is turned into the patch `git add -p`'s edit mode would want — the unpicked deletions
stay as context and the unpicked additions are left out (the mirror image when unstaging) — and applied
with `git apply --cached`. It never touches the working tree, so what you did not pick is still
there to stage next. Comments on the lines you staged follow them into the Staged view (see
[Re-anchoring](agent.md#re-anchoring)). Every page open on the worktree reloads at once.

Limits, each reported as a plain error rather than a half-applied patch:

- Only the Unstaged and Staged views stage; `all`, `base`, commits and ranges are read-only.
- Binary files and mode-only changes go whole or not at all; a mode change rides along only with *暂存文件*.
- A staged deletion can be unstaged whole, not by line: the index has nothing left to put lines back into.
- A pick that would split a file's missing trailing newline from its neighbours is refused; include them.
- The request carries the hash of the diff the pick was made on. If the file or the index moved since
  (the agent kept editing), the server answers 409 and the page reloads instead of staging the wrong lines.
- If another git process holds the index lock the server retries briefly, then gives up with 409.

## Debug code

Code written to poke at a problem and not meant to be committed can be marked in a comment. There is no
single convention for this, so warden takes the ones in use, in any comment syntax (`//`, `/*`, `#`,
`--`, `<!--`, `;`, `%`) and any case, as long as the marker opens the comment:

- a block between `debug:start` and `debug:end`, or `develblock:start` and `develblock:end` (the
  webpack-strip-block / gulp-strip-block spelling); markers included, blocks nest, and a block left
  open runs to the end of the file;
- a single line tagged `nocommit`, `no-commit` or `do not commit` (optionally `@nocommit` / `!nocommit`),
  the tag the usual pre-commit hooks look for.

With *忽略调试代码* ticked in the sidebar (the default):

- runs of debug lines in a hunk fold into one striped row that opens with a click; jumping to a comment
  inside one opens it;
- *暂存文件* and *暂存此 hunk* leave debug lines out. Lines picked one by one go in regardless — that
  is how debug code is staged on purpose. A file whose changes are all debug code is refused with a
  note to pick the lines instead;
- a file whose unstaged changes are all debug code does not count as still to review.

Whether it is ticked or not, the 已暂存 heading carries a *调试代码 N* mark while N added lines in the
index are debug code, with the files in its tooltip.

A hunk rarely shows the marker that opened the block its lines sit in, so warden reads both sides of a
file whole — only for the files `git grep` finds a marker in. Marker detection is textual: a marker
inside a string literal that follows a comment leader counts too.

## Viewed files

Commit, range and `base` targets cannot be staged from, so a file there is ticked *已读* instead — the
box beside it in the sidebar, or the one in the file header. A directory whose files are all read
recedes with a check. The mark is bound to a hash of the file's diff: when the diff changes (a `base`
target reads the working tree, so the agent's next edit does that) the mark is dropped and the file
is flagged *已变化*. The local views keep no such mark — see [Targets](#targets-what-is-being-reviewed).

## Checkpoints

An agent works in rounds, and after the first one the question is no longer "what is uncommitted"
but "what did it do since I last looked". The working tree answers that only while the agent
neither stages nor commits, and a `base` target shows the whole branch every time. A checkpoint is
the working tree noted at the moment you choose, and `checkpoint:<n>` is one diff from it to the
working tree now — whatever was staged or committed in between does not show, only what changed.

- *新建检查点*, under the progress figure in 工作区, takes one: tracked and untracked files as they are
  on disk, ignored ones left out. *对比检查点 #n* beside it opens the newest. A checkpoint of a working
  tree that has not changed since the newest one is not taken twice; that one is handed back.
- Handing comments to the agent takes one by itself — *复制评论*, *复制此条*, a todo's *复制* when it carries comments, or
  the agent's own `warden feedback` — in each worktree the comments are about, marked *交付反馈* in
  the list. A round is the reviewer's, not the agent's: it ends when feedback goes out, however many
  turns the agent then takes, so *对比检查点* afterwards shows what it did about that feedback and
  nothing before. A copy in the page does not wait for the snapshot, which on a large tree can
  outlast the moment a browser allows for writing the clipboard; the list catches up when it lands.
- In a checkpoint's view the picker reads *检查点 #n*, and the row under the figure switches to another
  checkpoint, takes a new one — the round is over, so the view moves on to it, empty — or deletes
  the one in front after asking.
- Files there carry the [已读 mark](#viewed-files), which the agent's next edit to a file drops, and
  comments on a checkpoint are a pool of their own. Deleting the checkpoint deletes both.
- Checkpoints are numbered per worktree. A worktree keeps the newest 20; taking one more drops the
  oldest, with its comments. A slot checked out to another branch drops its own.

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
the normal refresh: re-anchor, reload both file lists, reload the open diff. Your draft comment,
selection, current view and current file are left alone, and the diff is scrolled back to where you
were reading. Turn it off with the *自动* toggle next to the refresh button; `r` still
refreshes by hand.

The same stream carries a `state` event when the state file's mtime moves, which is how an answer
written by `warden reply` — a process with no server to tell — reaches the page within a poll. The
page re-reads the comments then, and nothing else.
