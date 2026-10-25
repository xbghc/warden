# Worktrees and tasks

Warden follows the [workflow contract](workflow.md). Choose an explicit local **primary development
branch** (主开发分支), such as `feature/order`, for one requirement. Human edits belong in primary and agent edits in task
workspaces. Dependencies, development servers and user-run validation belong in the independent preview directory.
Workspace creation does not install dependencies or launch an agent.

## Development workflow

The left navigation’s *工作区* list holds the ordered work plan. Add a task and its notes, reorder it, and select
*创建工作区* when needed. Planning does not create a Git branch or pin a baseline. A task can use
a freshly allocated logical workspace and branch. Warden may internally reuse a clean, unassigned
physical directory; the user does not choose a previous workspace.
The default is a worktree of Warden's external shared repository. Agent development objects stay
outside the primary repository while tasks and preview can read the same Git objects directly.
Independent clones remain a compatibility option for tooling that requires its own `.git` directory.
Existing primary-linked worktrees remain usable. Ordering never enforces dependencies.

A workspace corresponds to one linear task. It can contain multiple local commits and make multiple
deliveries without being recycled. There is no task-complete declaration or release step. Editing
notes and ordering remain available while work is in progress. Historical TODO descriptions and
historical metadata is retained; old checked items migrate as archived notes, not accepted commits.

The primary branch can change when no integration or active connection belongs to it.
Tasks remain associated with the branch for which they were created.

## Shared repository

The primary checkout retains its own Git repository. Warden creates a separate bare repository at
`<primary>-warden/repo.git`; default task directories remain numbered siblings such as
`<primary>-1` and `<primary>-2`. Newly created preview and temporary composition worktrees live in Warden's
external data directory and use the same shared repository. Each worktree has independent files,
HEAD and index. Branch references and Git objects are shared among these Warden worktrees.

Primary commits are imported locally when needed. Saved uncommitted primary and task content is
captured without changing the real indexes. Composition uses a separate worktree and publishes only
a complete candidate to the persistent preview. Delivery applies only the reviewed final patch to
primary and commits there with its ordinary hooks and signing. Agent and preview histories do not
enter primary.

The shared repository outlives temporary operations and preview worktrees. Existing clones,
primary-linked worktrees and standalone runtime previews keep their paths and repositories;
Warden does not relocate active tasks or existing previews. Old operation journals remain recoverable.
Warden started from a shared task still resolves to the primary repository's state and lock.
Internal composition disables hooks and signing only for its own commands, without changing the
shared repository's configuration or ordinary agent commits.

## Workspace hooks

Settings contain local repository configuration, outside task branches. The configuration contains
a `hooks` object and an optional idempotent `previewSetup` command. Warden creates workspaces and runs
these user-provided scripts. Users can explicitly start an ACP task conversation or use external
tools; initialization does not start an ACP session. See [Working with agents](agent.md).

The settings form presents one workspace initialization script and writes it to both `hooks.create`
and `hooks.reuse`. Existing differing scripts remain unchanged until the user saves settings.
These legacy fields are optional POSIX shell commands executed after the assignment is
saved, with the workspace as cwd. Linux and macOS use `/bin/sh -c`; native Windows uses Git for
Windows' bundled `sh.exe -c`. They expose stdout/stderr, exit code and failure. A failed hook
leaves the workspace intact; retry it explicitly. Hooks have a ten-minute timeout and bounded output.
Warden does not provide a dependency installer or supervise agent-started commands. Its ACP client
owns only the process carrying its stdio connection; agents execute their own tools.

Environment: `WARDEN_REPO`, `WARDEN_WORKTREE`, `WARDEN_BRANCH`, `WARDEN_DEVELOPMENT_BRANCH`,
`WARDEN_TASK_ID`, `WARDEN_HOOK_EVENT` (`create` or `reuse`). These scripts are distinct from Git's
normal commit hooks. Reuse applies only to a genuinely unassigned available slot, never to a task
whose most recent delivery happened to succeed.
Inherited Git repository/index/object-store overrides are removed before running a hook, so a Git
command in it operates on the assigned workspace. Normal identity and configuration still apply.

## Connected previews

Use the connection switches in the left *工作区* list to select one or more task workspaces. Warden snapshots their live committed and
uncommitted changes relative to each workspace's undelivered baseline. It composes them with
three-way patch application in a temporary worktree of the external shared repository. Only a complete, successful
composition is published to the independent preview directory, including saved primary content
as its baseline. Primary files, index and HEAD are unchanged by connections.

*预览* shows the current combination, runtime path, update time and refresh/error feedback.
Workspace selection stays in the sidebar, and file review stays in each workspace’s detail; the
preview page does not repeat either list.

One extension session owns background preview synchronization; it checks content each second and
debounces saved edits. Other windows observe shared state and can take over when the owner closes. Initial conflicts fail
the connection attempt and preserve the previous set and files. A later conflict preserves the last
coherent preview and marks it stale. Adjust the source edits or selection, then refresh. Disconnecting
recomposes the remaining contributions; it does not discard unexpected user or tool edits.

Before replacing preview files, Warden verifies its saved ownership tree. Unexpected preview edits
block synchronization and remain available for manual repair. Edit human code in primary and agent
code in task workspaces. Ignored dependencies and caches persist in preview. Saved primary edits
are observed by content and debounced into preview; they are not unexpected edits to discard.

## Squash acceptance

Select a task and file to review directly. *提交到主开发分支…* accepts all current undelivered changes from
a **clean committed source**, pinned to the reviewed source, delivery boundary and primary HEAD. Source commits may
continue from the previous delivery without first rebasing. `sourceBase` records that previous
source tip so A1 is excluded when delivering A2.

Preparation first composes the delivery in an isolated worktree. It leaves the independent preview running and stages only that delivery in the checked-out
primary branch. Existing primary user edits must be handled first.
Only one preparation uses that directory at a time. Other connected workspaces cannot enter the
resulting commit. Review takes place before preparation; normal delivery prepares and commits
in one operation. The staged diff is shown for recovery after an interrupted operation.

Run tests in the preview directory when needed, review the complete delivery, enter a message,
and choose *提交到主开发分支*. Editing a message does not stage anything.
There is no test-passed checkbox. Warden runs ordinary `git commit -m` with the checkout's identity,
signing, `core.hooksPath`, `pre-commit`, `prepare-commit-msg`, `commit-msg` and `post-commit` behavior.
It never uses `--no-verify` or `commit-tree` for delivery. The engine checks the current HEAD and
staged-diff fingerprint again before committing.

Hook failure preserves files/index and displays the output. Handle any hook edits, refresh the
retained staged comparison and review it before retrying against that exact fingerprint.
A successful commit with uncommitted leftovers stays pending until those files are handled.
A manual terminal commit can be recorded from the page after checking its exact SHA; it must be a
single child of the prepared parent. Interrupted preparation can be retried only against its known
snapshot. Unexpected changes are preserved. No reset/clean or undo action is involved.

A completed delivery appends a stable record containing its source range, primary parent, commit,
message and creation time. It leaves the task worktree and branch in place. Connections update
against the new primary baseline; if their current contributions conflict, the page reports that
separately from the successful commit. New plans do not inherit the occupied workspace.

## Synchronization

Warden checks workspaces in isolated repositories and shows **已是最新**, **预计可直接 rebase**,
**预计有冲突**, **存在阻碍**, or **尚不能判断**. Checking does not modify an agent's files, index or refs.
Dirty/busy workspaces are blocked; a changed revision invalidates a check. Git state is not proof
that an agent has stopped.

Open *同步工作区* and select one, several or all workspaces. The page skips unknown/blocked/conflicting
checks; the engine rechecks both observed heads and actual checkout conditions. Explicit execution
uses `rebase --no-autostash --onto <primary> <last-delivered-source-or-base>`, avoiding duplicate
squashed work. Each workspace has its own result. An actual conflict remains in that workspace for
the user to resolve manually. There is no automatic stash, background rebase or forced continuation.
Manual synchronization that incorporates the current primary HEAD is recognized on refresh.

## History arrangement

*提交历史* shows the most recent 100 primary commits, oldest first. Select a start, then reorder or
edit messages from that commit through HEAD. The draft does not change Git. Preview cherry-picks
in an isolated temporary worktree with hooks and signing disabled for those commands. Current delivery commits
still use their ordinary hooks; history preview is not another validation run.

The first version accepts only consecutive linear commits with one parent and the same final tree
as the original tip. Conflicts or different final content require changing the draft. Apply checks
that the original HEAD still matches, journals an external temporary backup, imports the candidate and updates the
primary ref with an expected-old-value check. The final files/index stay identical. Delivery IDs
remain associated with the rewritten commits, and workspaces remain unchanged until explicit rebase.
There is no history undo/restore UI, automatic remote push or merge-commit arrangement.

## Slots

Release/removal, explicit rebase and history application require an automatic verified local backup.
Backup failure stops the operation. See [Safety backups](backups.md) for contents, storage costs,
supported layouts and recovery. Successful rebase/history operations remove their temporary backups
after persisting their results; interrupted operations keep recovery data. Rebase also refuses to
overwrite ignored local files. Delivery applies only the final reviewed patch to the primary
repository, without importing agent source history or retaining internal Git refs.

Numbered directories (`<repo>-1`, `<repo>-2`, ...) remain available to their tasks across deliveries.
A reusable slot is detached, clean, valid, unassigned and not inside a Git operation; this is a Git
fact, not an agent-idle status. Normal delivery never releases or deletes a branch.

Legacy checkout/release/remove and ready/resume HTTP adapters exist only in regression tests.
They still refuse to release or reuse an assigned task's slot. The extension offers fresh workspace
allocation and recovery actions; it exposes no readiness protocol.

## Clone slots

Independent clones are a compatibility option, providing their own `.git` directories and branch refs.
Preview and replay import the required clone commits into the external shared repository; primary
still receives only the final reviewed patch. Explicit rebase
imports exact primary commits into the clone from validated local repositories, without remote
fetches or remote-tracking ref updates. Clone ownership and branch
validation use the same rules as other task workspaces.
