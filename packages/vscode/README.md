# VS Code

The Marketplace display name is **Warden Workspace Review**; the extension ID remains `xbghc.warden`.
The extension is the product entry point. It invokes the typed `@warden/engine` API directly, without
HTTP, a listening port, a browser server or an installed Warden CLI.

## Install from source

```sh
pnpm install
pnpm build:native
pnpm package:vscode
code --install-extension packages/vscode/warden-0.18.2.vsix
```

Open the primary directory and choose **Warden: 选择主开发分支**. The branch must be checked out in
primary. In a multi-root window, **Warden: 选择仓库** selects one repository; the selection is remembered.
Git and user-script dependencies must exist where the workspace lives. Workspace Trust is required;
browser-only virtual filesystems are unsupported. SSH, WSL and containers use the workspace extension host.

## Workbench

The Warden navigation contains preview, history, the ordered plan, synchronization and settings.
Task rows expand to the complete changed-file list. Selecting a task opens its current-task form and,
when available, its first native diff. Task connection actions remain on the task rows. Drag-and-drop
changes plan order only; the context menu also offers a keyboard-accessible move action.

The current-task form provides multiline notes, workspace creation, script results, multiline commit
messages and delivery recovery. Every workspace creation produces a fresh logical workspace with a
new task branch. The optional executor name is a label. Copying a task brief writes context to the
clipboard; agent execution remains in external tools. Physical slot reuse is internal: users do not select or adopt an old workspace.
The compatibility clone option is available under workspace options. Existing task associations and
delivery records are preserved on upgrade; delivery never recycles another active task's workspace.

Preview, history, batch rebase and script settings open as editor-area webviews. Their resources are
packaged locally, use VS Code theme colors, and send a finite validated action vocabulary to the host.
No operation requires editing a JSON draft. Command Palette entry points remain available.

## Edit, review and run

Edit and save human code in primary. External tools edit task workspaces. Both sides of native
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

The engine combines repository-change hints, state-file notifications and periodic checks. Preview
publication still compares content hashes and debounces updates. A separate background-owner lease
prevents duplicate preview writers in multiple windows; writes retain the existing repository lock.
Closing the final Warden window stops synchronization. On reopening, journals and actual content are
checked before synchronization resumes. Existing programs are not restarted or killed by Warden.

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
