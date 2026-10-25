# ACP integration in the VS Code extension

This is the adopted scope for Warden's ACP client. It extends the
[workflow contract](workflow.md) with user-operated task conversations. VS Code remains the only
product entry point; native Git review and delivery keep their existing rules.

## Responsibility boundary

Warden connects to a configured ACP agent or adapter over stdio using the official SDK's stable
protocol v1 API. The supported agents execute their own tools: they read and write files, run
commands, manage child processes and enforce their own execution policies.

Warden owns the agent process that carries its stdio connection, session routing, text prompts,
streamed updates, tool-activity display and permission answers. It does not advertise or implement
ACP client filesystem or terminal capabilities. There are no `fs/read_text_file`,
`fs/write_text_file` or `terminal/*` client handlers, Warden shell runner, agent sandbox or shared
agent-execution guard. An agent that requires those client capabilities is outside this version's
scope. Displaying a reported tool call does not execute it in Warden.

The task workspace is the process and session cwd. This supplies project context; it does not
confine a local agent's filesystem or process privileges. Agent permissions and execution policies
remain the agent's responsibility. Existing workspace initialization hooks and user-run preview
terminals are separate facilities, not ACP tool implementations.

## Profiles and authentication

`warden.acpAgents` is an array of `{ id, label, command, args, env? }` profiles configured in VS Code
User settings, or Remote User settings when the extension runs in SSH, WSL or a container. Workspace
and folder settings cannot supply executable profiles. The command must be available on the
workspace extension host. An executable and argument array are launched directly; task text and
agent replies never become executable configuration.

Profiles may describe a native ACP agent or an adapter. There is no vendor-specific SDK, bundled
agent, automatic installation or claim that an arbitrary coding CLI supports ACP. The agent's own
login and inherited environment remain available; optional profile environment overrides are
ordinary user configuration. Executable configuration and credentials are not sent to the webview
or stored in conversation history.

A user can select an authentication method advertised by the agent. Agents requiring an interactive
terminal login should be authenticated separately on the same host, using their documented login
command. Warden supplies no ACP terminal-auth facility. Authentication failure remains visible and
never triggers an automatic prompt retry.

## Task-bound conversations

Each panel belongs to one repository, task allocation and workspace identity. It retains the
original repository Engine; selecting another task or repository does not retarget the panel,
its draft, permission answers or its review action. An executor label is still only a label.

Opening a panel shows saved history without launching an agent. An explicit connect or send starts
the configured process, negotiates capabilities and creates the session. One executable connection
is allowed per task; separate tasks can have separate conversations. Each connection accepts one
prompt at a time while other tasks, diff review and preview remain usable.

The first version includes text prompts, streamed agent text, reported tool activity, user permission
requests, authentication, cancellation, disconnect, new sessions and supported session loading.
It does not automatically attach editor buffers, diagnostics, primary code or preview output.
Users can paste chosen context or use **Warden: 发送选区到任务对话** to append selected editor text to
the task's draft without sending it. The excerpt identifies its file or immutable review snapshot,
line range and any unsaved content. Rich context attachments, MCP forwarding
and client tool execution are outside this scope.

Drafts belong to the task panel independently of the agent transcript. Host append/clear versions
and acknowledged local edit revisions preserve selections across delayed messages and edits across
new conversations. Reopened panels receive the current draft and subsequent completion acknowledgements.
Sending from a panel that has not yet received appended context requires reviewing the updated draft first.
A newer local edit can be sent across a delayed acknowledgement that only clears the previous draft;
it cannot bypass unseen appended context. Sending stays unavailable until the completed transcript
is persisted and its draft acknowledgement is settled, including when a panel is reopened mid-turn.

Permission requests show the agent's supplied description and choices. Warden returns only the
selected option identifier or the protocol's cancelled outcome. It does not invent approval options
or add a global automatic approval policy. A late click cannot answer a request from an old
connection, another panel or another window.

The webview receives a finite, validated action vocabulary. Repository/session identity comes from
the host-owned panel binding, not arbitrary message fields. Agent content is displayed as text;
it cannot invoke a VS Code command or supply executable profile settings.

## Ownership, cancellation and recovery

A cross-window owner claim prevents two extension hosts from opening executable connections for
the same task. It protects connection ownership only: it is not a lock on task files, agent tools,
Git delivery or rebase. A live owner cannot be displaced merely because its timestamp is old.
Another window can inspect saved history and ordinary Git state without taking that connection.

**停止本轮** sends `session/cancel` and cancels pending permission requests. Warden continues to
handle the original prompt response. **断开连接** closes the owned connection and its agent process;
an active connection may expose this as **结束 Agent 进程**. Neither a cancelled response, a completed
prompt nor an exited stdio process proves that all agent-started background commands have stopped.
Warden does not supervise those commands or kill unrelated terminals and preview servers.
Stopping never resets, cleans or rolls back task files.

Session metadata and conversation records are stored outside the source repository and bound to
the original task/workspace/profile. A reload or connection loss preserves the last known record
and marks uncertain work accordingly. It does not automatically relaunch, reconnect or resend a
possibly delivered prompt.
Record replacement remains atomic while bounded retries tolerate brief filesystem contention.
If replacement keeps failing, the previous record is retained and the save error remains visible.

On explicit **继续会话**, revalidate the binding and profile. If the same agent supports
`session/load`, load its saved session and treat replayed updates as display history, not tool
execution or new prompts. Preserve the prior local record when loading fails. If loading is
unsupported, offer **新建会话** while retaining the previous record; local transcript storage is not
a promise of restored model state. Changing agents likewise starts an explicit new conversation.

## Git and preview remain user-operated

ACP activity does not approve or complete a task. A prompt ending, permission being granted or an
agent reporting success never connects preview, commits source changes, delivers to primary,
rebases a workspace or retries a failed operation automatically.

Users coordinate their agent's activity before requesting mutations. Warden does not infer
idleness from clean Git status or cancellation and adds no agent-idle declaration. Existing Git
operation locks, workspace identity checks and source/HEAD/index checks remain in force. Delivery
still requires a clean committed source and complete review of the pinned version; changed source
or baseline versions require fresh review. Connection previews continue to observe live content.

A merge, cherry-pick or rebase conflict does not block conversation with the agent working on that
task. A detached rebase is accepted only when its private Git metadata identifies the original task
branch; replacement workspaces and unrelated branches still invalidate the binding.

## Implementation and verification

| Layer | Responsibility |
| --- | --- |
| `packages/vscode/src/acp` | Profile validation, stdio/session lifecycle, task binding, connection ownership and external records |
| `packages/shared/src/acp.ts` | Conversation models and validated panel actions |
| `packages/webview/src/acp.tsx` | Task conversation, tool activity, permission choices and session controls |
| Existing Engine and native review | Repository operations, preview composition and immutable delivery review |

Tests use an SDK-compatible child-agent fixture that performs its own file operations and reports
updates over ACP. They exercise capability negotiation without client tools, task routing,
permission/cancel behavior, connection ownership, interruption and explicit restoration. Packaged
extension-host and webview checks cover the actual shipped bridge and UI while retaining native
review, preview and delivery regression coverage.

These tests establish the implemented protocol and packaging behavior. They do not establish
compatibility with a third-party authenticated agent or every adapter. A vendor-specific support
claim requires a recorded test of that agent/version and its authentication, cancellation and
session-loading behavior; no particular vendor is required to use the generic profile mechanism.

## Protocol references

- [ACP roles and methods](https://agentclientprotocol.com/protocol/v1/overview)
- [Initialization and capabilities](https://agentclientprotocol.com/protocol/v1/initialization)
- [Session creation and loading](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Tool calls and permission options](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Prompt cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)
- [Authentication](https://agentclientprotocol.com/protocol/v1/authentication)
- [Stdio transport](https://agentclientprotocol.com/protocol/v1/transports)
