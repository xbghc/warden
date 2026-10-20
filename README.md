# warden

A local tool for developing one requirement with several coding agents. Plan small changes,
operate agent workspaces, review their diffs and build a clear history on your **primary development
branch** (主开发分支).

The project is being redesigned around the [agreed workflow](docs/workflow.md) and a fresh
[interaction design](docs/design.md), using shadcn/ui. Warden is a passive tool: workspaces persist
across deliveries, and users trigger Git operations without maintaining readiness or task
completion declarations. The working copy implements the new page, temporary connected previews and commit-history
arrangement. These changes have not been published to npm or the hosted Storybook.

One process per repository, on `127.0.0.1` only, with no account and no database. It integrates reviewed changes from the
page and keeps task workspaces available; see
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

## Development workflow

Warden is a passive Web workbench for parallel agent development inside one requirement.
The **primary development branch** (主开发分支), such as `feature/order`, is where reviewed
changes accumulate. It need not be the repository's default branch.

1. **Plan in the left navigation.** Add and order tasks; create each workspace when needed.
   Ordering does not impose dependencies. One workspace can deliver multiple commits.
2. **Create a workspace.** Configure optional creation/reuse hooks in settings. Warden supplies
   the workspace and hook context; use your own tools or scripts to run agents there.
3. **Connect for preview.** Choose workspaces on *主目录预览*. Their committed and uncommitted
   changes are temporarily composed into the primary directory for your dev server and tests.
   A conflicting connection fails and preserves the previous preview. HEAD and index stay unchanged.
4. **Review and commit.** Click a task and its files to review directly. Prepare the complete
   undelivered committed change, enter a message and commit in the page with normal Git hooks.
   Preparation isolates other connected changes. The workspace remains available afterwards.
5. **Synchronize or arrange history when needed.** Checks do not change agent files. Rebase one,
   selected or all eligible workspaces explicitly. In *提交历史*, edit messages and reorder a
   selected linear range, preview it, then apply. There is no undo or automatic push.

Code edits belong in task worktrees; dependencies and user-run validation belong in the primary
directory. A clean checkout does not mean an agent has stopped.
No readiness declaration, task-completion checkbox or workspace-release step is required.

The first version delivers clean, committed source changes as one squash commit per operation.
History arrangement covers the selected start through HEAD, up to the latest 100 commits;
merge/root commits and arrangements that change the final file content are rejected.
See [Workflow](docs/workflow.md), [Worktrees and tasks](docs/worktrees.md) and
[Development](docs/development.md#storybook) for local UI previews.

## Keyboard

| Key | Action |
|---|---|
| `r` | Refresh the current target (file list + open diff, then re-anchor comments) |
| `j` / `k` | Next / previous file in the selected task |
| `n` / `p` | Next / previous hunk |
| `Ctrl+Enter` | Save the comment being edited |
| `Esc` | Drop the picked lines / cancel editing / cancel re-attach mode / shut the rail / back to the files under review |
| Click a line number | Copy the review location (`path:line`) |
| `Alt`+click a line number | Copy the place as `src/a.ts:12` — `src/a.ts:12（修改前）` for a line of the old side |
| `Alt`+`Shift`+click a line number | Copy the range from the line last copied, `src/a.ts:12-18` |

The copy button beside the path in the file header copies the path, relative to the repository.

## Documentation

| | |
|---|---|
| [Workflow](docs/workflow.md) | User-controlled development loop, current-version scope and implementation alignment |
| [Interaction design](docs/design.md) | Agreed behavior, connection previews, commit arrangement and open product decisions |
| [Reviewing](docs/reviewing.md) | Targets and the sidebar, staging, debug code, 已读, checkpoints, auto-refresh |
| [Comments and the agent](docs/agent.md) | Comments, the export format, `warden feedback` / `reply`, re-anchoring, task planning |
| [Worktrees and tasks](docs/worktrees.md) | Commit plans, workspace hooks, squash acceptance and synchronization |
| [Platform](docs/environment.md) | WSL2 and browser access |
| [State and security](docs/internals.md) | The state file, what git commands run and why |
| [Development](docs/development.md) | Building, testing, releasing, Storybook |

## License

MIT
