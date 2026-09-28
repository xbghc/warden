# Worktrees

One checkout per agent — a clone of its own or a linked worktree — in numbered slots that keep their
dependencies.

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
- The slot picker lists the free slots, lowest first, then the next number twice: *新 clone* and
  *新 worktree* (see [Clone slots](#clone-slots)), the kind made last time in this repository first.
  A new worktree is made with `git worktree add [--track] [-b <branch>] <repo>-<n> [<base>]`. Into a
  free worktree slot the checkout is `git branch [--track] <branch> <base>` in the main worktree — so a base such as `HEAD` means what
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
  whose directory you no longer want; a slot on a branch gets it through *连目录一起删除*. For a
  worktree it runs `git worktree remove` without `--force`: uncommitted changes are put to you first, as with a
  release, and so is whatever else git refuses without `--force`.
- A slot is written — released, reset, cleaned, checked out into — only while its directory is still
  this repository's own checkout. git keeps listing an entry as long as `<dir>/.git` exists, so a
  repository cloned or initialised where a deleted slot was passes for the slot; warden marks it
  *不属于本仓库* and refuses every write to it, forced or not. A slot with a rebase, merge,
  cherry-pick, revert or bisect stopped in it is marked *… 进行中*: it is not free, cannot be
  released, and removing it asks first, since each would throw the half-done operation away.
- A worktree whose directory was deleted behind git's back is listed struck through; *清理* drops that
  one entry (`git worktree remove` handles it; nothing is pruned wholesale). A slot in that state
  cannot be released or checked out into, and its number is skipped until the entry is gone.

`git switch` needs git 2.23 or newer.

## Clone slots

Some repositories do not get along with linked worktrees: hooks installed per `.git` directory,
scripts and editor plugins that read `.git` as a directory, tooling that has to be set up again in
each one. For those a slot can be a **clone** instead — a repository of its own at the same
`<repo>-<n>` path, with its own `.git`, hooks and refs — and the form makes one unless told
otherwise: the kind picked for a new slot is remembered per repository, and a clone is the default.
A free slot is reused as whatever it was made as. Clone rows are marked *clone*.

A clone talks to the server by itself. No branch is exchanged with the main worktree or another
slot: each fetches and pushes on its own, as a clone made by hand would.

- **Making one** is `git clone --local --no-checkout` from the main worktree — hard links to its
  objects, so even a large repository is there in moments — with `warden.main` in its config naming
  the main worktree. The main worktree's remotes then replace the `origin` that points back at it,
  URLs and push URLs as they are, and their remote-tracking branches are copied from the main
  worktree, so the clone knows the server as the main worktree last saw it without downloading
  anything. The main worktree's local branches are not copied, and the one `git clone` made for its
  HEAD is deleted once the clone is on its own branch. A repository with no remote keeps the `origin`
  that is the main worktree: there is no other server. Hooks are not copied — one written for the
  main worktree may name its paths — so set them up the way your project does, once per slot, like
  the dependencies.
- **Checking out** reads the name in the clone: a branch it has is checked out as it is, one only a
  remote-tracking branch has is checked out tracking it, and any other name starts from the base — by
  default the remote's default branch (`origin/main`, as `origin/HEAD` names it), not a local `main`
  that moves only when someone checks it out there. The branch list and the remote lookup in the form
  follow the slot picked. *先 fetch 远端*, ticked by default for a clone, runs `git fetch --all` in it
  first, so a slot kept for weeks does not start a branch from where the server was weeks ago; a
  fetch that fails stops the checkout and says why.
- That fetch is the one time warden reaches a server, with your own git and its credentials. It runs
  without a terminal, so ssh that wants a passphrase fails at once instead of waiting on a prompt no
  one sees — keep the key in an agent — and it gets ten minutes.
- A name is on in one checkout at a time, clones and worktrees alike: two clones on one branch would
  push to the same branch of the server.
- **Releasing** is `git switch --detach`, as for any slot, and the branch stays in the clone.
  *一并删除分支* takes it only when its upstream is there and has all of it (`git branch -d`, which
  then checks the upstream). With no upstream, or one that is gone, git would check the detached HEAD
  instead — after a release, the branch itself — and pass every branch, so warden keeps it and the
  toast says why.
- **Deleting** the directory — *删除目录* on a free clone, *连目录一起删除* on one with a branch — takes
  its branches with it, since nothing else has them. It is asked about first, naming everything only
  the clone holds: uncommitted changes, commits on no remote-tracking branch, a stash, an operation
  stopped halfway. Only a directory that is still a clone of this repository is deleted, forced or not.
- A clone warden did not make is taken for a slot when it sits at a slot's path and shares a remote
  URL with the main worktree: a clone of the same server, made by hand. Any other repository at a
  slot's path is left out of the list and never written in; its number is skipped.
- `warden`, `warden feedback` and `warden reply` run inside a clone slot find the main worktree
  beside it and share its review state, as they do in a linked worktree.

## Commit counts and tmux

Each checkout reports how many commits it is ahead of and behind a base, named beside the counts. A branch with an upstream, the main checkout's included, is counted against it (`origin/topic`): what is not pushed and what is not pulled yet, as `git status` counts them. Any other checkout, or one whose upstream is gone (`[origin/topic: gone]`, which the row notes), is counted against the branch currently checked out in the main repository; “已合并” there means its HEAD is reachable from the main checkout HEAD, which squash merges and cherry-picks do not imply. Either way the base is the ref `git branch -d` checks, so a branch with nothing ahead is one *一并删除分支* will take. A clone is counted in the clone, which shares nothing with the main repository: against its branch's upstream, and otherwise against its remote's default branch (`origin/main`), where “已合并” means reachable from it. Expand a row to browse its paginated commit history (including shared commits) or view that branch’s todos.

The *tmux session* button on a row gives that worktree a tmux session of its own: detached, started
in the worktree's directory, with a shell and nothing run in it, named after the directory —
`<repo>-<n>` for a slot, which keeps its session when the next branch is checked out into it (tmux
does not allow `.` or `:` in a name, and reads `#` as the start of a format — `#()` would run a
command — so all three become `_`). Getting into it is yours:
`tmux attach -t <repo>-<n>`, or `switch-client` from inside tmux. Pressing it again for a worktree
that already has its session hands that one back rather than making a second; a session of the same
name in another directory is left alone and reported. No tmux server running yet is fine: the
session starts one. It runs `tmux new-session -d -s <name> -c <dir>` without a shell, and touches no
repository file. Run warden in the same user and tmux environment as your terminals (Linux, macOS or
WSL); see the [tmux manual](https://man.openbsd.org/tmux.1).

`POST /api/tmux/sessions` takes a registered worktree `path`; the server checks it against
`git worktree list` before running anything.
