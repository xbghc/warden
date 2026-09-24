# warden

Local web UI for reviewing git diffs — built for reviewing changes that a coding agent just made,
with line comments you can copy back to the agent as a prompt.

- Runs as a single local process per repository (`127.0.0.1` only, no auth, no database).
- Diff sources: working tree, staged, working tree vs HEAD, a branch since it forked off its base (commits and
  uncommitted work together), any commit, any two refs, git worktrees, and checkpoints.
- Checkpoints: note the working tree as it is — untracked files included — and later see only what
  changed since, staged, committed or neither. Taking one writes nothing to the repository (see
  [Checkpoints](#checkpoints)).
- Worktrees are made and taken down from the page, one per agent branch, with the path ready to paste.
  Their directories are numbered slots beside the repository that get reused rather than remade:
  releasing one keeps the directory, installed dependencies included, for the next branch.
- Side-by-side **Unstaged** and **Staged** file lists: staged means reviewed. Stage from the UI by dragging
  over the lines you have read (or a hunk, or a file), and unstage the same way from the Staged view.
- Debug code marked in a comment is folded out of the review and left out of whole-file staging, and
  the Staged block warns while any of it is in the index (see [Debug code](#debug-code)).
- Code blocks fold by indentation, as an editor does for a language it has no grammar for: the
  chevron beside a line that heads one shuts its body, and the head then says how many lines and
  changes it hides. A dragged pick across a shut block takes none of them; stage the hunk to take them.
- GitHub-style unified / side-by-side diff with syntax highlighting, collapsed file tree, lazy per-file loading, context expansion, virtual scrolling.
- Line comments (single line or a dragged range), Markdown, edit / delete.
- One click copies all comments as an agent-readable prompt to the clipboard — or the agent fetches them
  itself with `warden feedback` and answers each one with `warden reply`, the answer showing under the
  comment in the page (see [Handing comments to the agent](#handing-comments-to-the-agent)).
- Review state (viewed files, comments, local issues, todos, preferences) persists outside the repo and survives restarts.
- Comments follow the code: they move with a hunk that gets staged, re-attach after the agent edits the file, and are cleaned up once the change is committed.
- Auto-refresh — warden watches the repository and reloads itself when you edit, stage, commit or switch branches.
- Local issues (title, Markdown body, open/closed) that link comments, and branch-scoped todos, each
  copied to the clipboard on its own — one task at a time for the agent. Both are task lists in the
  manner of Google Tasks: add at the top, Enter for the next one, tick to file it under 已完成, drag
  into your own order, edit in place, 撤消 after a delete.
- Commit history browser: grouped by day, branch / tag labels, search by message, sha, author or
  path (each a `git log` on the server, not a filter over the rows already loaded), and a
  first-parent view that folds merged branches into their merge commits.
- Click a line number to jump to that line in a running nvim instance (WSL2 friendly).
- Git is touched through whitelisted read sub-commands plus a few writes the server composes itself:
  `git apply --cached`, which is what the stage / unstage controls run, and the worktree slot
  operations (`worktree add` / `remove`, `branch`, `switch`). Reviewing and staging never write the
  working tree or HEAD; only checking a branch out into a free slot, or releasing one, does.
  Checkpoints write into warden's own index copy and object store, never the repository.

## Install / run

Node.js 20+ is required.

```sh
npx @xbghc/warden            # review the repo in the current directory
npx @xbghc/warden ~/proj     # or give a path
```

or install globally:

```sh
npm i -g @xbghc/warden
warden [repoPath] [--port <n>] [--no-open] [--no-update-check]
warden feedback [--peek]          # for the agent, see Handing comments to the agent
warden reply <id> <message>
```

The server picks the first free port from 4100 (or `--port`), prints the URL and tries to open a
browser via `wslview`, `explorer.exe`, then `xdg-open`. If none of those exist it only prints the URL.
Several instances on the same repository can run at the same time.

On start warden asks the npm registry whether a newer release exists, at most once a day (the answer
is cached in `~/.local/share/warden/update-check.json`). When there is one, a line in the terminal
and a chip beside the wordmark say so; clicking the chip copies the command — `npx @xbghc/warden@latest`
for an npx run, whose cache otherwise keeps serving the old copy, `npm i -g @xbghc/warden@latest`
for a global install. The check never delays startup and fails silently. `--no-update-check`,
`WARDEN_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1` or `CI` turn it off.

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

## Worktrees

Agents do their best work each in a worktree of its own, and the sidebar's *Worktree* view is
where those are made and taken down without a trip to the terminal. The directories are numbered
**slots** beside the main worktree — `<repo>-1`, `<repo>-2`, … (工位 in the UI) — rather than one
directory per branch: a directory is where the dependencies get installed, and a fresh one for every
branch meant installing them for every branch. A slot outlives its branch. Releasing it leaves the
directory behind, `node_modules` and all, and the next branch is checked out into it.

- *检出分支*, the form in the sidebar, takes a branch, a base and a slot. An existing branch is
  checked out as it is, unless another worktree already has it. A branch only a remote has is
  checked out tracking the remote one (what `git worktree add` itself guesses) rather than started
  afresh; when several remotes have it, the base says which. The branch list offers local branches
  only, since a remote can carry thousands: the name typed is looked up on its own
  (`GET /api/worktrees/remotes`), so the form says it is a remote branch before you submit. Any
  other name becomes a branch from the base (`main` or `master` unless you say otherwise; any ref
  goes). The server looks the name up when the request arrives, so a branch fetched or made after the page
  loaded its list is still found, and a base typed for a name that already exists is refused.
- The slot picker lists the free slots, lowest first, then *新目录*: the next number, which is made
  with `git worktree add [--track] [-b <branch>] <repo>-<n> [<base>]`. Into a free slot the checkout
  is `git branch [--track] <branch> <base>` in the main worktree — so a base such as `HEAD` means what
  it would to `worktree add` — followed by `git switch <branch>` in the slot, which rewrites the
  tracked files and leaves the ignored ones alone; the toast says which of the two happened. Nothing
  in the request names a directory: the server composes the path from the number, so a checkout
  cannot land anywhere but beside the main worktree. Whatever review state was kept under the slot's
  key (comments, viewed flags, its `base` pool included) is dropped: it was about another branch.
- Each row names the branch, its directory, and whether it is clean or how many paths `git status`
  reports. *查看* switches the review to it (the kind of target carries over), *复制路径* is for the
  agent's prompt. A free slot is a row of its own, marked *空闲*, and its *检出到这里* points the form
  at it.
- *释放* is what a slot's row offers, and it always asks first, in the row: `git switch --detach` in
  the slot leaves the last commit checked out with no branch on it and touches no file, and the slot
  is free for the next checkout. A slot with uncommitted changes is not released until you confirm
  again, since those changes go: only that second request discards them — `git reset --hard`, then
  `git clean -fd` for the untracked files, never `-x`, so the ignored ones, the installed
  dependencies above all, stay. *一并删除分支* is offered in the same confirmation,
  ticked by default, and takes the branch by `git branch -d`: one that is not merged is kept and the
  toast says why. *连目录一起删除* turns the release into a removal.
- *删除* is for a worktree that is not a slot (one made by hand, wherever it is) and for a free slot
  whose directory you no longer want; a slot on a branch gets it through *连目录一起删除*. It runs
  `git worktree remove` without `--force`: uncommitted changes are put to you first, as with a
  release, and so is whatever else git refuses without `--force`.
- A worktree whose directory was deleted behind git's back is listed struck through; *清理* drops that
  one entry (`git worktree remove` handles it; nothing is pruned wholesale). A slot in that state
  cannot be released or checked out into, and its number is skipped until the entry is gone.

`git switch` needs git 2.23 or newer.

## Keyboard

| Key | Action |
|---|---|
| `r` | Refresh the current target (file list + open diff, then re-anchor comments) |
| `j` / `k` | Next / previous file, walking Unstaged then Staged and switching view at the boundary |
| `n` / `p` | Next / previous hunk |
| `s` | Stage (Unstaged view) or unstage (Staged view) the picked lines |
| `Ctrl+Enter` | Save the comment being edited |
| `Esc` | Drop the picked lines / cancel editing / cancel re-attach mode / shut the rail / back to the files under review |

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
[Re-anchoring](#re-anchoring)). Every page open on the worktree reloads at once.

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

## Comments and export

Press the `+` that appears next to a line (drag to cover several lines) and write Markdown. What you
write lands in the right-hand rail, which is shut until it has something to hold: it costs 360px of
the code column, which is most of it once the diff is side by side on a laptop. Writing a comment,
focusing one or re-attaching one opens it; so does the *评论* switch at the right of the top bar,
which carries the count and turns violet while any comment is still waiting to go back to the agent,
or has an answer from it you have not dealt with.
`Esc` shuts it again.

Each comment belongs to the `old` or `new` side of the diff and has a status:

- `active` (待导出) — not yet exported
- `exported` (已导出) — copied, or fetched by the agent, at least once (excluded from "copy all" unless
  *含已导出* is checked)
- `orphaned` (已失联) — the code it referred to no longer exists in the current diff

"复制评论" copies every comment of the current target the agent has not had yet (a reviewer reply puts
one back among them); each comment also has a "复制此条" button.
The clipboard format is fixed so an agent can read it directly:

````markdown
# Review comments
Target: working
Repo: /home/user/project
Count: 2

## src/features/order/OrderList.tsx:120-124 (new) [id: 3f2a9c1d]
```tsx
120 | const total = items.reduce((s, i) => s + i.price, 0);
121 | // ...
```
> 这里没有考虑 discount 字段，参考 utils/price.ts 里的 calcTotal。

## src/features/order/hooks/useOrder.ts:42 (new) [id: 8b04e7aa]
```ts
42 | useEffect(() => { fetchOrder(id) }, []);
```
> 依赖数组缺少 id。
Agent replied:
> 已加上，顺带把 fetchOrder 包进了 useCallback。
Reviewer replied:
> useCallback 没必要，去掉。

When you have dealt with a comment, answer it with `warden reply <id> "<what you changed, or why you did not>"` so the reviewer sees your answer beside it.
````

A comment with a thread carries it whole, so a follow-up arrives with what it follows up on. The last
line tells whatever agent the text is pasted into how to answer; it names `npx @xbghc/warden` instead
when warden itself was started through npx. Issues can be copied in the same format (with the issue
title, status and body on top).

## Handing comments to the agent

The clipboard works with any agent, but it leaves the reviewer carrying text back and forth, and the
agent's answer — "done", "not done, because" — nowhere to go but the chat. Two commands let the agent
take the review and answer it in place. Both run in the worktree the agent works in, read and write
the [state file](#state) directly, and work whether or not a warden page is open:

```sh
warden feedback            # the comments on this worktree it has not had yet, marked as handed over
warden feedback --peek     # the same, marked as nothing
warden reply 8b04e7aa "已加上"   # answer one; the id is the one in its heading
echo "long answer" | warden reply 8b04e7aa
```

`feedback` takes every pool on the worktree it runs in — the local views, `base`, commits, ranges and
checkpoints alike — and prints them in the export format above, reply line included. A worktree
reaches only its own comments: the agent in `<repo>-2` never sees what was said about `<repo>-1`.
(One limit: a key with no worktree in it names the directory warden was started in, which this
takes to be the main worktree. Start warden there, not inside a linked worktree.)

In the page the answer appears under the comment, which is flagged *待确认* and counted under the
rail's *待确认* filter until you act on it:

- *解决* accepts the answer and deletes the comment — nothing is left for it to ask.
- *回复* is a follow-up. It puts the comment back among those the agent has not had, so the next
  `warden feedback` (or *复制评论*) sends it again with the thread so far.

A comment with a thread is never deleted by a commit (see [Re-anchoring](#re-anchoring)): the
agent's answer usually lands with the very commit that removes the lines it was about, and it would
otherwise go unread. It stays, orphaned, until you resolve it.

To have the agent do this unprompted, tell it so once, in `CLAUDE.md`, `AGENTS.md` or whatever its
instructions file is:

```markdown
When you finish a task, run `warden feedback` (or `npx @xbghc/warden feedback`) and address every
comment it prints. After dealing with each one, run `warden reply <id> "<what you changed, or why
you did not>"`.
```

## Re-anchoring

Every comment stores a hash of its hunk, of each covered line and of three context lines above and
below. On refresh the comment is re-attached in this order: same hunk still present → same relative
position; otherwise search the file for the same line sequence (context lines disambiguate duplicates).

The three local views of a worktree share one pool of comments, and re-anchoring searches all of
them — the comment's current view first, then `working`, `staged`, `all`. So:

- Comment on an unstaged hunk, then `git add` it → the comment turns up in the Staged view,
  unchanged. The card shows which view it moved to; clicking it jumps there.
- The agent edits the commented line → nothing matches, and the comment becomes *orphaned*: listed
  at the top of the rail with its original snippet, ready to be deleted or re-attached to a new selection.
- `git commit` → re-anchoring notices HEAD moved. Comments that no longer have a home anywhere are
  **deleted** (and unlinked from any issue), because the code they were about is now history.
  Anything still visible in Unstaged or Staged survives, including as a context line, and so does a
  comment with replies under it, orphaned, until you resolve it.

Commit, range, `base` and checkpoint targets each keep their own pool and only ever search
themselves, and none of them deletes on a moved HEAD.

Comment markers in the diff belong to one view; the rail's *全部* tab lists the whole pool and
*此文件* lists every comment on the open file regardless of which view it currently sits in.

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

## Viewed files

Commit, range and `base` targets cannot be staged from, so a file there is ticked *已读* instead — the
box beside it in the sidebar, or the one in the file header. A directory whose files are all read
recedes with a check. The mark is bound to a hash of the file's diff: when the diff changes (a `base`
target reads the working tree, so the agent's next edit does that) the mark is dropped and the file
is flagged *已变化*. The local views keep no such mark — see [Targets](#targets-what-is-being-reviewed).

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

## Todos

Notes attached to a branch rather than to a line of code, for the things you notice while reviewing
that do not belong in a comment. They are not deleted when you commit. They sit in the right-hand
rail next to the comments, under the *待办* tab, as a task list that works the way Google Tasks does:

- *添加待办* opens an empty row at the top; type the title and press Enter, and the next row opens
  right under it. Esc or Backspace on an empty row drops it.
- Titles and details are edited where they are: click into the text. Enter at the end of a title
  starts the next todo under it; Backspace on an emptied title deletes the todo. The details field
  (Markdown) appears while the row is open, and is rendered under the title otherwise.
- The circle strikes the todo through and files it under *已完成 (N)* at the bottom, collapsed;
  open it to tick one back or *全部删除*.
- Rows are dragged into your own order by the handle at their left edge. That order is what the state
  file keeps, and new todos go on top.
- Delete asks nothing; the toast offers *撤消* for a few seconds.
- The picker at the top is the list selector: the current branch, any other branch that has todos,
  or all of them with the branch on each row. A new todo goes to the branch being shown.

Issues (the rail's third tab) are the same list: closing an issue is ticking it, a
*已关闭* section holds the closed ones, and the comments linked to an issue sit under its open row
like subtasks, each with *跳转* and *解除关联*. Tick comments in the rail and the *创建 Issue* button
switches to that tab with the add row ready and the comments attached on creation; for an existing
issue, open its row and use *关联选中的评论*.

Each row has its own *复制* button, and there is deliberately no "copy all": a todo is one task to
hand to an agent, and the agent it goes to is already working in that branch. So the clipboard gets
the title and the body — no branch, repo, count or numbering:

```markdown
补充 OrderList 的空状态

描述正文（Markdown）…
```

## nvim integration

Requirements:

- `nvim` on `PATH` of the machine running warden (WSL2 in the typical setup).
- nvim started normally so it creates its default server socket (`$XDG_RUNTIME_DIR/nvim.<pid>.0`
  or `/tmp/nvim.<user>/…/nvim.<pid>.0`), or with `--listen` into one of those directories.
- nvim's working directory is the repository (or worktree) root or somewhere below it.

warden scans those socket directories, asks each instance for `getcwd()` (500 ms timeout) and keeps the
instances whose cwd is inside the current target's root. One match is used automatically; with several
matches a selector appears in the top bar and the choice is remembered per repository root. Results
are cached for 10 s; use ⟳ to rescan.

Clicking a line number runs, roughly, `:edit +<line> <absolute path>` in that instance. Deleted lines
jump to the nearest new-side line; for commit targets the working-tree file is opened.

## State

`~/.local/share/warden/<sha1(repoRoot)[:12]>/state.json` (respects `XDG_DATA_HOME`). Plain JSON with a
`schemaVersion`, written atomically (temp file + rename) under a small lock file so multiple instances
can share it. Delete the directory to reset. Checkpoint objects live beside it in `checkpoints/objects`;
deleting a checkpoint leaves them there, since another may share them.

`targets` is keyed by target key, plus one *comment scope* per worktree — `local`, or
`worktree:<path>:local` — holding the comments the three local views share and the HEAD sha the last
re-anchor saw. `viewed` sits on the key of the commit, range, `base` or checkpoint target it was
ticked in; the local view keys hold nothing. Issues, todos and `checkpoints` (the tree sha, HEAD and
time of each, per worktree) are top level. State written by an older version is
migrated on load: comments filed under `working` / `staged` / `all` move into the matching scope the
first time the file is read, and the 已读 marks those views used to keep are dropped.

## WSL2 notes

- Access the UI from the Windows browser at the printed `http://127.0.0.1:<port>/` URL; WSL2 forwards
  localhost automatically.
- Install [wslu](https://github.com/wslutilities/wslu) for `wslview` if `explorer.exe` doesn't open the
  URL for you, or run with `--no-open`.
- Keep the repository on the Linux filesystem for reasonable git performance.
- Clipboard access uses `navigator.clipboard`, which works on `localhost`; if you expose the port via
  another hostname the copy button falls back to `document.execCommand('copy')`.

## Security model

Single user, local only. The server binds to `127.0.0.1` and executes git only through
`execFile('git', [...])`. Reads go through an argument whitelist (`rev-parse`, `diff`, `show`, `log`,
`worktree list`, `ls-files`, `status`, `merge-base`, `rev-list`, `grep` without `-O` /
`--open-files-in-pager`) that refuses option-looking refs and any write-capable
flag; requests that would need anything else get HTTP 400. The writes are few and each composes its
own arguments. `POST /api/targets/:key/stage` runs `git apply --cached` (with `--reverse` for the
Staged view) on a patch the server itself builds from the diff it just produced — the patch is never
taken from the request, only the line indices are, and they are checked against the diff's hash
first. `POST /api/worktrees`, `POST /api/worktrees/release` and `POST /api/worktrees/remove` run
`git worktree add`, `git branch`, `git switch`, `git worktree remove` and `git branch -d` with a
branch name git has validated, a ref that resolves, and a slot path the server composes from a
number — `<repo>-<n>` beside the main worktree; no request names a directory. The working tree and
HEAD of an existing checkout are written only inside such a slot: `git switch <branch>` into a free
one (detached, clean) when a branch is checked out there, `git switch --detach` when it is released,
and `git reset --hard` plus `git clean -fd` only on the forced release the reviewer confirmed after
a 409. Refs change only when a branch is made for a checkout (plus its upstream setting when it comes
from a remote) — undone with `branch -D` should the switch into the slot then fail — or deleted on
request after a release or removal (`-d`, so only a merged one), and the review state lives outside
the repository. A checkpoint writes only there: `git add --all [--intent-to-add]` and
`git write-tree --missing-ok`, with `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` set to files in
warden's data directory and no alternates (see [Checkpoints](#checkpoints)).

Binding to `127.0.0.1` keeps other machines out but not other web pages, which reach the server
through the browser. Every request whose `Host` is not `127.0.0.1` or `localhost` is refused with
403, reads included: that is what a DNS-rebinding page — its own domain re-pointed at `127.0.0.1`,
and so same-origin with warden — cannot hide. Open warden under one of those two names; a tunnel or
proxy that rewrites the host name will be refused. A mutating request the browser labels as coming
from another origin (`Sec-Fetch-Site: cross-site`, or an `Origin` that is not the server's own) is
refused with 403 as well, so a page from elsewhere cannot drive the server through the browser it
is open in.

The only request warden makes off the machine is the update check: a `GET` of
`https://registry.npmjs.org/@xbghc%2fwarden/latest`, no more than once a day, carrying nothing about
the repository or the review. `--no-update-check` (or the environment switches under *Install / run*)
removes it.

## Development

```sh
pnpm install
pnpm dev          # API server on :4100 (tsx watch) + Vite dev server on :5173 with /api proxied
pnpm test         # vitest: diff parser, staging patches, anchoring, comment scopes, watcher, todos, worktrees, export, state, HTTP API
pnpm typecheck
pnpm build        # dist/web (Vite) + dist/cli.js (tsup, zero runtime dependencies)
node dist/cli.js path/to/repo
```

Layout:

```
bin/cli.ts           argument parsing, start server, open browser
packages/shared      types + target key / comment scope helpers (bundled into both sides)
packages/server      Hono API, git wrapper, diff parser, staging patches, targets, worktrees, anchoring, watcher, state, export, nvim
packages/web         React + Vite UI (shiki highlighting, @tanstack/react-virtual, react-markdown)
test/                API integration tests on a generated git repository
```

Only `dist/`, `README.md`, `LICENSE` and `package.json` are published.

Releasing: bump `version` in `package.json`, commit, then push a matching tag —
`git tag v0.2.0 && git push origin v0.2.0`. The `Publish to npm` workflow checks the tag against the
version, runs build + tests through `prepublishOnly`, and publishes over OIDC trusted publishing — no
`NPM_TOKEN` secret to store or rotate. It relies on a trusted publisher configured on the package's
npmjs.com settings page (user `xbghc`, repo `warden`, workflow `publish.yml`), and passes
`--provenance` explicitly, because npm's automatic attestation does not fire through `pnpm publish`
(0.2.0 shipped without one). CI runs typecheck, tests, build and a `publish --dry-run` on every push
to `main` and every pull request.

## License

MIT

## Storybook

[Browse the hosted Storybook](https://xbghc.github.io/warden/). Every push to `main` builds and deploys it through `.github/workflows/storybook-pages.yml`; the workflow can also be run manually. Repository Settings → Pages must use **GitHub Actions** as the publishing source.

Run `pnpm storybook` for isolated review and layout components at http://127.0.0.1:6006. Stories use in-memory fixtures and include interaction checks. Run `pnpm build:storybook` to build the static preview.

### Worktree details and tmux

Each checkout reports how many commits it is ahead of and behind a base, named beside the counts. A branch with an upstream, the main checkout's included, is counted against it (`origin/topic`): what is not pushed and what is not pulled yet, as `git status` counts them. Any other checkout, or one whose upstream is gone (`[origin/topic: gone]`, which the row notes), is counted against the branch currently checked out in the main repository; “已合并” there means its HEAD is reachable from the main checkout HEAD, which squash merges and cherry-picks do not imply. Either way the base is the ref `git branch -d` checks, so a branch with nothing ahead is one *一并删除分支* will take. Expand a row to browse its paginated commit history (including shared commits) or view that branch’s todos.

The optional tmux integration discovers sessions whose `session_path` resolves to the main repository directory. Click tmux to create a window immediately when exactly one session matches. With multiple matches, choose a session first. The new window starts in the worktree directory. It uses `tmux new-window -d -c` without sending a shell command; existing windows stay selected. No session is created automatically. Run warden alongside tmux in Linux, macOS, or WSL, using the same user/server environment. See the [tmux manual](https://man.openbsd.org/tmux.1).

`GET /api/tmux/sessions` lists matching sessions. `POST /api/tmux/windows` accepts a registered worktree `path` and a matching `sessionId`; the server revalidates both before creating a window. This optional action creates a terminal window but does not modify repository files.

The sidebar uses a view selector for Changes, Commits, and Worktrees. The `Layout/Sidebar` stories demonstrate the selector together with each view’s real sidebar controls and content.
