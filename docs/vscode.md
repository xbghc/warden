# VS Code

The Marketplace display name is **Warden Workspace Review**; the extension ID remains `xbghc.warden`.
The extension is the product entry point. It invokes the typed `@warden/engine` API directly, without
HTTP, a listening port, a browser server or an installed Warden CLI.

## Install from source

```sh
pnpm install
pnpm build:native
pnpm package:vscode
code --install-extension packages/vscode/warden-0.19.1.vsix
```

Open the primary directory and choose **Warden: 选择主开发分支**. The branch must be checked out in
primary. In a multi-root window, **Warden: 选择仓库** selects one repository; the selection is remembered.
Git and user-script dependencies must exist where the workspace lives. Workspace Trust is required;
browser-only virtual filesystems are unsupported. SSH, WSL and containers use the workspace extension host.

## Workbench

Before configuration, the sidebar shows only the next setup action: **选择仓库**, then
**选择主开发分支**. The task pane, preview status and operational navigation appear after branch
selection. Opening a workflow page early shows the same setup action instead of empty controls.

The Warden navigation contains preview, history, the ordered plan, synchronization and settings.
Task rows expand to the complete changed-file list. Selecting a task opens its current-task form and,
when available, its first native diff. Task connection actions remain on the task rows. Drag-and-drop
changes plan order only; the context menu also offers a keyboard-accessible move action.
Rows show at most two status facts, with full context in the tooltip. History starts collapsed.
Visible forms retain scoped errors; native notifications report errors in hidden forms.

The current-task form provides multiline notes, workspace creation, script results, multiline commit
messages and delivery recovery. Every workspace creation produces a fresh logical workspace with a
new task branch. The optional executor name is a label. Copying a task brief writes context to the
clipboard; the user can paste it into an ACP task conversation or an external tool. Physical slot reuse
is internal: users do not select or adopt an old workspace.
The optional executor label and compatibility clone option are available under workspace options.
The task's more-actions menu contains **复制路径** and **复制任务说明**; the edit icon opens its notes.
Existing task associations and
delivery records are preserved on upgrade; delivery never recycles another active task's workspace.

Preview, history, batch rebase and settings open as editor-area webviews. Their resources are
packaged locally, use VS Code theme colors, and send a finite validated action vocabulary to the host.
Git operations do not require editing a JSON draft. Command Palette entry points remain available.
ACP conversations open in separate task-bound panels and keep their original repository when the
workbench selection changes.

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
[Working with agents](agent.md) and the [ACP design](acp-design.md) for the supported boundary.

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
Workspace initialization receives the task context documented in [Working with agents](agent.md).
Scripts use the existing POSIX shell selection, ten-minute timeout and bounded output. Windows uses
Git for Windows' shell. Task descriptions never become executable script configuration.

## Delivery and history

History displays commit titles with expandable bodies. Starting a draft opens the comparison column;
each draft message is edited on demand and remains saved when its editor closes or its row moves.
The preview's full order is expandable, while conflicts and application consequences remain visible.

Enter a commit message in **当前任务**, review the intended version, then submit to the named primary
branch. The submitted message and reviewed versions are fixed for that operation. Unrelated primary
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
