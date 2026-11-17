# Warden Workspace Review

Develop one requirement on a base branch with independent task workspaces, native read-only
review and a work folder for testing changes together.

Warden requires VS Code 1.106 or newer, Workspace Trust and Git in the workspace environment.
It runs in desktop VS Code, Remote SSH, WSL and Dev Containers.

## Get started

1. Install **Warden Workspace Review** (`xbghc.warden`) and open your primary repository folder.
2. Use **Configure ACP** in the Warden sidebar to open Settings and configure an agent.
3. Warden connects automatically. Once connected, choose **Warden: Select Base Branch**, using the
   branch checked out in the primary folder.
4. Choose **Open Work Folder**. Warden creates `<primary>-work` and opens it; tasks, review and
   chats live in that window. The primary folder only carries commits to and from the remote.

In a multi-root window, use **Warden: Select Repository** after connecting.
Warden connects at startup and after profile changes, keeps the connection open, and cleans up its
owned processes on shutdown. Connection errors, authentication and reconnect controls live in Settings.
For a custom agent, open **Custom Agent Example** in Settings for a bundled, commented JSON template.
Named objects match the entries inside Zed and JetBrains `agent_servers`; existing arrays remain supported.
See the [configuration examples](https://github.com/xbghc/warden/blob/main/docs/vscode.md#custom-agent-examples).

## Work on a requirement

- **Add a task.** Warden automatically allocates its workspace and branch. Rename and order
  tasks in the native workbench tree.
- **Develop.** Open Task Chat in the Secondary Side Bar, expand it into an editor when needed,
  or use external tools in the task workspace. Conversations remain bound to their task.
- **Connect to the work folder.** Compose the base branch commit and connected task changes in the
  work folder. Edit, run tests and development servers there; your own edits are kept across updates.
  Tasks are top-level sidebar items; work folder commands use the heading menu and status uses the status bar.
- **Review and commit.** Inspect native read-only diffs, then commit the reviewed increment to
  the base branch with ordinary Git hooks and signing. The task workspace stays available.
  Review your own work folder edits in Source Control and use **Commit Work Folder to Base Branch**.
- **Pull and rebase when needed.** **Pull Base Branch** fast-forwards the primary folder. Review synchronization checks and explicitly request rebase for the
  selected workspaces. Browse base-branch history with VS Code's native Source Control Graph.

Your edits belong in the work folder; agent edits belong in task workspaces. Task order,
work folder connections and review selection are independent.

## Guides

- [VS Code guide](https://github.com/xbghc/warden/blob/main/docs/vscode.md): setup, commands,
  work folder scripts, recovery and existing data.
- [Working with agents](https://github.com/xbghc/warden/blob/main/docs/agent.md): integration
  requirements, ACP configuration and task conversations.
- [Workflow](https://github.com/xbghc/warden/blob/main/docs/workflow.md): review, commits,
  work folder and rebase semantics.
- [Development](https://github.com/xbghc/warden/blob/main/docs/development.md): build a local
  VSIX, debug the extension and run verification.

## License

MIT
