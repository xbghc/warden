# VS Code

Warden now has a desktop / remote workspace extension. ACP integration is deferred. The browser
and CLI remain available and share the same repository state and mutation lock with the extension.
No server port or browser is needed by the extension.

## Install from source

```sh
pnpm install
pnpm package:vscode
code --install-extension packages/vscode/warden-0.17.2.vsix
```

Open the primary directory in VS Code, open the Warden activity view and run **Warden: 选择主开发分支**.
For a multi-root window, use **Warden: 选择仓库** to choose the active repository. The selected
branch must be checked out in the primary directory. Remote SSH, WSL and containers execute the
backend in the workspace extension host; Git and the configured scripts must be available there.
Browser-only virtual filesystems are unsupported. Workspace Trust is required.

## Edit, review and run

Edit and save human code in the primary directory. Agents work in numbered task workspaces.
Expand a task to see its undelivered file list; opening a file uses VS Code's native diff editor.
Both sides are read-only review documents. Users must review the entire intended delivery; Warden
does not track read markers or review progress.
Clean task diffs pin the source commit, delivery boundary and primary HEAD; their titles identify
the source version. An open diff is immutable. A version change blocks delivery until a task diff
is reopened; opening the newer version closes that task’s older diff tabs and starts a new complete
review. Background refresh alone does not advance the review. Binary changes list the pinned
version for review with external tools. Live uncommitted content remains readable, but must be
committed and reopened for delivery review.

Connect tasks using their context menu. The preview is an independent, persistent repository in
Warden's external data directory. Its path is displayed by the preview item and can be copied with
**Warden: 复制预览路径**. It is not added as a workspace root or mixed into the primary repository's Git
changes. Preview files are generated runtime inputs: edit the primary directory or the responsible
agent workspace, not the preview directory. Unexpected edits there stop publication and are preserved.

**Warden: 打开预览终端** opens a terminal with its cwd set to the preview. **Warden: 运行预览** executes the
optional `warden.previewCommand` as a VS Code task in that same directory. Existing terminals and
arbitrary user task/debug configurations are not silently redirected: use the displayed preview path
as their cwd/program root, or `${command:warden.previewPath}` where command-variable substitution is
supported. Terminal/error paths refer to the runtime files; they must not be used to edit preview code.

The extension refreshes while its workspace host is running. Closing the window stops its refresh
loop; an independently running Warden CLI server can keep the same preview synchronized. Existing
user-run programs are not restarted or killed by connection changes. Code changes are observed by
content hash, debounced, composed together and then applied to the stable runtime directory. The
status bar and each connected task distinguish pending, updating, synced, conflict and error states.
A conflict keeps the last coherent runtime content. This version has no preview-versus-baseline diff
or attribution view and does not infer agent idleness or enforce isolated-delivery testing.

## Environment setup

Run **Warden: 编辑脚本配置**, edit the JSON and run **Warden: 保存脚本配置** with that document active:

```json
{
  "wardenRepository": "/absolute/path/to/primary",
  "hooks": { "create": "", "reuse": "" },
  "previewSetup": "./scripts/setup-preview.sh"
}
```

Scripts are explicitly saved by the user; task metadata never supplies executable setup commands.
The preview setup command runs on initialization, after published code changes, and when its
configuration changes. It is serialized with preview publication. Edits arriving while it runs are
captured in the next update. Keep it idempotent; it decides whether dependencies need installing.
Dependencies and generated files should be ignored by Git. A script that changes preview source
files makes the preview stale; Warden never copies those edits back to primary.

The command receives `WARDEN_REPO`, `WARDEN_WORKTREE`, `WARDEN_PREVIEW`,
`WARDEN_DEVELOPMENT_BRANCH` and `WARDEN_HOOK_EVENT=preview`. It runs through the same POSIX shell
selection as workspace hooks (Git for Windows supplies `sh.exe`), with a ten-minute timeout and
bounded output. **Warden: 重跑预览 setup** retries manually and opens its output. Failure is visible
separately from whether code was synchronized. Ignored dependencies and caches persist across
updates, disconnects and extension restarts.

## Delivery and history

**交付提交** asks for a message first, then prepares and commits only the reviewed undelivered
increment in one operation, with ordinary Git hooks/signing in primary. Genuine primary edits must be handled by
the user first; they are not staged into the task's commit. Other connections remain in preview.
Canceling message entry leaves Git untouched. After a hook failure, correct the cause, reopen
the retained staged diff and retry against that reviewed fingerprint. A manual commit must also
be reopened for review before recording its exact SHA. Interrupted preparation can be retried
through **交付提交**; review its recovered staged contents before committing. **结束已恢复的提交准备** is only available after the
user has restored the preparation's original primary content, preserving the existing recovery checks.

Use **检查并 rebase 工作区** to inspect and select one, several or all workspaces. Rebase remains an
explicit operation. **编辑提交历史** creates an untitled JSON draft for a selected linear range; reorder
its `commits` or edit messages, then run **预览并应用历史编排**. The backend verifies unchanged final file
content and the extension shows the resulting order/messages before applying. Nothing is pushed.

Older primary-directory previews are migrated only when their saved ownership record still matches
primary. Unexpected primary edits block migration with an actionable error; no reset/clean is used.
The state schema remains version 1 so older metadata is retained, but do not run an old Warden
version alongside a new independent preview.
