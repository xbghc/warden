# Working with agents

Warden creates task workspaces and connects task messages to agent tools. An integration may use ACP
or another supported interface, and the agent may be managed by Warden or by an external application.
The product depends on messaging and workspace binding, not on a particular protocol or process owner.
Warden does not supply the agent's file or command tools.

Work happens in the assigned task worktree. The user runs tests in the preview directory and reviews
changes before squash. Warden does not require an agent test command, structured delivery report or
readiness signal.

Default task workspaces are numbered directories beside primary and share Warden's external Git
repository with the preview. Each workspace has its own files, HEAD and index; agent edits and
commits belong only in the assigned task workspace. The user edits primary and runs the combined
code in preview. Ordinary agent commits retain their Git hooks and signing; Warden's temporary
composition commands do not change that configuration. Independent clones remain available for
tools that cannot use linked worktrees.

## Minimum integration contract

An agent integration must provide two capabilities:

- Create or attach to an identified session in the task workspace supplied by Warden. The integration
  must set or verify that directory through the tool's interface; mentioning a path in a prompt is
  insufficient. Changing the selected task must not change an existing session's directory.
- Send user messages to that session and report submission success or failure. A connection failure
  with an uncertain outcome must remain visible and must not trigger an automatic resend.

Keep the binding between repository, task allocation, workspace and agent session. Validate it before
sending; a replaced workspace requires a new explicit binding. The execution host must have access to
the assigned workspace. A working directory supplies context, not filesystem confinement.

Warden need not own the agent process, authentication, model selection, transcript rendering or tool
approvals. An external application may own these. Streaming replies, cancellation, session restoration
and other controls depend on the integration; expose only capabilities it actually supports. Closing
a Warden view must not terminate an externally owned process. A reply ending never initiates Git or
preview operations.

## Current implementation

ACP is the currently implemented integration. This does not yet provide a direct Codex CLI,
OpenCode HTTP or VS Code Agent Host integration. Existing `warden.acpAgents` settings and saved ACP
conversations retain their format. Other integrations must satisfy the minimum contract above.

## ACP task conversations

**Configure Agent** offers Codex and OpenCode presets. Select one, confirm its executable on the
workspace host and press Enter to save. Install the `codex-acp` adapter for Codex; OpenCode uses its
native `acp` subcommand. **Custom Agent / Edit Settings** retains direct configuration for other agents
and customized arguments or environment variables. Existing profiles are preserved, and choosing an
already configured preset opens its settings. Cancelling either input changes nothing.

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

**Stop Turn** requests cancellation; **Disconnect** closes Warden's agent connection and process. Neither
proves that all agent-started background commands have stopped. The agent owns those commands and its
execution policies. Coordinate ongoing work before delivery or rebase; Warden adds no execution guard
or agent-idle declaration and retains its existing Git version checks.

Conversation records persist outside the source repository. After reload or interruption, reconnect
explicitly with **Resume Session** when the agent supports loading its saved session. Otherwise use
**New Session**, retaining the previous record. Warden never silently resends an uncertain prompt or
claims that saved text restores the agent's model state. A completed turn does not connect preview,
commit, deliver or rebase. See the [ACP boundary](acp-design.md) for ownership and recovery details.

## Task briefs

Add and order small tasks in the left navigation. Each new task receives a workspace automatically; copy
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
