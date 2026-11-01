# Workspaces and tasks

Warden follows the [workflow contract](workflow.md) and [terminology](terminology.md).
Choose an explicit local **base branch**, such as `feature/order`, for one requirement.
Human edits belong in primary and agent edits in task
workspaces. Dependencies, development servers and user-run validation belong in the independent preview directory.
Workspace creation does not install dependencies or launch an agent.

## Development workflow

The left navigation’s *Tasks* list holds the ordered work plan. Adding a task automatically allocates
its own workspace and branch from the current requirement baseline, then runs the configured
initialization script. The user enters a title and can edit notes or reorder tasks afterward.
Directory, branch and storage choices stay internal. Warden may reuse a clean, unassigned physical
directory without adopting its old logical workspace.

Allocation failure preserves the task and its error for retry. Repeated requests reuse its assigned
workspace. Legacy plans receive a workspace when used; archived plans require restoration first.
Read-only refresh never allocates workspaces. Script failure retains the assigned workspace and
script output, with a separate script retry action.
The default is a worktree of Warden's external shared repository. Agent development objects stay
outside the primary repository while tasks and preview can read the same Git objects directly.
Independent clones remain a compatibility option for tooling that requires its own `.git` directory.
Existing primary-linked worktrees remain usable. Ordering never enforces dependencies.

A workspace corresponds to one linear task. It can contain multiple local commits and make multiple
deliveries without being recycled. There is no task-complete declaration or release step. Editing
notes and ordering remain available while work is in progress. Historical TODO descriptions and
historical metadata is retained; old checked items migrate as archived notes, not accepted commits.

After initial configuration, switching the primary checkout branch in Git or VS Code makes Warden
show that branch's tasks and workspaces automatically. Switching back restores the previously selected
task. Branch names define the context even if their commits are identical. Tasks
remain associated with their original branch; following the primary checkout never rebases, replaces
or recycles their workspaces, and it does not redirect existing ACP conversations.

Finish any delivery preparation and disconnect the preview before switching requirements. If an
external checkout changes while either is active, Warden retains the previous context and explains
the mismatch. Switch back to resolve the outstanding operation first. Detached HEAD and unfinished
Git operations do not select another requirement. The independent preview directory and its ignored
dependencies persist across switches; its synchronization status becomes pending until refreshed for
the new branch, and the configured setup script receives the new base branch.

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
Shallow primary clones retain their shallow boundary when imported into the shared repository. This
keeps task history and review usable after agent commits without downloading additional remote history.

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

Use the connection switches in the left *Tasks* list to select one or more task workspaces. Warden snapshots their live committed and
uncommitted changes relative to each workspace's undelivered baseline. It composes them with
three-way patch application in a temporary worktree of the external shared repository. Only a complete, successful
composition is published to the independent preview directory, including saved primary content
as its baseline. Primary files, index and HEAD are unchanged by connections.

Preview synchronization stays visible in the status bar. Its tooltip and **Show Preview Output**
provide the current combination, runtime path and last successful sync; output also includes conflict
paths and setup logs. The workbench heading's **More Actions** menu offers Run Preview when a command
is configured, otherwise Open Preview Terminal. Sync Preview appears for synchronization problems,
and Rerun Preview Setup for a failed configured script; both remain available until recovery.
The configured Preview Setup Script row also offers rerun. The Command Palette retains all preview
commands, including copy-path and output. Tasks are top-level sidebar items, and each task owns its connection and file review.
There is no Preview editor page. Synchronization and setup failures remain visible above the task list.

One extension session owns background preview synchronization; it checks content each second and
debounces saved edits. Other windows observe shared state and can take over when the owner closes. Initial conflicts fail
the connection attempt and preserve the previous set and files. A later conflict preserves the last
coherent preview and marks it stale. Adjust the source edits or selection, then choose *Sync Preview*. Disconnecting
recomposes the remaining contributions; it does not discard unexpected user or tool edits.

Before replacing preview files, Warden verifies its saved ownership tree. Unexpected preview edits
block synchronization and remain available for manual repair. Edit human code in primary and agent
code in task workspaces. Ignored dependencies and caches persist in preview. Saved primary edits
are observed by content and debounced into preview; they are not unexpected edits to discard.

## Squash delivery

Select a task and file to review directly. *Commit to Base Branch…* accepts all current undelivered changes from
a saved workspace snapshot, including staged, unstaged and non-ignored untracked files. No source commit
is required. The source HEAD, saved content, delivery boundary and primary HEAD are pinned by review. Source commits may
continue from the previous delivery without first rebasing. `sourceBase` records that previous
source tip, and `sourceTree` records delivered saved content, so A1 is excluded when delivering A2 even
without a new task commit. Delivery leaves the task files, index and branch unchanged. After a manual rebase incorporates the current
primary HEAD, both refreshed review and delivery use that HEAD as the effective boundary; a request
with the previous boundary requires a new review.

Preparation first composes the delivery in an isolated worktree. It leaves the independent preview running and stages only that delivery in the checked-out
base branch. Existing primary user edits must be handled first.
Only one preparation uses that directory at a time. Other connected workspaces cannot enter the
resulting commit. Review takes place before preparation; normal delivery prepares and commits
in one operation. The staged diff is shown for recovery after an interrupted operation.

Only saved file contents are included; unsaved editor buffers and ignored files are excluded.
For a partially staged file, the saved working copy is the reviewed content, not only its index version.
Run tests in the preview directory when needed, review the complete delivery, enter a message,
and choose *Commit to Base Branch*. Editing a message does not stage anything.
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

Warden checks workspaces in isolated repositories and shows **Up to Date**, **Can Rebase**,
**Conflicts Expected**, **Blocked**, or **Unknown**. Checking does not modify an agent's files, index or refs.
Dirty/busy workspaces are blocked; a changed revision invalidates a check. Git state is not proof
that an agent has stopped.

Open *Rebase* and select one, several or all workspaces. The engine rechecks both observed heads
and actual checkout conditions for every selected workspace. An unavailable workspace reports a
failed result without preventing other selected workspaces from running. If it becomes available
again, a new check must observe its source HEAD before it can run. Explicit execution
uses `rebase --no-autostash --onto <primary> <last-delivered-source-or-base>`, avoiding duplicate
squashed work. Each workspace has its own result. An actual conflict remains in that workspace for
the user to resolve manually. There is no automatic stash, background rebase or forced continuation.
Manual synchronization that incorporates the current primary HEAD is recognized on refresh.

## History arrangement

Inspect commit history through VS Code's native Source Control Graph. History arrangement is
deferred in the product. The existing engine implementation, delivery associations and recovery
journals remain covered by compatibility tests; see [State and security](internals.md).

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
They still refuse to release or reuse an assigned task's slot. The extension allocates workspaces with task creation and offers recovery actions; it exposes no readiness protocol.

## Clone slots

Independent clones are a compatibility option, providing their own `.git` directories and branch refs.
Preview and replay import the required clone commits into the external shared repository; primary
still receives only the final reviewed patch. Explicit rebase
imports exact primary commits into the clone from validated local repositories, without remote
fetches or remote-tracking ref updates. Clone ownership and branch
validation use the same rules as other task workspaces.
