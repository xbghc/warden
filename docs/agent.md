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

The workbench prerequisite is a verified integration capable of messaging and workspace binding.
Its check must use the integration's supported interface, send no work prompt and create no Warden
task. Installation, a saved profile or opening an application's chat window does not establish those
capabilities. Actual task-session binding is checked when the task is opened or a message is sent.

## Current implementation

ACP is the currently implemented integration. Its setup, availability check and task conversation
are described below. This does not yet provide a direct Codex CLI, OpenCode HTTP or VS Code Agent Host
integration. Existing `warden.acpAgents` settings and saved ACP conversations retain their format.
The workbench availability model is protocol-independent; a further integration must satisfy the
same minimum contract before it can unlock the workbench without ACP.

Users may also use generic [workspace hooks](worktrees.md#workspace-hooks), copy task briefs or open
the assigned directory in external tools. Those manual actions do not establish an integrated message
channel and are not evidence that an agent is available.

## ACP task conversations

Configure an ACP profile once. Warden connects automatically at startup and after configuration
changes, without a separate connection-check page. The last successfully selected profile is reused
when available; otherwise Warden uses the first configured profile. Saving a new preset selects it.
Branch, task, workspace and preview controls appear once ACP initialization and an empty session
succeed. Settings show connection progress, errors, authentication and **Connect ACP** / **Reconnect ACP**.

The workbench connection stays open. Startup sends no prompt and creates no Warden task. Disconnect,
failure, configuration replacement and shutdown clean up its owned process. Shutdown also closes
active task connections and saves their records; it never automatically resends an uncertain prompt.
An unavailable connection keeps workspaces hidden, while existing chats retain their stop controls.

With no ACP server configured, the sidebar shows only **Configure ACP**. This native button opens
the shared **Warden · Settings** panel; it does not open a picker, save settings or start an additional connection.
The panel contains configuration, connection status and recovery, and the setup guide. Other workflow surfaces
link to the same panel, and Task Chat does not duplicate agent setup.

In Settings, **Choose Agent Preset** offers Codex and OpenCode. Select one, confirm its executable on
the workspace host and press Enter to save. Install the `codex-acp` adapter for Codex; OpenCode uses its
native `acp` subcommand. **Custom Agent / Edit Settings** retains direct configuration for other agents
and customized arguments or environment variables. Each preset has one stable profile ID. Existing
profiles are preserved, and choosing an already configured preset opens its settings without adding
another copy. Cancelling either input changes nothing.

Open the task's **Chat with Agent** in the Secondary Side Bar and connect or send a message. New
conversations use the agent connected by the workbench; existing conversations retain their original
agent. Agent configuration and the ACP setup guide belong to workbench setup and settings.
Mode and model selectors sit below the message text, with additional session options and commands
available on demand. Enter sends; Shift+Enter inserts a new line. Opening a chat alone does not launch a process. **Switch Task Chat** explicitly opens
another task's conversation, preserving drafts and reading positions. **Open Chat in Editor** expands
the same chat, and **Move Chat to Side Bar** returns it. Each conversation stays attached to its original
task workspace and repository when the selected task or repository changes. Separate tasks can have separate sessions;
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

Add and order small tasks in the left navigation. Warden automatically assigns each task a workspace; copy
its task brief and paste it into the task conversation or an external tool. The brief includes the
task title, goal, acceptance notes, assignment, workspace path, base branch and instructions.

Copying a brief only writes text to the clipboard. It does not launch an agent or update review state.
Review feedback can be sent in the task conversation or through external tools. In a native Warden
diff, select a line or range and run **Warden: Copy Review Location** (`Ctrl+Alt+C`, macOS `Cmd+Alt+C`).

Inline comments, comment exports and the `warden feedback` / `warden reply` commands have been
removed. Historical review fields in existing state files are retained as opaque data on unrelated
writes; they are no longer displayed, reanchored, replied to or copied into briefs.

Existing TODO text and historical metadata migrate without inventing completed commits. Old
checked items are archived; notes on unrelated branches remain available for explicit import.
See [Workspaces and tasks](worktrees.md#development-workflow).
