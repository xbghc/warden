# warden

Local web UI for reviewing git diffs — built for reviewing changes that a coding agent just made,
with line comments you can copy back to the agent as a prompt.

- Runs as a single local process per repository (`127.0.0.1` only, no auth, no database).
- Diff sources: working tree, staged, working tree vs HEAD, any commit, any two refs, and git worktrees.
- GitHub-style unified / side-by-side diff with syntax highlighting, collapsed file tree, lazy per-file loading, context expansion, virtual scrolling.
- Line comments (single line or a dragged range), Markdown, edit / delete.
- One click copies all comments as an agent-readable prompt to the clipboard.
- Review state (viewed files, comments, local issues, preferences) persists outside the repo and survives restarts.
- Comments re-attach to the code after the agent changes the file; when the commented code itself is gone they are marked *orphaned* and shown at the top of the file.
- Local issues (title, Markdown body, open/closed) that link comments.
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

## Keyboard

| Key | Action |
|---|---|
| `r` | Refresh the current target (file list + open diff, then re-anchor comments) |
| `j` / `k` | Next / previous file |
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
position; otherwise search the file for the same line sequence (context lines disambiguate duplicates);
otherwise it becomes *orphaned* and is listed at the top of the file with the original snippet, where it
can be deleted or re-attached by picking a new selection.

"Viewed" is bound to a hash of the file's diff. When the diff changes the flag is dropped and the file
is marked *已变化*.

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
pnpm test         # vitest: diff parser, anchoring, export format, state store, HTTP API on a temp repo
pnpm typecheck
pnpm build        # dist/web (Vite) + dist/cli.js (tsup, zero runtime dependencies)
node dist/cli.js path/to/repo
```

Layout:

```
bin/cli.ts           argument parsing, start server, open browser
packages/shared      types + target key helpers (bundled into both sides)
packages/server      Hono API, git wrapper, diff parser, targets, anchoring, state, export, nvim
packages/web         React + Vite UI (shiki highlighting, @tanstack/react-virtual, react-markdown)
test/                API integration tests on a generated git repository
```

Only `dist/`, `README.md`, `LICENSE` and `package.json` are published.

## License

MIT
