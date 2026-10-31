# VS Code

The Marketplace display name is **Warden Workspace Review**; the extension ID remains `xbghc.warden`.
The extension is the product entry point. It invokes the typed `@warden/engine` API directly, without
HTTP, a listening port, a browser server or an installed Warden CLI.

## Install from source

```sh
pnpm install
pnpm package:vscode
code --install-extension packages/vscode/warden-0.20.4.vsix
```

Warden automatically uses the Git repository of the single open folder; there is no separate project selector.
Open the primary directory and choose **Warden: Select Base Branch**. The branch must be checked out in
primary. In a multi-root window, **Warden: Select Repository** selects one repository; the selection is remembered.
Git and user-script dependencies must exist where the workspace lives. VS Code 1.106 or newer and Workspace Trust are required;
browser-only virtual filesystems are unsupported. SSH, WSL and containers use the workspace extension host.

## Workbench

The **Workbench** sidebar contains **Preview** and **Tasks**. A task describes planned work; its
**Workspace** is the directory allocated for execution. **Sync Preview** composes saved content into the
preview directory; **Rebase** brings a task workspace forward through an explicit rebase.

Warden's sidebar and activity-bar entry appear only when the window contains at least one workspace
folder. An empty window or a saved workspace with no folders does not show a repository picker.
While discovering or opening a repository, the sidebar and workflow pages show **Opening repository…**
without setup actions. Before configuration, the sidebar shows only the next setup action: **Select Repository** when needed, then
**Select Base Branch**. Preview status and operational navigation appear after branch
selection. Opening a workflow page early shows the same setup action instead of empty controls.

After this initial choice, switching the primary checkout in Git or VS Code automatically changes
Warden's task list, current task and synchronization checks. Selection is remembered per
repository and base branch. Existing task notes and commit drafts remain
with their tasks. Branches at the same commit are still separate contexts; old page actions are rejected
after a switch. Existing native diffs and ACP conversations retain their original task.

Finish delivery preparation and disconnect preview connections before switching. If Git switches
while either is still active, the sidebar explains why Warden remains on the previous branch and asks
you to return there to resolve it. Detached HEAD and unfinished Git operations keep the current context.

The native workbench tree keeps preview and ordered tasks together.
These two section labels use text without leading icons; expansion arrows and action buttons remain native.
The heading exposes refresh, add-task and synchronization; its **More Actions** (⋯) menu contains **Settings**.
Each allocated task offers Agent, preview connection and commit as inline actions; its context menu holds opening the workspace,
editing notes, delivery records, synchronization, copying and recovery. Allocation failures expose
retry on the same task; script failure rows expose script output and retry.

Task file lists collapse independently and preserve that choice across refreshes. Selecting a task
restores its existing native diff and scroll; background updates do not advance a pinned review.
Drag a task or press Alt+Up/Down with its row focused to change plan order. The Command Palette also
provides an explicit move picker. Drag data and menu actions are bound to the originating repository
session, so old operations cannot affect another requirement after navigation.

Add-task uses a native input box for the title. Enter creates the task and automatically assigns its
workspace and branch, then runs the configured initialization script. Escape cancels while retaining
the draft and prior task selection. Drafts belong to their repository and base branch and
clear after the task is saved. Directory and storage details require no user input. Older unallocated
plans are prepared automatically on use; archived plans require restoration. Opening a task does not launch an agent.

The commit action uses a native input box. Enter submits with ordinary Git hooks and signing;
Escape retains the draft without staging. Task, repository and review version stay pinned while
typing. Failures remain visible in the row tooltip and native notifications; context actions expose
recovery and re-review. Opening a workspace uses a new VS Code window.

Delivery records use native pickers leading to read-only commit diffs. Script output uses the Warden
output channel. Multiline task notes use an explicitly opened editor webview; its task-bound draft
survives switching tasks and hiding/reopening the panel. Preview details, batch
rebase and script settings retain dedicated editor panels. Task Chat uses the Secondary Side Bar. Prefer native controls
for future interactions and choose a webview only when its particular layout warrants one.

Task-note drafts persist in VS Code workspace state when the editor is closed. Saving or discarding
notes clears the matching draft; edits typed while a save is pending remain available. Draft storage
never updates task records or Git.

Packaged webviews follow VS Code themes and send a finite validated action vocabulary to the host.
ACP conversations retain their original task independently of tree selection.

## ACP agent configuration

Open **More Actions (⋯) → Settings → ACP Agent** or **ACP Setup Guide and Example** in a task conversation for the inline setup
example. **Configure Agent** opens the matching VS Code setting; the guide stays collapsed until requested.

Configure `warden.acpAgents` in VS Code User settings, or Remote User settings for SSH, WSL and
containers. Executable profiles cannot come from workspace or folder settings. The executable must
exist on the workspace extension host and speak ACP over stdio, either natively or through an adapter.
It must execute its own file and command tools: Warden does not advertise ACP filesystem or terminal
capabilities or provide a shell runner, agent sandbox or execution guard.

```json
{
  "warden.acpAgents": [
    {
      "id": "local-agent",
      "label": "My ACP agent",
      "command": "/path/to/agent",
      "args": []
    }
  ]
}
```

This is a profile shape, not a vendor command recipe. Replace the executable and arguments with those
required by your agent or adapter; there is no universal ACP startup flag. An optional `env` object supplies
string environment overrides. Use the agent's existing login and inherited environment as appropriate;
Warden does not add a credential store. A normal CLI without ACP support cannot use this connection.

Open a task's **Chat with Agent** to show **Task Chat** in the Secondary Side Bar, select its profile,
and connect or send text. **Switch Task Chat** in the view title chooses another task; selecting a task
in the workbench continues to open its diff. **Open Chat in Editor** expands the same conversation;
**Move Chat to Side Bar** returns it. Only one surface edits a task's chat at a time, while different
tasks may be expanded side by side. Drafts and reading positions survive switching. The composer
stays at the bottom, and session details and history scroll within the available height.
Hiding or switching a chat leaves its agent running. Task rows show permission requests, activity
and failures without stealing focus. VS Code remembers user changes to the view's location.

Merely opening a chat does not launch the agent. The view shows replies, tool activity and permission choices supplied by
the agent. Select an advertised authentication method if needed; terminal-based login must be completed
separately on the same host. There are no client-side file or terminal tool callbacks.

Connected conversations display the agent's session configuration selectors, such as model, mode or
reasoning level. Older agents can expose the legacy mode selector instead. Changes use only the
agent's offered values and wait for confirmation before another prompt can be sent. Available slash
commands can be inserted into the draft without sending it. Streamed thoughts, reported context usage
and cost, live notices and context-compaction updates are displayed when the agent provides them.
These reports do not change task state or run Git operations.
At most two common selectors stay visible, favoring model and mode categories. Other controls live
under **More Session Options**; **Task and Session Info** holds the reported agent name, session title and usage.
Permission requests, live notices and connection errors remain directly visible.

**Warden: Add Selection to Task Chat** appends selected editor text to a chosen task's draft; it does not send
the message. The excerpt includes its file or immutable review snapshot, line range and an unsaved
content label when applicable. The original editor and native review remain unchanged.

The conversation retains its original task, workspace identity and repository. One extension window owns each
task's executable connection; other tasks can run independently. Conversation records persist outside
the source repository. After interruption, **Resume Session** explicitly loads the original session when the
agent supports it. Otherwise **New Session** starts again while retaining previous history. Warden never
silently resends a prompt whose outcome is uncertain.

**Stop Turn** requests cancellation. **Disconnect** closes Warden's connection and its agent process; an
active connection can expose this as **End Agent Process**. These actions do not promise that every command
started by the agent has stopped. The agent owns its child commands and execution policies; coordinate
ongoing work before Git mutations. A turn ending never connects preview, commits, delivers or rebases.
Native review and its source/baseline pins remain unchanged.

The implementation is tested with an SDK-compatible child-agent fixture and packaged extension flows.
That does not establish support for an untested authenticated third-party agent. See
[Working with agents](agent.md) and the [ACP design](acp-design.md) for the supported boundary.

## Edit, review and run

Edit and save human code in primary. Agents edit task workspaces through their own tools. Both sides of native
`warden-review` diffs are read-only snapshots. **Warden: Copy Review Location**, also available from the editor
context menu and Ctrl+Alt+C / Cmd+Alt+C, copies the original relative path and selected line range.
Snapshots can be read after a window reload, but a restored tab does not authorize a delivery.

Clean committed review pins the source commit, delivery boundary and primary HEAD. A newer source
or baseline requires reopening the current diff. Background refresh cannot advance the version the
user reviewed. Live uncommitted changes are readable and can be connected to preview, but must be
committed and reopened before delivery. Binary changes identify the pinned version for external review.
There are no read markers, staging controls or review-completion declarations.

Task workspaces and preview use an external shared repository by default, at
`<primary>-warden/repo.git`; primary remains independent. Preview is never added as a workspace root.
Its directory retains ignored dependencies and caches. Unexpected source edits there stop publication
and remain available for manual handling. A conflicting initial connection fails without changing the
selected combination; later conflicts keep the last coherent preview and report stale content.

**Open Preview Terminal** sets a native terminal's cwd to preview. **Run Preview** executes the optional
`warden.previewCommand` through VS Code Tasks there. Other user terminals, tasks and debug sessions
are not redirected. Use the displayed preview path or `${command:warden.previewPath}` where supported.
The preview page shows **Run Preview** only when that command is configured, keeping **Open Preview Terminal**
available in either case. Environment setup appears only for a configured script or a recorded result;
rerun is offered only while the script remains configured.

The engine combines repository-change hints, state-file notifications and periodic checks. Preview
publication still compares content hashes and debounces updates. A separate background-owner lease
prevents duplicate preview writers in multiple windows; writes retain the existing repository lock.
Closing the final Warden window stops synchronization. On reopening, journals and actual content are
checked before preview synchronization resumes. Existing preview programs are not restarted or killed by Warden.

## Environment setup

Open **More Actions (⋯) → Settings** or **Warden: Settings** in the Command Palette. Save a workspace initialization
command and an optional idempotent preview setup command. Initialization runs for every fresh allocation, including when an
internally available directory is used. Existing distinct create/reuse script settings are preserved
until the user explicitly saves a unified initialization command; differing legacy configuration is shown.

Preview setup runs on initialization, successful code updates, configuration changes and explicit retry.
Its success, output and exit code are separate from code synchronization. It receives `WARDEN_REPO`,
`WARDEN_WORKTREE`, `WARDEN_PREVIEW`, `WARDEN_DEVELOPMENT_BRANCH` and `WARDEN_HOOK_EVENT=preview`.
Workspace initialization receives the task context documented in [Working with agents](agent.md).
Scripts use the existing POSIX shell selection, ten-minute timeout and bounded output. Windows uses
Git for Windows' shell. Task descriptions never become executable script configuration.

## Delivery and history

Review the intended version, then use the commit action on its task row. VS Code opens its
top input box for the commit message; Enter submits and Escape cancels while preserving the draft.
Cancellation does not stage files. The submitted message and reviewed versions are fixed for that operation. Unrelated primary
edits block delivery. Other connections remain in the independent preview. Ordinary commit hooks and
signing run in primary; success records the exact commit and delivery association.

A hook failure retains the prepared contents. Fix the cause, reopen the retained staged diff, and retry.
A manually created commit must be reopened before recording it. Interrupted preparation has an explicit
recovery action. **Finish Recovered Commit Preparation** remains available only after the original primary content has
been restored and verified; it does not reset or clean user files. Commit success and subsequent preview
failure are separate results.

**Rebase** displays checks with their revisions and times. Select one, several or all, then request
rebase. Every result is displayed, including skipped and failed items. Checks never mutate active files;
Git cleanliness does not establish agent idleness.

Use VS Code's native Source Control Graph to browse base-branch commit history. Warden's
history browser and arrangement interface are deferred. Existing history drafts and engine journals
are retained; refresh and branch switching do not read or modify those drafts. Per-task delivery
records still open their commits through the native picker and diff flow.

## Existing data

The extension keeps the existing state-file path, schema version 1, unknown historical metadata,
numbered task directories, external Git storage and operation journals. It does not move task state
into a window-local store. Only UI selection and drafts use VS Code workspace storage. Native review
snapshots use extension storage. Older primary-directory previews retain their ownership-checked migration.

Stop old Warden CLI processes before adopting this version. Old versions cannot interpret all current
preview and recovery semantics; a new compatibility marker cannot make old code enforce them. The
repository contains a legacy in-process HTTP adapter only under `test/compat`, for regression tests.
It is not packaged or runnable as a product server. Existing external initialization scripts keep their
context, but scripts that used retired Warden CLI commands must be updated to use their own tools.

## Automated publishing

Only an explicitly requested `vX.Y.Z` tag publishes `xbghc.warden`. The extension manifest is the version
source; the repository root is a private workspace without an npm binary or publishing entry.
`pnpm check:release` validates release metadata; `pnpm check:vscode` validates the packaged assets.

CI tests the TypeScript and Git CLI engine on Windows, Linux and macOS, packages one JavaScript VSIX,
and exercises that same artifact in minimum-supported and stable VS Code hosts on all three platforms.
The release workflow publishes the tested bytes through the existing `vscode-marketplace` Entra
federated identity. Manual runs only verify Marketplace authentication. No local publication is performed.
The existing publisher Contributor permission and GitHub environment identity configuration remain in use.
