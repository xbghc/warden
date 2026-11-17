# Warden

A VS Code workbench for developing one requirement on a **base branch**, with independent
task workspaces, native read-only review and a work folder that combines them for testing.
Development currently prioritizes connecting changes from multiple workspaces and testing them together.
Warden supplies the workspaces and Git operations; you choose and run your own coding tools.
Agent integrations need messaging and task-workspace binding; ACP is the current implementation.

## Install

Install **Warden Workspace Review** (`xbghc.warden`) in VS Code and open the primary directory.
Configure an agent through **Warden: Configure ACP**. Warden connects automatically at startup and
after configuration changes. Once connected, choose **Warden: Select Base Branch**, then
**Open Work Folder**: Warden creates `<primary>-work` and opens it. You work in that window;
primary only carries commits to and from the remote. Unavailable agents
keep workspace controls hidden, with configuration and recovery in Settings.
Only explicitly selected branches are tracked. Other branches stay quiet; switching back restores saved work.
For custom agents, use **Custom Agent Example** in Settings or the [configuration examples](docs/vscode.md#custom-agent-examples).
Git must be available in the workspace environment. The extension
requires VS Code 1.106 or newer and runs in desktop VS Code, Remote SSH, WSL and Dev Containers. It requires Workspace Trust.
There is no Warden server, browser application or CLI to start, and no separate Node installation
is needed to use the extension.

To build a local VSIX:

```sh
pnpm install
pnpm package:vscode
code --install-extension packages/vscode/warden-0.27.1.vsix
```

## Development workflow

1. **Add a task.** Enter a title; Warden automatically assigns its workspace and branch and runs any
   configured initialization script. A task is just its title; keep tasks small. Dragging tasks changes plan order only.
2. **Develop.** Open Task Chat in the auxiliary sidebar, expand it into an editor when needed, or use external tools in its workspace. The same task
   keeps its workspace across multiple deliveries.
3. **Connect to the work folder.** Use each task's connection action. The base branch commit and
   connected task changes are composed into the work folder, where you edit, run tests and dev servers.
   Your own edits there are kept across updates. Tasks sit directly in the sidebar; work folder
   commands use its menu, and synchronization stays in the status bar.
4. **Review and commit.** Open task files in native read-only diffs. Use the workspace commit icon, enter a message in
   VS Code’s top input box and submit the reviewed increment with ordinary Git hooks and signing.
   Saved workspace edits can be squashed directly; no task-branch commit is required.
   Your own work folder edits appear in the native Source Control view; **Commit Work Folder to Base Branch**
   commits them the same way.
5. **Synchronize.** **Pull Base Branch** fast-forwards primary from its remote; fetch and push with
   Git in primary. Explicitly rebase selected workspaces when needed. Use VS Code’s native
   Source Control Graph to inspect base-branch commit history.

Edit your own code in the work folder; agents edit theirs in task workspaces and make every change to it.
A failed connection leaves the work folder unchanged; a failed commit preserves recoverable content.
No readiness declarations, task-completion checkboxes or agent-process inference are required.
Use **Delete Task…** to discard a task after confirmation. It releases the workspace without a
backup, normally retaining its directory and ignored environment files for later reuse.

## Keyboard

Use the Command Palette for `Warden` actions. In a native review document, **Ctrl+Alt+C**
(**Cmd+Alt+C** on macOS) copies the original relative file location or selected line range.
All normal VS Code diff navigation and accessibility features remain available.

## Documentation

| Guide | Contents |
| --- | --- |
| [VS Code](docs/vscode.md) | Native navigation, forms, work folder runtime, scripts and migration |
| [Workflow](docs/workflow.md) | Product responsibilities and Git operation semantics |
| [Terminology](docs/terminology.md) | Canonical names, operation directions and status vocabulary |
| [Interaction design](docs/design.md) | Interaction contract and desktop adaptation |
| [Reviewing](docs/reviewing.md) | Immutable comparisons and delivery versions |
| [Working with agents](docs/agent.md) | Agent integration contract, ACP setup and external tools |
| [Workspaces and tasks](docs/worktrees.md) | Storage isolation, delivery and synchronization |
| [Platform](docs/environment.md) | Local and remote workspace environments |
| [State and security](docs/internals.md) | Persistence, locks and validated Git operations |
| [Development](docs/development.md) | Build, test and release the extension |

## License

MIT
