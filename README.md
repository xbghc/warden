# warden

A local web page for reviewing what a coding agent just changed in a git repository, and for handing
your review back to it — line comments the agent fetches and answers itself.

One process per repository, on `127.0.0.1` only, with no account and no database. It stages from the
page and manages worktree slots, but otherwise leaves the repository alone; see
[State and security](docs/internals.md).

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

## The loop

A round with an agent, in the order it happens:

1. **Point the agent at a worktree.** In *Worktree*, *检出分支* puts a branch into a numbered slot
   beside the repository (`<repo>-1`, …) that keeps its installed dependencies between branches;
   *复制路径* is for the agent's prompt. Or let it work in the main checkout.
2. **Review what it did.** *工作区* shows 未暂存 and 已暂存 side by side. Read a change, then stage it —
   drag over the lines, or take a hunk or a file: staged means reviewed, and the figure at the top
   counts it. Commits, branches (*审阅整条分支*) and ranges are reviewed with an *已读* box instead.
3. **Comment.** The `+` beside a line, or a drag over several, opens a comment in the rail on the
   right. A task that is bigger than one place goes in *待办*, and can carry comments with it.
4. **Hand it back.** The agent runs `warden feedback` in its worktree and gets every comment it has
   not had yet; or copy them with *复制评论* and paste. Either way a checkpoint is taken, so
   *对比检查点* afterwards shows only what the agent did about this round.
5. **Close the round.** The agent answers each comment with `warden reply <id> "…"`; the answer
   appears under the comment, marked *待确认*. *解决* accepts it, *回复* asks again and sends the
   comment back out with the thread. The *Worktree* view counts, per worktree, what is still
   waiting on either side.

For step 4 to happen without being asked, put this in the agent's instructions (`CLAUDE.md`,
`AGENTS.md`, …):

```markdown
When you finish a task, run `warden feedback` (or `npx @xbghc/warden feedback`) and address every
comment it prints. After dealing with each one, run `warden reply <id> "<what you changed, or why
you did not>"`.
```

## Keyboard

| Key | Action |
|---|---|
| `r` | Refresh the current target (file list + open diff, then re-anchor comments) |
| `j` / `k` | Next / previous file, walking Unstaged then Staged and switching view at the boundary |
| `n` / `p` | Next / previous hunk |
| `s` | Stage (Unstaged view) or unstage (Staged view) the picked lines |
| `Ctrl+Enter` | Save the comment being edited |
| `Esc` | Drop the picked lines / cancel editing / cancel re-attach mode / shut the rail / back to the files under review |

## Documentation

| | |
|---|---|
| [Reviewing](docs/reviewing.md) | Targets and the sidebar, staging, debug code, 已读, checkpoints, auto-refresh |
| [Comments and the agent](docs/agent.md) | Comments, the export format, `warden feedback` / `reply`, re-anchoring, todos |
| [Worktrees](docs/worktrees.md) | Slots, checkout and release, commit counts, tmux |
| [Editor and platform](docs/environment.md) | Jumping to nvim, WSL2 |
| [State and security](docs/internals.md) | The state file, what git commands run and why |
| [Development](docs/development.md) | Building, testing, releasing, Storybook |

## License

MIT
