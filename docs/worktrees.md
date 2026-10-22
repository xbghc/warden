# Worktrees and tasks

Warden follows the [workflow contract](workflow.md). Choose an explicit local **primary development
branch** (主开发分支), such as `feature/order`, for one requirement. All edits belong in task
worktrees; dependencies, development servers and user-run validation belong in its primary directory.
Workspace creation does not install dependencies or launch an agent.

## Development workflow

The left navigation’s *工作区* list holds the ordered work plan. Add a task and its notes, reorder it, and select
*创建工作区* when needed. Planning does not create a Git branch or pin a baseline. A task can use
a new numbered worktree, an available detached slot, or a validated existing numbered checkout.
The default is an independent clone, keeping agent development objects outside the primary
repository. A linked Git worktree remains an explicit option. Ordering never enforces dependencies.

A workspace corresponds to one linear task. It can contain multiple local commits and make multiple
deliveries without being recycled. There is no task-complete declaration or release step. Editing
notes and ordering remain available while work is in progress. Historical TODO descriptions and
historical metadata is retained; old checked items migrate as archived notes, not accepted commits.

The primary branch can change when no integration or connection is using the primary directory.
Tasks remain associated with the branch for which they were created.

## Workspace hooks

Settings contain local repository configuration, outside task branches. The configuration contains
only a `hooks` object. Warden creates workspaces and runs these user-provided scripts; users choose
external tools for agent execution and interaction.

`hooks.create` and `hooks.reuse` are optional POSIX shell commands executed after the assignment is
saved, with the workspace as cwd. Linux and macOS use `/bin/sh -c`; native Windows uses Git for
Windows' bundled `sh.exe -c`. They expose stdout/stderr, exit code and failure. A failed hook
leaves the workspace intact; retry it explicitly. Hooks have a 60-second timeout and bounded output.
Warden does not provide a dependency installer or a process supervisor.

Environment: `WARDEN_REPO`, `WARDEN_WORKTREE`, `WARDEN_BRANCH`, `WARDEN_DEVELOPMENT_BRANCH`,
`WARDEN_TASK_ID`, `WARDEN_HOOK_EVENT` (`create` or `reuse`). These scripts are distinct from Git's
normal commit hooks. Reuse applies only to a genuinely unassigned available slot, never to a task
whose most recent delivery happened to succeed.
Inherited Git repository/index/object-store overrides are removed before running a hook, so a Git
command in it operates on the assigned workspace. Normal identity and configuration still apply.

## Connected previews

Use the connection switches in the left *工作区* list to select one or more task workspaces. Warden snapshots their live committed and
uncommitted changes relative to each workspace's undelivered baseline. It composes them with
three-way patch application in an independent temporary repository. Only a complete, successful
composition is applied to primary working files. Its real index and HEAD are unchanged.

*主目录预览* shows the current combination, primary path, update time and refresh/error feedback.
Workspace selection stays in the sidebar, and file review stays in each workspace’s detail; the
preview page does not repeat either list.

The running server refreshes connections approximately every two seconds. Initial conflicts fail
the connection attempt and preserve the previous set and files. A later conflict preserves the last
coherent preview and marks it stale. Adjust the source edits or selection, then refresh. Disconnecting
recomposes the remaining contributions; it does not discard unexpected user or tool edits.

Before replacing files, Warden verifies the primary HEAD, index and complete nonignored working
snapshot against its ownership record. Unexpected modifications block synchronization and identify
why. The user handles those changes. Primary dependency directories remain outside the preview
when ignored by Git. This version conservatively blocks unrelated nonignored files too.

## Squash acceptance

Select a task and file to review directly. *准备合入…* accepts all current undelivered changes from
a **clean committed source**, pinned to the reviewed source and primary HEAD. Source commits may
continue from the previous delivery without first rebasing. `sourceBase` records that previous
source tip so A1 is excluded when delivering A2.

Preparation first composes the delivery in an isolated repository. It pauses connections, removes
only their owned temporary contribution, then stages the delivery in the checked-out primary branch.
Only one preparation uses that directory at a time. Other connected workspaces cannot enter the
resulting commit. Review takes place before preparation; the page shows the resulting staged diff.

Run tests in the primary directory when needed, enter a message, and choose *提交到主开发分支*.
There is no test-passed checkbox. Warden runs ordinary `git commit -m` with the checkout's identity,
signing, `core.hooksPath`, `pre-commit`, `prepare-commit-msg`, `commit-msg` and `post-commit` behavior.
It never uses `--no-verify` or `commit-tree` for delivery. The server checks the current HEAD and
staged-diff fingerprint again before committing.

Hook failure preserves files/index and displays the output. Handle any hook edits and retry.
A successful commit with uncommitted leftovers stays pending until those files are handled.
A manual terminal commit can be recorded from the page after checking its exact SHA; it must be a
single child of the prepared parent. Interrupted preparation can be retried only against its known
snapshot. Unexpected changes are preserved. No reset/clean or undo action is involved.

A completed delivery appends a stable record containing its source range, primary parent, commit,
message and creation time. It leaves the task worktree and branch in place. Connections resume
against the new primary baseline; if their current contributions conflict, the page reports that
separately from the successful commit. New plans do not inherit the occupied workspace.

## Synchronization

Warden checks workspaces in isolated repositories and shows **已是最新**, **预计可直接 rebase**,
**预计有冲突**, **存在阻碍**, or **尚不能判断**. Checking does not modify an agent's files, index or refs.
Dirty/busy workspaces are blocked; a changed revision invalidates a check. Git state is not proof
that an agent has stopped.

Open *同步工作区* and select one, several or all workspaces. The page skips unknown/blocked/conflicting
checks; the server rechecks both observed heads and actual checkout conditions. Explicit execution
uses `rebase --no-autostash --onto <primary> <last-delivered-source-or-base>`, avoiding duplicate
squashed work. Each workspace has its own result. An actual conflict remains in that workspace for
the user to resolve manually. There is no automatic stash, background rebase or forced continuation.
Manual synchronization that incorporates the current primary HEAD is recognized on refresh.

## History arrangement

*提交历史* shows the most recent 100 primary commits, oldest first. Select a start, then reorder or
edit messages from that commit through HEAD. The draft does not change Git. Preview cherry-picks
in an independent temporary repository with hooks and signing disabled. Current delivery commits
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

Legacy checkout/release/remove HTTP APIs remain for older clients. They refuse to release or reuse
an assigned task's slot and are not part of the new page navigation. Legacy ready/resume HTTP APIs
also remain; ready no longer rebases, and no readiness protocol is exposed by the agent CLI.

## Clone slots

Independent clones are the default, providing their own `.git` directories and isolating agent
objects from the primary repository. Delivery applies the final reviewed patch; explicit rebase
imports exact primary commits into the clone from validated local repositories, without remote
fetches or remote-tracking ref updates. Clone ownership and branch
validation use the same rules as other task workspaces.
