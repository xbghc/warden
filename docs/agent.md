# Working with agents

Warden creates task workspaces and exposes generic [workspace hooks](worktrees.md#workspace-hooks).
Users can interact with self-executing ACP agents through a task conversation in VS Code, or keep
using their own external tools and scripts. Warden does not supply the agent's file or command tools.

Work happens in the assigned task worktree. The user runs tests in the preview directory and reviews
changes before squash. Warden does not require an agent test command, structured delivery report or
readiness signal.

Default task workspaces are numbered directories beside primary and share Warden's external Git
repository with the preview. Each workspace has its own files, HEAD and index; agent edits and
commits belong only in the assigned task workspace. The user edits primary and runs the combined
code in preview. Ordinary agent commits retain their Git hooks and signing; Warden's temporary
composition commands do not change that configuration. Independent clones remain available for
tools that cannot use linked worktrees.

## ACP task conversations

Open the task's **Agent 对话**, choose a configured agent and connect or send a message. Opening a
panel alone does not launch a process. Each panel stays attached to its original task workspace and
repository when the selected task or repository changes. Separate tasks can have separate sessions;
one window owns each task's executable connection.

Configure `warden.acpAgents` in VS Code User settings, or Remote User settings for the workspace host.
Profiles contain an executable, arguments and optional environment overrides. Use a native ACP agent
or adapter that executes its own tools; agents requiring Warden filesystem or terminal callbacks
are unsupported. See [VS Code configuration](vscode.md#acp-agent-configuration) for an example.

The panel accepts text prompts and displays streamed replies, reported tool activity and permission
choices supplied by the agent. Select an offered authentication method when needed, or complete the
agent's documented terminal login separately on the same host. Warden does not provide a login terminal
or interpret tool activity as instructions to execute a command itself.

**停止本轮** requests cancellation; **断开连接** closes Warden's agent connection and process. Neither
proves that all agent-started background commands have stopped. The agent owns those commands and its
execution policies. Coordinate ongoing work before delivery or rebase; Warden adds no execution guard
or agent-idle declaration and retains its existing Git version checks.

Conversation records persist outside the source repository. After reload or interruption, reconnect
explicitly with **继续会话** when the agent supports loading its saved session. Otherwise use
**新建会话**, retaining the previous record. Warden never silently resends an uncertain prompt or
claims that saved text restores the agent's model state. A completed turn does not connect preview,
commit, deliver or rebase. See the [ACP boundary](acp-design.md) for ownership and recovery details.

## Task briefs

Plan and order small changes in the left navigation. Allocate a workspace when needed, then copy
its task brief and paste it into the task conversation or an external tool. The brief includes the
task title, goal, acceptance notes, assignment, workspace path, development branch and instructions.

Copying a brief only writes text to the clipboard. It does not launch an agent or update review state.
Review feedback can be sent in the task conversation or through external tools. In a native Warden
diff, select a line or range and run **Warden: 复制审阅位置** (`Ctrl+Alt+C`, macOS `Cmd+Alt+C`).

Inline comments, comment exports and the `warden feedback` / `warden reply` commands have been
removed. Historical review fields in existing state files are retained as opaque data on unrelated
writes; they are no longer displayed, reanchored, replied to or copied into briefs.

Existing TODO text and historical metadata migrate without inventing completed commits. Old
checked items are archived; notes on unrelated branches remain available for explicit import.
See [Worktrees and tasks](worktrees.md#development-workflow).
