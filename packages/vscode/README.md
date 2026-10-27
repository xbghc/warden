# VS Code

The Marketplace display name is **Warden Workspace Review**; the extension ID remains `xbghc.warden`.
The extension is the product entry point. It invokes the typed `@warden/engine` API directly, without
HTTP, a listening port, a browser server or an installed Warden CLI.

## Install from source

```sh
pnpm install
pnpm build:native
pnpm package:vscode
code --install-extension packages/vscode/warden-0.20.0.vsix
```

Warden automatically uses the Git repository of the single open folder; there is no separate project selector.
Open the primary directory and choose **Warden: 选择主开发分支**. The branch must be checked out in
primary. In a multi-root window, **Warden: 选择仓库** selects one repository; the selection is remembered.
Git and user-script dependencies must exist where the workspace lives. Workspace Trust is required;
browser-only virtual filesystems are unsupported. SSH, WSL and containers use the workspace extension host.

## Workbench

Before configuration, the sidebar shows only the next setup action: **选择仓库**, then
**选择主开发分支**. The task pane, preview status and operational navigation appear after branch
selection. Opening a workflow page early shows the same setup action instead of empty controls.

After this initial choice, switching the primary checkout in Git or VS Code automatically changes
Warden's workspace list, current task, history and synchronization checks. Selection and history drafts
are remembered per repository and development branch. Existing task notes and commit drafts remain
with their tasks. Branches at the same commit are still separate contexts; old page actions are rejected
after a switch. Existing native diffs and ACP conversations retain their original task.

Finish delivery preparation and disconnect preview connections before switching. If Git switches
while either is still active, the sidebar explains why Warden remains on the previous branch and asks
you to return there to resolve it. Detached HEAD and unfinished Git operations keep the current context.

The workspace sidebar keeps preview, history, ordered tasks and settings together. Synchronization
sits beside add-task in the native view heading. Every workspace has a persistent icon toolbar below
its title: open workspace, Agent conversation, preview connection, commit, synchronization when needed,
edit and more. Each icon has an accessible name and hover/focus help. The toolbar stays visible when
the changed-file list is collapsed; expansion and selected files persist per repository.

Selecting a task preserves its existing native diff and editor scroll. The first selection opens an
available diff; background refresh does not advance a pinned review. Dragging tasks or pressing
Alt+Up/Down on a title changes only plan order. The Command Palette also offers an explicit move picker.
There are no up/down, task-details or workspace-script entries in the more-actions menu. Copy actions,
delivery records and optional executor/storage choices remain available there.

The commit icon opens VS Code's native top input box. Enter submits with ordinary Git hooks and signing;
Escape cancels without staging and retains the draft. The task, repository and review version are fixed
when input opens, so switching context or changing the source/baseline cannot authorize different content.
Commit failures retain recovery data and show recovery actions beside the affected workspace.

Task notes, delivery records and optional workspace settings open inline in the workspace list. Unsaved
notes, choices and scroll survive hiding/reopening the webview. Script failures show output/retry actions
in place; successful scripts do not add a menu entry. Default workspace creation executes directly.
Every creation remains a fresh logical allocation and branch; physical directory reuse is internal.
The optional executor name is only a label. Opening a workspace uses a new native VS Code window.

Task review reserves the editor area for native read-only diffs. Preview, history arrangement, batch
rebase and settings remain editor webviews. History entries expose native file review through a file
picker. All resources are packaged locally, follow VS Code themes, and send a finite validated action
vocabulary to the host; no arbitrary commands, paths or Git arguments cross that boundary.
ACP conversations remain separate task-bound panels and do not follow workspace-list selection.

## ACP agent configuration

Open **设置 → ACP Agent** or **ACP 配置说明与示例** in a task conversation for the inline setup
example. **配置 Agent** opens the matching VS Code setting; the guide stays collapsed until requested.

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

Open a task's **Agent 对话**, select its profile, and connect or send text. Merely opening the panel
does not launch the agent. The panel shows replies, tool activity and permission choices supplied by
the agent. Select an advertised authentication method if needed; terminal-based login must be completed
separately on the same host. There are no client-side file or terminal tool callbacks.

Connected conversations display the agent's session configuration selectors, such as model, mode or
reasoning level. Older agents can expose the legacy mode selector instead. Changes use only the
agent's offered values and wait for confirmation before another prompt can be sent. Available slash
commands can be inserted into the draft without sending it. Streamed thoughts, reported context usage
and cost, live notices and context-compaction updates are displayed when the agent provides them.
These reports do not change task state or run Git operations.
At most two common selectors stay visible, favoring model and mode categories. Other controls live
under **更多会话选项**; **任务与会话信息** holds the reported agent name, session title and usage.
Permission requests, live notices and connection errors remain directly visible.

**Warden: 发送选区到任务对话** appends selected editor text to a chosen task's draft; it does not send
the message. The excerpt includes its file or immutable review snapshot, line range and an unsaved
content label when applicable. The original editor and native review remain unchanged.

The panel retains its original task, workspace identity and repository. One extension window owns each
task's executable connection; other tasks can run independently. Conversation records persist outside
the source repository. After interruption, **继续会话** explicitly loads the original session when the
agent supports it. Otherwise **新建会话** starts again while retaining previous history. Warden never
silently resends a prompt whose outcome is uncertain.

**停止本轮** requests cancellation. **断开连接** closes Warden's connection and its agent process; an
active connection can expose this as **结束 Agent 进程**. These actions do not promise that every command
started by the agent has stopped. The agent owns its child commands and execution policies; coordinate
ongoing work before Git mutations. A turn ending never connects preview, commits, delivers or rebases.
Native review and its source/baseline pins remain unchanged.

The implementation is tested with an SDK-compatible child-agent fixture and packaged extension flows.
That does not establish support for an untested authenticated third-party agent. See
[Working with agents](https://github.com/xbghc/warden/blob/main/docs/agent.md) and the [ACP design](https://github.com/xbghc/warden/blob/main/docs/acp-design.md) for the supported boundary.

## Edit, review and run

Edit and save human code in primary. Agents edit task workspaces through their own tools. Both sides of native
`warden-review` diffs are read-only snapshots. **Warden: 复制审阅位置**, also available from the editor
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

**打开预览终端** sets a native terminal's cwd to preview. **运行预览** executes the optional
`warden.previewCommand` through VS Code Tasks there. Other user terminals, tasks and debug sessions
are not redirected. Use the displayed preview path or `${command:warden.previewPath}` where supported.
The preview page shows **运行预览** only when that command is configured, keeping **打开预览终端**
available in either case. Environment setup appears only for a configured script or a recorded result;
rerun is offered only while the script remains configured.

The engine combines repository-change hints, state-file notifications and periodic checks. Preview
publication still compares content hashes and debounces updates. A separate background-owner lease
prevents duplicate preview writers in multiple windows; writes retain the existing repository lock.
Closing the final Warden window stops synchronization. On reopening, journals and actual content are
checked before synchronization resumes. Existing preview programs are not restarted or killed by Warden.

## Environment setup

Open **设置** or **Warden: 编辑脚本配置**. Save a workspace initialization command and an optional
idempotent preview setup command. Initialization runs for every fresh allocation, including when an
internally available directory is used. Existing distinct create/reuse script settings are preserved
until the user explicitly saves a unified initialization command; differing legacy configuration is shown.

Preview setup runs on initialization, successful code updates, configuration changes and explicit retry.
Its success, output and exit code are separate from code synchronization. It receives `WARDEN_REPO`,
`WARDEN_WORKTREE`, `WARDEN_PREVIEW`, `WARDEN_DEVELOPMENT_BRANCH` and `WARDEN_HOOK_EVENT=preview`.
Workspace initialization receives the task context documented in [Working with agents](https://github.com/xbghc/warden/blob/main/docs/agent.md).
Scripts use the existing POSIX shell selection, ten-minute timeout and bounded output. Windows uses
Git for Windows' shell. Task descriptions never become executable script configuration.

## Delivery and history

History displays commit titles with expandable bodies. Starting a draft opens the comparison column;
each draft message is edited on demand and remains saved when its editor closes or its row moves.
The preview's full order is expandable, while conflicts and application consequences remain visible.

Review the intended version, then use the commit icon below its workspace title. VS Code opens its
top input box for the commit message; Enter submits and Escape cancels while preserving the draft.
Cancellation does not stage files. The submitted message and reviewed versions are fixed for that operation. Unrelated primary
edits block delivery. Other connections remain in the independent preview. Ordinary commit hooks and
signing run in primary; success records the exact commit and delivery association.

A hook failure retains the prepared contents. Fix the cause, reopen the retained staged diff, and retry.
A manually created commit must be reopened before recording it. Interrupted preparation has an explicit
recovery action. **结束已恢复的提交准备** remains available only after the original primary content has
been restored and verified; it does not reset or clean user files. Commit success and subsequent preview
failure are separate results.

**同步工作区** displays checks with their revisions and times. Select one, several or all, then request
rebase. Every result is displayed, including skipped and failed items. Checks never mutate active files;
Git cleanliness does not establish agent idleness.

**提交历史** offers a start commit through HEAD, bounded to the latest 100 entries. Edit messages or
reorder draft commits using drag-and-drop or move buttons. Preview replays in isolation and requires
an unchanged final tree. Apply explicitly against the original HEAD. Draft edits invalidate previews;
head changes preserve the stale draft for rebuilding. Stable delivery IDs survive rewritten SHAs.
Drafts and commit-message input persist in workspace state. There is no automatic push or history undo.

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

CI tests the Git engine on Windows, Linux and macOS, bundles their tested native modules in one VSIX,
and exercises that same artifact in minimum-supported and stable VS Code hosts on all three platforms.
The release workflow publishes the tested bytes through the existing `vscode-marketplace` Entra
federated identity. Manual runs only verify Marketplace authentication. No local publication is performed.
The existing publisher Contributor permission and GitHub environment identity configuration remain in use.
