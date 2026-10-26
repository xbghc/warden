# Warden

A VS Code workbench for developing one requirement with independent task workspaces, native
read-only review, an isolated live preview, and clear commits on your **primary development branch**.
Warden supplies the workspaces and Git operations; you choose and run your own coding tools.

## Install

Install **Warden Workspace Review** (`xbghc.warden`) in VS Code, open the primary directory, and
choose **Warden: 选择主开发分支**. Git must be available in the workspace environment. The extension
runs in desktop VS Code, Remote SSH, WSL and Dev Containers. It requires Workspace Trust.
There is no Warden server, browser application or CLI to start, and no separate Node/Rust installation
is needed to use the extension.

To build a local VSIX:

```sh
pnpm install
pnpm build:native
pnpm package:vscode
code --install-extension packages/vscode/warden-0.19.2.vsix
```

## Development workflow

1. **Plan.** Add task titles and multiline notes in Warden. Dragging tasks changes plan order only.
2. **Create a workspace.** Every creation is a fresh logical workspace and branch. Warden manages
   physical directory allocation internally. Configure an optional initialization script; run
   agents with your own tools.
3. **Connect for preview.** Use each task's connection action. Saved primary content and connected
   task changes appear in a persistent independent preview directory for tests and dev servers.
4. **Review and commit.** Open task files in native read-only diffs. Enter a multiline message in
   the current-task view and submit the reviewed increment with ordinary Git hooks and signing.
5. **Synchronize or arrange history.** Explicitly rebase selected workspaces, or edit a history
   draft, preview it in isolation, then apply. Warden does not push rewritten history.

Edit human code in primary and agent code in task workspaces. Preview is generated runtime input.
A failed connection preserves the previous preview; a failed commit preserves recoverable content.
No readiness declarations, task-completion checkboxes or agent-process inference are required.

## Keyboard

Use the Command Palette for `Warden` actions. In a native review document, **Ctrl+Alt+C**
(**Cmd+Alt+C** on macOS) copies the original relative file location or selected line range.
All normal VS Code diff navigation and accessibility features remain available.

## Documentation

| Guide | Contents |
| --- | --- |
| [VS Code](docs/vscode.md) | Native navigation, forms, preview runtime, scripts and migration |
| [Workflow](docs/workflow.md) | Product responsibilities and Git operation semantics |
| [Interaction design](docs/design.md) | Interaction contract and desktop adaptation |
| [Reviewing](docs/reviewing.md) | Immutable comparisons and delivery versions |
| [Working with agents](docs/agent.md) | External tools and script context |
| [Worktrees and tasks](docs/worktrees.md) | Storage isolation, delivery and synchronization |
| [Platform](docs/environment.md) | Local and remote workspace environments |
| [State and security](docs/internals.md) | Persistence, locks and validated Git operations |
| [Development](docs/development.md) | Build, test and release the extension |

## License

MIT
