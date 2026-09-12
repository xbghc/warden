# warden

Local web UI for reviewing git diffs — built for reviewing changes that a coding agent just made,
with line comments you can copy back to the agent as a prompt.

- Runs as a single local process per repository (`127.0.0.1` only, no auth, no database).
- Diff sources: working tree, staged, working tree vs HEAD, a branch since it forked off its base (commits and
  uncommitted work together), any commit, any two refs, and git worktrees.
- Worktrees are made and taken down from the page, one per agent branch, with the path ready to paste.
- Side-by-side **Unstaged** and **Staged** file lists: staged means reviewed. Stage from the UI by dragging
  over the lines you have read (or a hunk, or a file), and unstage the same way from the Staged view.
- GitHub-style unified / side-by-side diff with syntax highlighting, collapsed file tree, lazy per-file loading, context expansion, virtual scrolling.
- Line comments (single line or a dragged range), Markdown, edit / delete.
- One click copies all comments as an agent-readable prompt to the clipboard.
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
- Git is touched through whitelisted read sub-commands plus exactly one write, `git apply --cached`, which is
  what the stage / unstage controls run. The working tree and HEAD are never written.

## Install / run

Node.js 20+ is required.

```sh
npx @xbghc/warden            # review the repo in the current directory
npx @xbghc/warden ~/proj     # or give a path
```

or install globally:

```sh
npm i -g @xbghc/warden
warden [repoPath] [--port <n>] [--no-open]
```

The server picks the first free port from 4100 (or `--port`), prints the URL and tries to open a
browser via `wslview`, `explorer.exe`, then `xdg-open`. If none of those exist it only prints the URL.
Several instances on the same repository can run at the same time.

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
Worktrees are discovered with `git worktree list` (and made in the *Worktrees* tab, see below) and
share the review state of the main repository.
One whose directory is gone (git lists it as *prunable*) is not offered, and a remembered target
inside a removed worktree falls back to the working tree on the next load. The comments and viewed
flags kept under that worktree's key stay in the state file and come back if a worktree is created
at the same path again.

The sidebar is the navigation, and the only navigation: its three tabs — *变更*, *提交*, *Worktree* —
each fill the left column with the controls for what the middle is showing, and the top bar carries
none of it. There is no target switcher: the *变更* tab's two blocks *are* the working tree, a commit
is picked from the *提交* list, and the *审阅整条分支* and *对比两个 ref* forms below that tab's filters
open the other two. The sidebar names whatever is under review in its block header and puts a
*返回工作区* link above it.

`working`, `staged` and `all` are the three **local views** of one worktree. While any of them is
selected the sidebar shows two blocks — 未暂存 (`working`) and 已暂存 (`staged`) — instead of a
single tree, and clicking a file switches to the view it belongs to. A file that is only partly
staged appears in both. Above them sits the one figure in the app: how many of the files under review
are fully staged, which is what "staged means reviewed" amounts to. Switching between the three keeps
your comments, the draft you are typing and the current selection; only the diff is reloaded. `all`
has no control of its own (a saved `lastTarget` can still restore it; *审阅整条分支* against `@` shows
the same diff). Commit, range and `base` targets keep the single tree, and their figure counts 已读
instead, since nothing can be staged there.

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

Agents do their best work each in a worktree of its own, and the sidebar's *Worktree* tab is
where those are made and taken down without a trip to the terminal:

- *新建 worktree*, the form in the sidebar, takes a branch and a base. A name that is not a branch yet becomes one from the
  base (`main` or `master` unless you say otherwise; any ref goes) — `git worktree add -b <branch>
  <path> <base>`; an existing branch is checked out as it is, unless another worktree already has it.
  The path is suggested as a sibling of the main worktree named `<repo>-<branch>` (slashes become
  dashes) and can be edited, within limits: it has to sit under the main worktree's parent directory,
  outside every existing worktree, and be new or an empty directory.
- Each row names the checkout, its branch, and whether it is clean or how many paths `git status`
  reports. *查看* switches the review to it (the kind of target carries over, as with the selector
  in the top bar), *复制路径* is for the agent's prompt.
- *删除* always asks first, in the row it would remove, and runs `git worktree remove` without
  `--force`: a worktree with uncommitted changes is not removed until you confirm again, since those
  changes go with it, and whatever else git refuses without `--force` is put to you the same way.
  *一并删除分支* is offered in that same confirmation, ticked by default, and takes the branch by
  `git branch -d`: one that is not merged is kept and the toast says why. The comments and viewed
  flags kept under the worktree's key stay in the state file, as before.
- A worktree whose directory was deleted behind git's back is listed struck through; *清理* drops that
  one entry (`git worktree remove` handles it; nothing is pruned wholesale).

## Keyboard

| Key | Action |
|---|---|
| `r` | Refresh the current target (file list + open diff, then re-anchor comments) |
| `j` / `k` | Next / previous file, walking Unstaged then Staged and switching view at the boundary |
| `n` / `p` | Next / previous hunk |
| `s` | Stage (Unstaged view) or unstage (Staged view) the picked lines |
| `Ctrl+Enter` | Save the comment being edited |
| `Esc` | Drop the picked lines / cancel editing / cancel re-attach mode / shut the rail / back to 变更 |

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
[Re-anchoring](#re-anchoring)); the file's *viewed* flag is dropped because its diff changed. Every
page open on the worktree reloads at once.

Limits, each reported as a plain error rather than a half-applied patch:

- Only the Unstaged and Staged views stage; `all`, `base`, commits and ranges are read-only.
- Binary files and mode-only changes go whole or not at all; a mode change rides along only with *暂存文件*.
- A staged deletion can be unstaged whole, not by line: the index has nothing left to put lines back into.
- A pick that would split a file's missing trailing newline from its neighbours is refused; include them.
- The request carries the hash of the diff the pick was made on. If the file or the index moved since
  (the agent kept editing), the server answers 409 and the page reloads instead of staging the wrong lines.
- If another git process holds the index lock the server retries briefly, then gives up with 409.

## Comments and export

Press the `+` that appears next to a line (drag to cover several lines) and write Markdown. What you
write lands in the right-hand rail, which is shut until it has something to hold: it costs 360px of
the code column, which is most of it once the diff is side by side on a laptop. Writing a comment,
focusing one or re-attaching one opens it; so does the *评论* switch at the right of the top bar,
which carries the count and turns violet while any comment is still waiting to go back to the agent.
`Esc` shuts it again.

Each comment belongs to the `old` or `new` side of the diff and has a status:

- `active` (待导出) — not yet exported
- `exported` (已导出) — copied at least once (excluded from "copy all" unless *含已导出* is checked)
- `orphaned` (已失联) — the code it referred to no longer exists in the current diff

"复制评论" copies every active comment of the current target; each comment also has a "复制此条" button.
The clipboard format is fixed so an agent can read it directly:

````markdown
# Review comments
Target: working
Repo: /home/user/project
Count: 2

## src/features/order/OrderList.tsx:120-124 (new)
```tsx
120 | const total = items.reduce((s, i) => s + i.price, 0);
121 | // ...
```
> 这里没有考虑 discount 字段，参考 utils/price.ts 里的 calcTotal。

## src/features/order/hooks/useOrder.ts:42 (new)
```ts
42 | useEffect(() => { fetchOrder(id) }, []);
```
> 依赖数组缺少 id。
````

Issues can be copied in the same format (with the issue title, status and body on top).

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
  Anything still visible in Unstaged or Staged survives, including as a context line.

Commit, range and `base` targets each keep their own pool and only ever search themselves, and none of
them deletes on a moved HEAD.

Comment markers in the diff belong to one view; the rail's *全部* tab lists the whole pool and
*此文件* lists every comment on the open file regardless of which view it currently sits in.

*已读* is per view, so a half-staged file can be marked read on one side and not the other. It is
bound to a hash of the file's diff; when the diff changes the flag is dropped and the file is marked
*已变化*.

## Auto-refresh

warden polls the worktree every 1.5 s while the page is open (`git status --porcelain
--untracked-files=all`, HEAD, the branch name, plus mtime and size of the paths status reports — enough to notice a second edit to an
already-modified file) and pushes a change event over `GET /api/events` (SSE). The page then re-runs
the normal refresh: re-anchor, reload both file lists, reload the open diff. Your draft comment,
selection, current view and current file are left alone, and the diff is scrolled back to where you
were reading. Turn it off with the *自动* toggle next to the refresh button; `r` still
refreshes by hand.

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
can share it. Delete the directory to reset.

`targets` is keyed by target key, plus one *comment scope* per worktree — `local`, or
`worktree:<path>:local` — holding the comments the three local views share and the HEAD sha the last
re-anchor saw. `viewed` stays on the individual view keys. Issues and todos are top level. State
written by an older version is migrated on load: comments filed under `working` / `staged` / `all`
move into the matching scope the first time the file is read.

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
`worktree list`, `ls-files`, `status`, `merge-base`, `rev-list`) that refuses option-looking refs and any write-capable
flag; requests that would need anything else get HTTP 400. The writes are few and each composes its
own arguments. `POST /api/targets/:key/stage` runs `git apply --cached` (with `--reverse` for the
Staged view) on a patch the server itself builds from the diff it just produced — the patch is never
taken from the request, only the line indices are, and they are checked against the diff's hash
first. `POST /api/worktrees` and `POST /api/worktrees/remove` run `git worktree add`, `git worktree
remove` and `git branch -d` with a branch name git has validated, a ref that resolves, and a
path confined to the main worktree's parent directory. Nothing writes to the working tree or HEAD of
an existing checkout; refs change only when a worktree is made (its new branch) or removed (its merged
branch, on request), and the review state lives outside the repository. A mutating request the
browser labels as coming from another site (`Sec-Fetch-Site: cross-site`) is refused with 403, so a
page from elsewhere cannot drive the server through the browser it is open in.

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

Each checkout reports commits ahead/behind the branch currently checked out in the main repository. “Merged” means its HEAD is reachable from the main checkout HEAD; squash merges and cherry-picks do not imply this. Expand a row to browse its paginated commit history (including shared commits) or view that branch’s todos.

The optional tmux integration discovers sessions whose `session_path` resolves to the main repository directory. Click tmux to create a window immediately when exactly one session matches. With multiple matches, choose a session first. The new window starts in the worktree directory. It uses `tmux new-window -d -c` without sending a shell command; existing windows stay selected. No session is created automatically. Run warden alongside tmux in Linux, macOS, or WSL, using the same user/server environment. See the [tmux manual](https://man.openbsd.org/tmux.1).

`GET /api/tmux/sessions` lists matching sessions. `POST /api/tmux/windows` accepts a registered worktree `path` and a matching `sessionId`; the server revalidates both before creating a window. This optional action creates a terminal window but does not modify repository files.

The sidebar uses a view selector for Changes, Commits, and Worktrees. The `Layout/Sidebar` stories demonstrate the selector together with each view’s real sidebar controls and content.
