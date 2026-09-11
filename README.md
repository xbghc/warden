# warden

Local web UI for reviewing git diffs — built for reviewing changes that a coding agent just made,
with line comments you can copy back to the agent as a prompt.

- Runs as a single local process per repository (`127.0.0.1` only, no auth, no database).
- Diff sources: working tree, staged, working tree vs HEAD, any commit, any two refs, and git worktrees.
- Side-by-side **Unstaged** and **Staged** file lists, so staging a hunk in your editor is what marks it reviewed.
- GitHub-style unified / side-by-side diff with syntax highlighting, collapsed file tree, lazy per-file loading, context expansion, virtual scrolling.
- Line comments (single line or a dragged range), Markdown, edit / delete.
- One click copies all comments as an agent-readable prompt to the clipboard.
- Review state (viewed files, comments, local issues, todos, preferences) persists outside the repo and survives restarts.
- Comments follow the code: they move with a hunk that gets staged, re-attach after the agent edits the file, and are cleaned up once the change is committed.
- Auto-refresh — warden watches the repository and reloads itself when you edit, stage, commit or switch branches.
- Local issues (title, Markdown body, open/closed).
- Branch-scoped todos, exportable as a numbered checklist.
- Commit history browser.
- Click a line number to jump to that line in a running nvim instance (WSL2 friendly).
- Read-only with respect to git: only whitelisted read sub-commands are ever executed.

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
| One commit | `commit:<sha>` | `git diff <sha>^ <sha>` |
| Two refs | `range:<base>..<head>` | `git diff <base>...<head>` |
| Worktree, working tree | `worktree:<path>:working` | same, run inside the worktree |
| Worktree, branch vs base | `worktree:<path>:range:<base>..<head>` | same, run inside the worktree |

Refs accept anything git can resolve (`main`, `v1.2`, `HEAD~3`, a sha). `@` is `HEAD`.
Worktrees are discovered with `git worktree list` and share the review state of the main repository.

`working`, `staged` and `all` are the three **local views** of one worktree. While any of them is
selected the sidebar shows two blocks — Unstaged (`working`) and Staged (`staged`) — instead of a
single tree, and clicking a file switches to the view it belongs to. A file that is only partly
staged appears in both. Switching between the three keeps your comments, the draft you are typing
and the current selection; only the diff is reloaded. Commit and range targets keep the single tree.

## Keyboard

| Key | Action |
|---|---|
| `r` | Refresh the current target (file list + open diff, then re-anchor comments) |
| `j` / `k` | Next / previous file, walking Unstaged then Staged and switching view at the boundary |
| `n` / `p` | Next / previous hunk |
| `Ctrl+Enter` | Save the comment being edited |
| `Esc` | Cancel editing / close a panel / cancel re-attach mode |

## Comments and export

Press the `+` that appears next to a line (drag to cover several lines) and write Markdown.
Each comment belongs to the `old` or `new` side of the diff and has a status:

- `active` — not yet exported
- `exported` — copied at least once (excluded from "copy all" unless *含已导出* is checked)
- `orphaned` — the code it referred to no longer exists in the current diff

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

Comment markers in the diff belong to one view; the rail's *全部* tab lists the whole pool and
*此文件* lists every comment on the open file regardless of which view it currently sits in.

"Viewed" is per view, so a half-staged file can be marked read on one side and not the other. It is
bound to a hash of the file's diff; when the diff changes the flag is dropped and the file is marked
*已变化*.

## Auto-refresh

warden polls the worktree every 1.5 s while the page is open (`git status --porcelain`, HEAD, the
branch name, plus mtime and size of the paths status reports — enough to notice a second edit to an
already-modified file) and pushes a change event over `GET /api/events` (SSE). The page then re-runs
the normal refresh: re-anchor, reload both file lists, reload the open diff. Your draft comment,
selection, current view and current file are left alone, and the diff is scrolled back to where you
were reading. Turn it off with the *自动* toggle next to the refresh button; `r` still
refreshes by hand.

## Todos

Notes attached to a branch rather than to a line of code, for the things you notice while reviewing
that do not belong in a comment. They are not deleted when you commit. The Todos drawer filters by
status, defaults to the current branch and can show all branches; *复制 Todo* copies the open ones
(optionally including the done ones, marked ` (done)`) as:

```markdown
# TODO
Branch: feature/x
Repo: /home/user/project
Count: 2

## 1. 补充 OrderList 的空状态
描述正文（Markdown）…

## 2. useOrder 的依赖数组缺少 id
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

Single user, local only. The server binds to `127.0.0.1`, executes git only through
`execFile('git', [...])` with an argument whitelist (`rev-parse`, `diff`, `show`, `log`, `worktree list`,
`ls-files`, `status`), refuses option-looking refs and any write-capable flag, and never writes into the
repository. Requests that would need anything else get HTTP 400.

## Development

```sh
pnpm install
pnpm dev          # API server on :4100 (tsx watch) + Vite dev server on :5173 with /api proxied
pnpm test         # vitest: diff parser, anchoring, comment scopes, watcher, todos, export, state, HTTP API
pnpm typecheck
pnpm build        # dist/web (Vite) + dist/cli.js (tsup, zero runtime dependencies)
node dist/cli.js path/to/repo
```

### Component development with Storybook

```sh
pnpm storybook        # http://127.0.0.1:6006 (no API server required)
pnpm build:storybook  # static site in packages/web/storybook-static
```

Storybook also includes TopBar, CommentRail, IssuesDrawer and TodosDrawer under `Layout`, with
repository/worktree targets, editor availability, comment drafts, orphaned comments, issue details
and todo filters. Their shared fixtures in `packages/web/.storybook/demo-store.ts` keep edits in
memory; export callbacks are recorded in Actions without writing to the clipboard or calling the API.

Storybook uses the [React + Vite framework](https://storybook.js.org/docs/get-started/frameworks/react-vite)
and the application's CSS. Markdown, CommentEditor, FileTree and Toast stories cover populated,
empty, loading and error states where applicable. Controls edit component props; the Actions panel
records mocked callbacks. CommentEditor and FileTree also include interaction checks in their stories.

Add `*.stories.tsx` next to a component using `Meta` and `StoryObj` from `@storybook/react-vite`.
Configuration lives in `packages/web/.storybook`. The preview resets Zustand before each story;
FileTree replaces API-backed actions with in-memory mocks. Store-backed Docs examples use separate
iframes so their state stays isolated. New store-backed stories must mock any API actions they use.
Storybook configuration and stories are included in `pnpm typecheck`, and CI builds the static site.

### Project layout

```
bin/cli.ts           argument parsing, start server, open browser
packages/shared      types + target key / comment scope helpers (bundled into both sides)
packages/server      Hono API, git wrapper, diff parser, targets, anchoring, watcher, state, export, nvim
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
