# Workspaces and tasks

Warden follows the [workflow contract](workflow.md) and [terminology](terminology.md).
Choose an explicit local **base branch**, such as `feature/order`, for one requirement.
Human edits belong in primary and agent edits in task
workspaces. Dependencies, development servers and user-run validation belong in the independent preview directory.
Workspace creation does not install dependencies or launch an agent.

## Development workflow

The left navigation’s *Tasks* list holds the ordered work plan. Adding a task automatically allocates
its own workspace and branch from the current requirement baseline, then runs the configured
initialization script. The user enters a title and can rename or reorder tasks afterward.
Directory, branch and storage choices stay internal. Warden may reuse a clean, unassigned physical
directory without adopting its old logical workspace.

Allocation failure preserves the task and its error for retry. Repeated requests reuse its assigned
workspace. Legacy plans receive a workspace when used; archived plans require restoration first.
Read-only refresh never allocates workspaces. Script failure retains the assigned workspace and
script output, with a separate script retry action.
The default is an independent clone with its own `.git` directory, because many tools and build
systems do not support linked worktrees. Agent development objects stay outside the primary
repository; preview composition imports the task commits it needs into Warden's external shared
repository. Existing shared-repository worktrees and primary-linked worktrees remain usable. Ordering never enforces dependencies.

A workspace corresponds to one linear task. It can contain multiple local commits and make multiple
deliveries without being recycled. There is no task-complete declaration or release step. Renaming
and ordering remain available while work is in progress. Historical TODO descriptions and
historical metadata are retained as unread data; old checked items migrate as archived notes, not accepted commits.

Selecting a base branch explicitly starts tracking it in Warden, even before it has tasks.
Switching the primary checkout in Git or VS Code restores only previously tracked branches.
An untracked branch or detached HEAD hides tasks, checks, preview status and preview recovery actions;
it does not configure a requirement or update the retained preview. **Select Base Branch** is the
explicit entry point for using Warden on another branch. Switching back restores the previously selected
task and retained preview connections. Branch names define the context even if their commits are identical. Tasks
remain associated with their original branch; following the primary checkout never rebases, replaces
or recycles their workspaces, and it does not redirect existing ACP conversations.

Finish any delivery preparation and disconnect the preview before switching between tracked requirements. If an
external checkout selects another tracked branch while either is active, Warden retains the previous context and explains
the mismatch. Switch back to resolve the outstanding operation first. Leaving for an untracked branch
quietly suspends the workbench without clearing either operation. Unfinished Git operations do not
select another requirement. The independent preview directory and its ignored
dependencies persist across switches; its synchronization status becomes pending until refreshed for
the new branch, and the configured setup script receives the new base branch.

## Shared repository

The primary checkout retains its own Git repository. Warden creates a separate bare repository at
`<primary>-warden/repo.git` for preview and composition. Task directories remain numbered siblings
such as `<primary>-1` and `<primary>-2`; new ones are independent clones, while tasks created by
earlier versions may still be worktrees of the shared repository. Opening Warden inside a clone
Warden made (marked by `warden.main`) uses its primary's state; a sibling clone made by hand is its own
primary. Newly created preview and temporary composition worktrees live in Warden's
external data directory and use the shared repository. Each worktree has independent files,
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
The shared repository mirrors primary's `info/exclude`, `info/attributes`, line-ending settings and
filter/merge/diff drivers before each composition and preview check, so a file ignored only locally
in primary is ignored in preview too. Hooks, identity and signing are not mirrored.
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
On timeout or output overflow, Warden terminates the setup process group on Linux/macOS or its process
tree on Windows, and waits for cleanup before reporting a retryable failure. If cleanup cannot be
confirmed, setup remains running and blocks retry, rebase and deletion while its host owner is live
or uncertain. Stop the identified commands and close their owning Warden window before recovering.
Preview setup uses the same cleanup rule and blocks recomposition while cleanup is uncertain.
Scripts that deliberately detach into a new POSIX session are outside the owned process group;
setup scripts should finish their foreground work rather than launch persistent daemons.
A run interrupted by a closed window or host restart is reported as failed once its recorded owner
process and the script's own process group have both exited on this host, so it can be retried; the
task row shows **Setup Running** meanwhile. A script that outlives its window keeps blocking retry,
rebase and deletion until it finishes. A run recorded before the host last booted has ended.
Warden does not provide a dependency installer or supervise agent-started commands. Its ACP client
owns only the process carrying its stdio connection; agents execute their own tools.

Environment: `WARDEN_REPO`, `WARDEN_WORKTREE`, `WARDEN_BRANCH`, `WARDEN_DEVELOPMENT_BRANCH`,
`WARDEN_TASK_ID`, `WARDEN_HOOK_EVENT` (`create` or `reuse`). These scripts are distinct from Git's
normal commit hooks. Reuse applies only to a genuinely unassigned available slot, never to a task
whose most recent delivery happened to succeed.
Inherited Git repository/index/object-store overrides are removed before running a hook, so a Git
command in it operates on the assigned workspace. Normal identity and configuration still apply,
and the script keeps the inherited locale and pager settings.

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
coherent preview and marks it stale. Adjust the source edits or selection, then choose *Sync Preview*.
The same sources, baseline and preview content are not composed again automatically; a change to any
of them, or *Sync Preview*, retries. Disconnecting
recomposes the remaining contributions; it does not discard unexpected user or tool edits.

Before replacing preview files, Warden verifies its saved ownership tree. Unexpected preview edits
block synchronization and remain available for manual repair. A publication interrupted midway is
returned to the previous preview when every path still holds its previous or its candidate content;
any other content is kept for manual repair. Edit human code in primary and agent
code in task workspaces. Ignored dependencies and caches persist in preview. Saved primary edits
are observed by content and debounced into preview; they are not unexpected edits to discard.

## Squash delivery

Select a task and file to review directly. *Commit to Base Branch…* accepts all current undelivered changes from
a saved workspace snapshot, including staged, unstaged and non-ignored untracked files. No source commit
is required. The source HEAD, saved content, delivery boundary and primary HEAD are pinned by review. Source commits may
continue from the previous delivery without first rebasing. `sourceBase` records that previous
source tip, and `sourceTree` records delivered saved content, so A1 is excluded when delivering A2 even
without a new task commit. Delivery leaves the task files, index and branch unchanged. After a manual rebase or merge incorporates
primary commits newer than the recorded boundary, refreshed review, delivery, rebase and preview use
the newest incorporated primary commit as the effective boundary, even after primary moves on or
reverts one of them; a request with the previous boundary requires a new review.

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
the user to resolve manually. There is no automatic stash or forced continuation.
Manual synchronization that incorporates newer primary commits is recognized on refresh.

### Automatic rebase

With `warden.autoRebase` on (the default), Warden rebases a workspace by itself after a check
reports **Can Rebase**, using the same engine path and guards as an explicit rebase. Only idle tasks
qualify: the workspace is clean with no Git operation in progress, no setup script or deletion is
running, and its Task Chat has no turn, permission wait, cancellation, reset or connection in
progress. A task skipped while its agent was busy qualifies once the turn ends. Each check result is
acted on at most once. A cancellation timeout or a live connection with an uncertain result remains
busy. The owning window reserves an idle conversation while rebase queues and runs, preventing a
new turn or connection from starting in that interval. Other windows skip that task's live connection;
the engine verifies ownership again under the connection metadata lock before changing Git.
If the real replay stops at a conflict the isolated check did not predict,
Warden runs `git rebase --abort`, confirms the workspace is back on its previous commit, clean and
without a Git operation, discards the safety backup and reports the task as skipped; the check still
offers a manual rebase. Agents working in the workspace outside Task Chat are not detected, so turn
the setting off when such agents commit or edit there.

## History arrangement

Inspect commit history through VS Code's native Source Control Graph. History arrangement is
deferred in the product. The existing engine implementation, delivery associations and recovery
journals remain covered by compatibility tests; see [State and security](internals.md).

## Slots

Legacy slot release/removal, explicit rebase and history application require an automatic verified local backup.
Backup failure stops the operation. See [Safety backups](backups.md) for contents, storage costs,
supported layouts and recovery. Successful rebase/history operations remove their temporary backups
after persisting their results; interrupted operations keep recovery data. Rebase also refuses to
overwrite ignored local files. Delivery applies only the final reviewed patch to the primary
repository, without importing agent source history or retaining internal Git refs.

Numbered directories (`<repo>-1`, `<repo>-2`, ...) remain available to their tasks across deliveries.
A reusable slot is detached, clean, valid, unassigned and not inside a Git operation; this is a Git
fact, not an agent-idle status. Normal delivery never releases or deletes a branch.

Explicit task deletion releases its allocation without a backup after user confirmation. It discards
tracked edits and non-ignored untracked files, detaches HEAD and keeps the physical folder and its
ignored environment files. Stopped Git operations are quit before release. It does not remove nested
repositories or overwrite ignored files. If retained environment files are no longer ignored after
resetting a task-edited `.gitignore`, the directory remains preserved but is not reusable until clean.
New tasks always switch a reusable directory to a fresh task branch from their own base.

Allocation records whether Warden actually created the branch. Deletion can remove that exact branch
after release, even when squash delivery left it unmerged by ancestry. Unknown legacy ownership,
another checkout using the branch, or a changed branch tip retains the branch and reports that fact.
A missing checkout permits task removal and cleanup of its exact stale Git registration; a replacement
directory is never cleaned. Interrupted deletion reserves the allocation until an explicit retry.

Legacy checkout/release/remove and ready/resume HTTP adapters exist only in regression tests.
They still refuse to release or reuse an assigned task's slot. The extension allocates workspaces with task creation and offers recovery actions; it exposes no readiness protocol.

## Clone slots

New tasks use independent clones, providing their own `.git` directories and branch refs.
Preview and replay import the required clone commits into the external shared repository; primary
still receives only the final reviewed patch. Explicit rebase
imports exact primary commits into the clone from validated local repositories, without remote
fetches or remote-tracking ref updates. Clone ownership and branch
validation use the same rules as other task workspaces.

A new clone starts with primary's local Git setup, as a linked worktree would: commit identity and
signing, line-ending settings, filter/merge/diff drivers, local excludes and attributes, and hooks.
A `core.hooksPath`, such as a tracked hooks directory, is copied as a setting and stays current.
Hooks in primary's default `.git/hooks` directory, local excludes and attributes are copied when
the clone is made; changes made in primary afterwards reach only clones made later. Remotes,
credentials and other local settings are not copied, and clone branches stay out of primary.
Existing workspaces are not changed.
