# VS Code

The Marketplace display name is **Warden Workspace Review**; the extension ID remains `xbghc.warden`.
The extension is the product entry point. It invokes the typed `@warden/engine` API directly, without
HTTP, a listening port, a browser server or an installed Warden CLI.

## Install from source

```sh
pnpm install
pnpm package:vscode
code --install-extension packages/vscode/warden-0.23.0.vsix
```

Warden automatically uses the Git repository of the single open folder; there is no separate project selector.
Open the primary directory and configure an agent through **Warden: Configure ACP**. Warden connects
automatically at startup and after profile changes. Once connected, choose **Warden: Select Base Branch**. The branch must be checked out in
primary. In a multi-root window, **Warden: Select Repository** selects one repository; the selection is remembered.
Git and user-script dependencies must exist where the workspace lives. VS Code 1.106 or newer and Workspace Trust are required;
browser-only virtual filesystems are unsupported. SSH, WSL and containers use the workspace extension host.

## Workbench

The Warden sidebar stacks two native collapsible views: **Workbench** and **Settings**. Both appear
by default; Settings uses a native tree for ACP controls and scripts. Workbench contains ordered tasks as
top-level items, without grouping rows. A task describes planned work; its
**Workspace** is its allocated execution context, with an assigned directory and branch. **Sync Preview** composes saved content into the
preview directory; **Rebase** brings a task workspace forward through an explicit rebase.

Task context menus and the Command Palette offer **Delete Task…**. Confirmation discards the task's
pending work and releases its workspace without a backup, normally retaining the directory and
ignored local environment files. A local agent connection is closed as part of that confirmed action.
Already contributed base-branch commits remain. Interrupted cleanup stays visible with **Retry Delete**.

Warden's sidebar and activity-bar entry appear only when the window contains at least one workspace
folder. An empty window or a saved workspace with no folders does not show a repository picker.
Warden automatically connects to the configured ACP server. **Configure ACP** stays hidden during
workspace loading and pending connections. If setup, authentication or recovery is needed after loading,
Workbench contains only **Configure ACP**, revealing the Settings view below it. There is no separate
connection-check page. Connection progress, errors, authentication and reconnect controls live in Settings.
Repository discovery shows **Opening repository…**. Once connected, it offers **Select Repository** when needed and
**Select Base Branch**. An existing branch resumes its saved workbench. Other workflow panels link to
Settings while unavailable, and ordinary commands remain blocked until connected.

Selecting a base branch starts tracking it in Warden, including branches without tasks. Switching
the primary checkout in Git or VS Code automatically restores previously tracked branches.
Untracked branches and detached HEAD show no tasks, preview status, synchronization checks or recovery
messages. Automatic preview updates pause, and **Select Base Branch** remains available to start using
Warden there. Selection is remembered per
repository and base branch. Existing task notes and commit drafts remain
with their tasks. Branches at the same commit are still separate contexts; old page actions are rejected
after a switch. Existing native diffs and ACP conversations retain their original task.

Finish delivery preparation and disconnect preview connections before switching between tracked branches.
If Git switches to another tracked branch while either is still active, the sidebar explains why Warden
remains on the previous branch and asks you to return there to resolve it. Untracked branches quietly
retain that work for your return. Unfinished Git operations never select another requirement.

The native workbench tree opens directly into tasks and their changed files. With no tasks, **New Task**
is available in the empty view and heading. The heading exposes refresh, add-task and rebase; its
**More Actions** (⋯) offers the configured **Run Preview** command, otherwise **Open Preview Terminal**,
and reveals **Settings** in the sidebar. Repository selection appears only when needed or in multi-root
windows; preview recovery actions appear while their failures persist. Preview has no editor page or tree row.
The status bar shows preview synchronization; conflicts and setup failures remain visible above the task list.
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
survives switching tasks and hiding/reopening the panel. Batch rebase retains a dedicated editor panel. Settings opens setup scripts in native text editors;
Save updates the script for its original repository, preserving unrelated script configuration and
distinct legacy reuse scripts. Unsaved edits stay in the editor; stale repository or script versions
cannot overwrite current configuration. Workspace scripts run on allocation; preview setup retains its normal automatic triggers. Preview diagnostics use the Warden output channel. Task Chat uses the Secondary Side Bar. Prefer native controls
for future interactions and choose a webview only when its particular layout warrants one.

Task-note drafts persist in VS Code workspace state when the editor is closed. Saving or discarding
notes clears the matching draft; edits typed while a save is pending remain available. Draft storage
never updates task records or Git.

Packaged webviews follow VS Code themes and send a finite validated action vocabulary to the host.
ACP conversations retain their original task independently of tree selection.

## ACP agent configuration

ACP is the currently implemented integration. The [agent contract](agent.md#minimum-integration-contract)
requires messaging and task-workspace binding, not ACP or ownership of the agent process. Other
integrations must implement and verify those capabilities before they can unlock the workbench.

Use **Configure ACP** to reveal the native **Settings** view below Workbench and expand its ACP section,
including when it was previously collapsed or hidden. **Choose Agent Preset** opens the
native Codex/OpenCode picker. Each preset has one stable profile ID; selecting an existing preset
opens its settings without adding a duplicate. Saving connects automatically, using the new preset.
At startup Warden uses the last successfully selected profile when available, otherwise the first
configured profile. No profile picker opens automatically.

The startup connection initializes ACP and an empty session without a work prompt or Warden task.
It stays open while Warden runs. Configuration replacement, disconnect, failure and shutdown close its
stream and stop its owned process. Task conversations keep separate connections in their own workspace
directories; shutdown closes those too. Saving profiles or reopening Warden never resumes task work.
If authentication is required, sign in explicitly in Settings or externally and use **Connect ACP**.
Failures retain their reason and reconnect controls; Warden does not restart a failing agent repeatedly.
An empty session cannot guarantee provider behavior deferred until an actual prompt. Existing task
records and drafts survive connection failures and shutdown.

Choose a preset, confirm the executable name or absolute path on the workspace host, then press Enter
to save it. Escape cancels without writing. Existing profiles are preserved; choosing an already
configured preset opens settings rather than replacing it. **Custom Agent / Edit Settings** opens
`warden.acpAgents` for other agents, custom arguments and environment variables. Invalid configuration
goes directly to settings for repair.

| Preset | Executable | Arguments | Preparation |
| --- | --- | --- | --- |
| Codex | `codex-acp` | `[]` | Install the [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp), for example with `npm install -g @agentclientprotocol/codex-acp`, and follow its authentication instructions. The normal `codex` command is not an ACP server. |
| OpenCode | `opencode` | `["acp"]` | Install [OpenCode](https://docs.opencode.ai/docs/acp/) and configure its provider credentials on the workspace host. |

On Windows, choose the actual native `.exe` path. npm `.cmd` wrappers cannot be launched directly;
use **Custom Agent / Edit Settings** to configure `node` with the installed JavaScript entry point
and any required arguments instead. Saving a preset starts the automatic connection. Warden does not
download, install or authenticate the agent automatically, or set a model or permission policy.

Expand **Configure ACP → ACP → ACP Setup Guide** in Settings for the upstream installation guides.
The guide stays collapsed until requested. **Agent Profiles** opens native User or Remote User settings
for detailed configuration. Other workflow pages link to Settings; Task Chat contains no preset picker
or setup guide.

### Custom agent examples

Open **Configure ACP → ACP → Custom Agent Example** for the
[commented template](../packages/vscode/examples/acp-agents.jsonc) bundled with the extension.
It opens in a native text editor, including offline. Opening or editing that example does not change
your settings. Use **Agent Profiles → Edit in settings.json**, or **Preferences: Open User Settings (JSON)**,
to copy the setting into your own configuration. In a remote window, use
**Preferences: Open Remote Settings (JSON)** on that workspace host. Keep existing settings and agents.

Configure `warden.acpAgents` in VS Code User settings, or Remote User settings for SSH, WSL and
containers. Executable profiles cannot come from workspace or folder settings. The executable must
exist on the workspace extension host and speak ACP over stdio, either natively or through an adapter.
It must execute its own file and command tools: Warden does not advertise ACP filesystem or terminal
capabilities or provide a shell runner, agent sandbox or execution guard.

```json
{
  "warden.acpAgents": {
    "local-agent": {
      "label": "My ACP agent",
      "command": "/absolute/path/to/acp-agent",
      "args": [],
      "env": {}
    }
  }
}
```

Copy the object **inside** `agent_servers` from [Zed](https://zed.dev/docs/ai/external-agents#custom-agents)
or [JetBrains](https://www.jetbrains.com/help/ai-assistant/acp.html#add-custom-agent) as the value of
`warden.acpAgents`; do not include the `agent_servers` wrapper or place it at the root of VS Code settings.
This supports their custom stdio entry shape, not their entire configuration file. Zed's optional
`"type": "custom"` is accepted. Client-specific options such as MCP forwarding, registry installation
and JetBrains execution environments are not implemented and must be removed. The agent must still
meet Warden's tool-capability requirements above.

| Field | Meaning |
| --- | --- |
| Object key (`local-agent`) | Stable name identifying the agent and its saved conversations. Spaces and Unicode are allowed; do not rename it to change only the display name. |
| `label` | Optional display name; defaults to the object key. |
| `command` | Installed executable name on PATH or absolute path on the workspace host. Supply only the executable here. |
| `args` | Optional array of separate, literal arguments; defaults to `[]`. Use the agent's documented ACP startup arguments. |
| `env` | Optional string environment overrides, merged with the host environment. For example, `{"EXAMPLE_OPTION": "value"}` only if your agent supports that variable. |

Replace the placeholder executable with an installed ACP agent or adapter. There is no universal ACP
startup flag: an agent might require `["acp"]`, another `[]` or a different argument list. Warden launches
the executable directly, with no implicit shell or expansion of `~`, `$VAR`, `${env:NAME}` or
`${workspaceFolder}`. Keep paths with spaces as one JSON string, without additional shell quotes.
Warden supplies the process and session cwd; do not hard-code another project in the launch arguments.
Use the agent's own login or inherited environment on the same host. A normal CLI without ACP support
cannot use this connection.

For a JavaScript adapter, use `node` (or its absolute path) as the command and the adapter entry point
as its first argument. On Windows, this avoids trying to launch an npm `.cmd` wrapper directly:

```json
{
  "warden.acpAgents": {
    "local-agent": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Agents\\adapter.js"],
      "env": {}
    }
  }
}
```

Replace those paths with the actual Node executable and installed adapter's documented entry point.
On Linux/macOS the equivalent is a native Node path and an absolute POSIX adapter path.
Remote windows launch on the remote host, so use that host's paths, installation and login.

Legacy arrays such as `[{"id": "local-agent", "label": "My ACP agent", "command": "/path/to/agent"}]`
still work. To convert one, make each `id` the object key, keep its `label`, `command`, `args` and `env`,
and remove the inner `id`. This preserves the profile identity used by existing conversations.
Preset saves preserve whichever format is already configured; new configurations use objects.
Saving User or Remote User settings triggers the normal automatic connection. Errors and
authentication actions appear in Warden Settings; detailed diagnostics are in **Output → Warden**.

### Task Chat

Open a task's **Chat with Agent** to show **Task Chat** in the Secondary Side Bar. Opening automatically
resumes the saved session or creates the first session, without a manual connect or create step.
New conversations use the agent verified in workbench setup; existing conversations retain their agent.
Agent configuration and the ACP setup guide stay in workbench setup and settings.
**Switch Task Chat** in the view title chooses another task; selecting a task
in the workbench continues to open its diff. **Open Chat in Editor** expands the same conversation;
**Move Chat to Side Bar** returns it. Only one surface edits a task's chat at a time, while different
tasks may be expanded side by side. Drafts and reading positions survive switching. The composer
stays at the bottom, and session details and history scroll within the available height.
Hiding or switching a chat leaves its agent running. Task rows show permission requests, activity
and failures without stealing focus. VS Code remembers user changes to the view's location.

Opening a chat never sends a prompt. The view shows replies, tool activity and permission choices supplied by
the agent. Select an advertised authentication method if needed; terminal-based login must be completed
separately on the same host. There are no client-side file or terminal tool callbacks.

Connected conversations display the agent's session configuration selectors, such as model, mode or
reasoning level. Older agents can expose the legacy mode selector instead. Changes use only the
agent's offered values and wait for confirmation before another prompt can be sent. Available slash
commands appear when you type `/` at the start of the message. Type to filter, use Up/Down to choose,
Enter or Tab to insert, and Escape to dismiss; completion does not send the draft. Streamed thoughts, reported context usage
and cost, live notices and context-compaction updates are displayed when the agent provides them.
These reports do not change task state or run Git operations.
Mode, Model and reasoning effort appear in one row below the message text, followed by Send.
Only selectors provided by the agent appear; long values truncate rather than wrap. Other controls
live under **More Session Options** in the header. **More Chat Actions** contains disconnect and
**Task and Session Info**, which holds task paths, agent identity, session title and usage.
Enter sends, Shift+Enter inserts a line, and the send button becomes Stop Turn while responding.
Permission requests, live notices and connection errors remain directly visible.

**Warden: Add Selection to Task Chat** appends selected editor text to a chosen task's draft; it does not send
the message. The excerpt includes its file or immutable review snapshot, line range and an unsaved
content label when applicable. The original editor and native review remain unchanged.

The conversation retains its original task, workspace identity and repository. One extension window owns each
task's executable connection; other tasks can run independently. Conversation records persist outside
the source repository. Reopening a disconnected chat loads the original session when the agent supports
it. Otherwise **New Session** starts again while retaining previous history. Warden never
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

**Open Preview Terminal** opens or reveals a native terminal for the current repository and preview
directory. It reuses a live matching terminal; a closed terminal or a different repository or directory
gets a new one. When shell integration reports a changed cwd, that terminal is not reused.
**Run Preview** executes the optional
`warden.previewCommand` through VS Code Tasks there. Other user terminals, tasks and debug sessions
are not redirected. Use the displayed preview path or `${command:warden.previewPath}` where supported.
The workbench's **More Actions** menu shows **Run Preview** when that command is configured, otherwise
**Open Preview Terminal**. Normal saved changes synchronize automatically. **Sync Preview** appears
in the menu for stale, conflicting, failed or paused synchronization; **Rerun Preview Setup** appears
for a failed configured setup script. Recovery entries remain visible until the problem clears.
Conflicts still require inspecting the affected paths and adjusting the sources or connections.
The Command Palette retains all preview commands, including **Open Preview Terminal**, **Sync Preview**,
**Copy Preview Path** and **Show Preview Output**, regardless of the compact menu's selection.
Clicking the preview status bar opens **Show Preview Output**: current composition, directory, last
successful sync, conflict paths and recorded setup status, output and exit code. Reading output does
not synchronize or run setup. **Refresh** only rereads visible state; it does not invoke **Sync Preview**.
**Select Base Branch** remains in initial setup and the Command Palette. Later context changes follow
tracked branches checked out through Git in primary. Settings is the single configuration entry in More Actions;
the unavailable-agent welcome still offers **Configure ACP**.

The engine combines repository-change hints, state-file notifications and periodic checks. Preview
publication still compares content hashes and debounces updates. A separate background-owner lease
prevents duplicate preview writers in multiple windows; writes retain the existing repository lock.
Closing the final Warden window stops synchronization. On reopening, journals and actual content are
checked before preview synchronization resumes. Existing preview programs are not restarted or killed by Warden.

## Environment setup

Expand **Settings** below Workbench, use **More Actions (⋯) → Settings**, or run **Warden: Settings**.
Select **Workspace Setup Script** or **Preview Setup Script** to edit a multiline shell script in the
native text editor. Save updates the original repository's configuration; clearing and saving removes
the script. Initialization runs for every fresh allocation, including when an internally available
directory is used. A distinct legacy reuse script has its own row and is preserved when editing the
workspace setup script. **Preview Command** opens the native VS Code setting for the development server.

Preview setup runs on initialization, successful code updates, configuration changes and explicit retry.
Its success, output and exit code are separate from code synchronization. It receives `WARDEN_REPO`,
`WARDEN_WORKTREE`, `WARDEN_PREVIEW`, `WARDEN_DEVELOPMENT_BRANCH` and `WARDEN_HOOK_EVENT=preview`.
Workspace initialization receives the task context documented in [Working with agents](agent.md).
Use **Rerun Preview Setup** on the configured **Preview Setup Script** row for an explicit rerun,
including after a successful run. The action remains bound to that row's repository and branch context.
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
