# Worktrees

One worktree per agent, in numbered slots that keep their dependencies.

## Slots

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
- A row also says where its agent stands with the review, in violet: *N 条未交付* for comments on
  that worktree's code the agent has not had yet, *N 条待确认* for those it has answered and you
  have not resolved — every pool counted, local views, `base`, commits and checkpoints alike. Each
  opens the pool its latest such comment sits in, with the rail filtered to that kind. The counts
  follow the state file, so an agent's `warden feedback` or `warden reply` moves them while you watch.
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

## Commit counts and tmux

Each checkout reports how many commits it is ahead of and behind a base, named beside the counts. A branch with an upstream, the main checkout's included, is counted against it (`origin/topic`): what is not pushed and what is not pulled yet, as `git status` counts them. Any other checkout, or one whose upstream is gone (`[origin/topic: gone]`, which the row notes), is counted against the branch currently checked out in the main repository; “已合并” there means its HEAD is reachable from the main checkout HEAD, which squash merges and cherry-picks do not imply. Either way the base is the ref `git branch -d` checks, so a branch with nothing ahead is one *一并删除分支* will take. Expand a row to browse its paginated commit history (including shared commits) or view that branch’s todos.

The optional tmux integration discovers sessions whose `session_path` resolves to the main repository directory. Click tmux to create a window immediately when exactly one session matches. With multiple matches, choose a session first. The new window starts in the worktree directory. It uses `tmux new-window -d -c` without sending a shell command; existing windows stay selected. No session is created automatically. Run warden alongside tmux in Linux, macOS, or WSL, using the same user/server environment. See the [tmux manual](https://man.openbsd.org/tmux.1).

`GET /api/tmux/sessions` lists matching sessions. `POST /api/tmux/windows` accepts a registered worktree `path` and a matching `sessionId`; the server revalidates both before creating a window. This optional action creates a terminal window but does not modify repository files.
