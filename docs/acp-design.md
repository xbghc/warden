# ACP integration in the VS Code extension

This is the adopted scope for Warden's ACP integration, the currently implemented agent connection.
It implements the [minimum agent contract](agent.md#minimum-integration-contract); ACP and ownership
of the agent process are not requirements for other integrations. It extends the
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

For task conversations, the task workspace is the process and session cwd. This supplies project context; it does not
confine a local agent's filesystem or process privileges. Agent permissions and execution policies
remain the agent's responsibility. Existing workspace initialization hooks and user-run preview
terminals are separate facilities, not ACP tool implementations.

## Profiles and authentication

`warden.acpAgents` is an object mapping stable agent names to `{ command, args?, env?, label?, type? }`,
matching the custom stdio entries inside Zed and JetBrains `agent_servers`. Names identify saved
conversations; `label` optionally overrides the display name, and Zed's `type: "custom"` is accepted.
Other client-specific fields are rejected rather than silently ignored. Legacy arrays of
`{ id, label, command, args, env? }` remain supported; using each old ID as the object key retains
session bindings. Preset saves preserve the existing format; new settings use an object.
Profiles are configured in VS Code User settings, or Remote User settings when the extension runs in SSH, WSL or a container. Workspace
and folder settings cannot supply executable profiles. The command must be available on the
workspace extension host. An executable and argument array are launched directly; task text and
agent replies never become executable configuration.
The transport waits for successful process startup before sending its first ACP request. A missing
executable fails without writing to a pipe with no reader; conversation ownership is still released.

The workbench automatically connects at startup in a trusted workspace and after User or Remote User
profile changes. It uses the last successfully selected profile ID when still configured, otherwise
the first profile. Saving a new preset selects that profile for the automatic connection. Settings
changes are coalesced, the old connection is retired first, and startup never opens a profile picker.

Initialization launches the profile on the workspace host with the primary folder as cwd (or the first
workspace folder before repository selection), negotiates ACP and creates an empty `session/new`.
Once the primary directory is resolved, connection proceeds alongside repository observation rather
than waiting for its initial refresh or advisory rebase checks. Workflow navigation still requires
both repository readiness and a successful ACP session; repository loading cannot expose stale tasks.
It advertises no client filesystem or terminal tools, cancels startup permission requests and never
sends `session/prompt`. No Warden task, workspace allocation or conversation record is created. The
agent may retain its own empty session metadata. This connection stays alive after initialization;
branch and workspace controls become available automatically, with no manual check page.

An unexpected connection or process exit makes the workbench unavailable. Authentication-required
responses retain the connection and expose supported login methods in Settings; authentication remains
explicit. Errors stay in Settings with reconnect controls and do not trigger an automatic restart or
prompt retry. A provider may defer authentication or network validation until a prompt, so startup
cannot guarantee every later turn will succeed. Observed failures of the selected agent close the gate.

Disconnect, configuration changes and extension shutdown cancel pending attempts and retire the owned
stdio process with bounded termination. Late results cannot mark a replaced connection ready. Task
conversations keep their own process and session cwd in the assigned task workspace, independently
of this startup connection. Shutdown also closes those connections, flushes local conversation/draft
state and releases their claims. It does not supervise agent-owned child commands. Existing task data,
conversations and drafts remain available for explicit recovery. Availability is held in the current
window; only the selected profile ID is remembered, not a persistent success flag.

Workbench connections emit local [startup performance diagnostics](development.md#startup-performance)
for cleanup, process creation, initialization and session creation. Failed, timed-out, cancelled and
authentication-required attempts retain their own outcomes; replacement attempts have distinct IDs.
Records contain no profile commands, credentials, protocol payloads or raw errors and are never uploaded.

Both workbench and task connections also use the local [diagnostic log](development.md#diagnostic-logs).
Connection IDs distinguish retries and replacements; task, conversation, turn and operation IDs
correlate session creation/loading, requests, permission waits, cancellation, persistence and cleanup.
Debug records include request methods and durations, process IDs/exits, protocol capabilities and tool
status; Trace records update types without their text or payloads. Failures retain bounded, redacted
provider error details and recent stderr, including failures during automatic startup. Stderr buffering
handles credentials split across chunks and drops oversized lines whole. Routine logs never serialize
prompts, thoughts, tool input/output or executable configuration. Arbitrary agent error text may still
include project context. Output failures cannot change connection behavior or prompt results.

Workspace loading and pending connections, including the automatic connection scheduling delay,
never show **Configure ACP**. Once loading finishes, missing or invalid configuration, authentication,
failed connections and explicit disconnection expose the **Configure ACP** welcome button,
with no task rows, setup text or duplicate toolbar entry. It reveals the native Settings view stacked
below Workbench and expands, selects and focuses its ACP section, even after it was collapsed or hidden.
The two views use VS Code's own collapse, resize and keyboard controls. Other workflow
panels offer the same link; connection status, recovery, setup links and preset controls live in Settings.
Opening Settings does not change profiles or start an additional connection.

**Custom Agent Example** opens the bundled commented JSON template in a native text editor.
It covers named profiles, arguments, environment overrides and Windows/JavaScript launchers.
Opening the example does not copy it into user settings or launch a process.

In Settings, **Choose Agent Preset** opens a native picker with Codex, OpenCode and
**Custom Agent / Edit Settings**. Each preset has one stable profile ID.
Codex uses the `codex-acp` adapter; OpenCode uses `opencode` with `args: ["acp"]`. Choosing a preset
opens a native executable input; Enter appends it to User or Remote User settings, while Escape
leaves settings unchanged. The command can be a name on PATH or an absolute path on the workspace
host. Windows inputs use native executables; batch wrappers require an explicitly configured launcher.
Re-read profiles when saving to preserve edits made while the input was open. Existing preset IDs
open settings instead of being replaced or duplicated. Invalid settings go directly to repair and
are never replaced with defaults. Configuration remains available before repository or branch
selection. Task Chat does not duplicate the picker or ACP setup guide.

These are configuration templates, not bundled agents or verified vendor integrations. They do not
install software, choose models, change agent permissions or supply credentials. Saving a preset
starts the normal automatic connection.
See the upstream [Codex adapter](https://github.com/agentclientprotocol/codex-acp) and
[OpenCode ACP guide](https://docs.opencode.ai/docs/acp/) for installation and authentication.

Profiles may describe a native ACP agent or an adapter. There is no vendor-specific SDK, bundled
agent, automatic installation or claim that an arbitrary coding CLI supports ACP. The agent's own
login and inherited environment remain available; optional profile environment overrides are
ordinary user configuration. Executable configuration and credentials are not sent to the webview
or stored in conversation history.

An advertised authentication method does not mean login is required. Task Chat shows login choices
only after an explicit ACP authentication-required response on its live connection, not while opening
a session or after an unrelated error. **I Have Signed In — Reconnect** replaces that task connection
so the agent can read credentials saved externally. It retains the conversation and draft, resumes
the saved session when available and never sends a prompt or starts a new login flow. Other failures
offer **Reconnect** without implying that the user's login is missing.

A user can select an authentication method advertised by the agent. Agents requiring an interactive
terminal login should be authenticated separately on the same host, using their documented login
command. Warden supplies no ACP terminal-auth facility. Authentication failure remains visible and
never triggers an automatic prompt retry.

## Task-bound conversations

Each conversation belongs to one repository, task allocation and workspace identity. It retains the
original repository Engine; selecting another task or repository does not retarget its draft,
permission answers or review action. **Chat with Agent** opens the conversation in a shared Task Chat
view, contributed to the Secondary Side Bar (VS Code 1.106+). Explicit chat selection changes which
conversation the view presents. **Open Chat in Editor** and **Move Chat to Side Bar** transfer its one
editable surface without creating a session or process. Multiple tasks can have editor chats open.
Before switching or moving, the host requests and acknowledges the latest draft and reading position;
a failed capture leaves the current view available. Each mount receives a fresh routing token, and
queued messages from an old mount are ignored. Drafts and reading position belong
to the task allocation; changing presentation never transfers them to another task. An executor label is still only a label.

Opening a chat shows saved history and automatically prepares its agent connection. If a saved
session exists, resume it with `session/load`; otherwise create the first session with `session/new`.
Opening a chat sends no prompt. New conversations use the profile
verified in workbench setup, independent of settings order or an older saved view selection. Existing
records retain their original profile, including after the workbench agent changes. The host rejects
stale profile choices for new conversations. Repeated opens share a pending connection attempt or reuse
the active session, without delaying navigation. Sending after a disconnect also restores the session
before submitting the new message. One executable connection
is allowed per task; separate tasks can have separate conversations. Each connection accepts one
prompt at a time while other tasks, diff review and preview remain usable.

The client includes text prompts, streamed agent text and thoughts, reported tool activity, user
permission requests, authentication, cancellation, disconnect, new sessions and supported session loading.
It does not automatically attach editor buffers, diagnostics, primary code or preview output.
Users can paste chosen context or use **Warden: Add Selection to Task Chat** to append selected editor text to
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
New chats start with an empty composer. **Use Task Brief** or **Insert Task Brief** explicitly appends
the task's saved context without sending it. While a submitted draft is unchanged and its turn is
running, the composer displays an empty input for a follow-up; the host retains the original draft
until completion. A failed turn restores that text only if the user has not edited the draft. View
moves remap the submission revision so neither a sent draft nor newer typing is lost or resurrected.

Permission requests show the agent's supplied description and choices. Warden returns only the
selected option identifier or the protocol's cancelled outcome. It does not invent approval options
or add a global automatic approval policy. A late click cannot answer a request from an old
connection, another panel or another window.
Long agent-provided permission labels, including commands and paths without spaces, wrap inside
the available sidebar width. A single request reserves space for its complete choice list while
command context scrolls separately. Short windows use a compact follow-up input without clearing
its draft and temporarily hide session selectors that cannot change during a permission wait;
sending and Stop Turn retain their existing behavior. Multiple or unusually large requests
remain reachable by vertical scrolling, without clipping the authorization scope horizontally.
Only an `allow_once` choice uses the primary button style; persistent approvals remain secondary.
Agent-provided labels, ordering, IDs and authorization scope are unchanged.
When supplied, command, working-directory and justification fields appear as readable text before
the choices. Commands preserve line breaks and remain scrollable rather than being cut to two lines.
Raw request details remain available separately; presentation never changes the offered choices.
An additional JSON string layer around a command is decoded once for display, while shell escapes
and the original request remain available without interpretation or execution. A decoded command is
explicitly labeled as a preview, including its hover text, and the disclosure retains the original
request. No shell unescaping or recursive decoding is applied.

The webview receives a finite, validated action vocabulary. Repository/session identity comes from
the host-owned view binding, not arbitrary message fields. View-state messages contain only bounded
reading positions and profile IDs; they cannot change the binding or execute commands. Agent content
is stored as text and rendered with safe Markdown, including lists, tables and copyable code blocks.
Raw HTML is displayed as text; remote images are not loaded. HTTP(S) links open normally. Local
Markdown references use a finite `open-file` action, not a URI handler: the host validates the task
binding, resolves the real path inside that task workspace and rejects traversal, escaping symlinks,
binary or oversized files. Changed files open their native read-only diff; other text files open an
immutable read-only snapshot at the supplied line. Agent content cannot invoke a VS Code command or
supply executable profile settings. Consecutive completed tools and thoughts fold into compact groups;
running tools, failures and agent replies stay visible, and all recorded details remain accessible.

## Session controls and updates

The stable v1 connection supports `session/set_config_option` and the older `session/set_mode`.
Session creation and loading read the agent's initial selectors. When `configOptions` is present,
including an empty array, it takes precedence over `modes`. Select options preserve agent ordering
and grouped labels; boolean options are enabled through the corresponding initialization capability.
Selectors can expose models, modes, reasoning levels or other agent-defined settings without
provider-specific configuration. Only identifiers and values currently offered by the agent are accepted.
Warden waits for the agent's confirmed state rather than changing selectors optimistically. A
configuration change and a prompt cannot run concurrently in the same task conversation.

Task Chat keeps mode, model and reasoning effort (`thought_level`) selectors in one composer footer
row, in that order, followed by Send/Stop Turn. Unavailable categories are omitted; uncategorized
selectors remain accessible. Extra options use a header popover. Footer selectors and Send/Stop Turn
share one control height; labels shrink independently of their square chevrons and the fixed action.
Long values truncate without wrapping the footer and retain their full names on hover. Keyboard-accessible
picker menus open upward, stay within the viewport and show complete agent-provided names, groups and
descriptions. Selecting a value returns focus to the message input while confirmation is pending;
Escape closes a picker and restores its trigger focus without sending or changing the draft.
A pending configuration change or active turn closes an open picker; confirmed agent state remains the
source of displayed values. The header menu
contains task/session details and disconnect; executable profiles and setup instructions are absent.
Enter sends, Shift+Enter inserts a line, and Ctrl/Command+Enter remains supported. IME composition
never submits. The send control becomes Stop Turn during an active turn.

The layout draws on VS Code's [shared chat control sizing](https://github.com/microsoft/vscode/blob/9be315fcbf470a87d94d95a04e2f916d1fae5765/src/vs/workbench/contrib/chat/browser/widget/media/chat.css)
and [responsive picker layout](https://github.com/microsoft/vscode/blob/9be315fcbf470a87d94d95a04e2f916d1fae5765/src/vs/workbench/contrib/chat/browser/widget/input/chatInputPickerResponsiveLayout.ts).
Warden implements its footer with themed webview primitives and keeps provider-confirmed ACP state.

`config_option_update` replaces the entire configuration list. Mode, command, usage and session-title
updates are also accepted between turns. These controls are live connection state: disconnecting
clears them, and restoration obtains fresh state from the agent. An agent's session title
does not rename the Warden task or change its binding.

`available_commands_update` supplies slash commands and optional input hints. There is no permanent
command button. Typing `/` as the first message token opens a filtered list above the composer,
without moving focus out of the input. Arrow keys change the selection; Enter or Tab completes it,
Escape dismisses it, and Shift+Enter still inserts a newline. Composition keystrokes do not complete
or send. Paths in prose and arguments do not open the list. Choosing a command replaces only the
command token and retains existing arguments and other unsent text. The user still sends the prompt explicitly;
Warden never executes command text as a shell command.

Agent-provided thoughts are displayed separately from replies. Usage updates show the reported context
window and optional cumulative cost. These values describe agent reports, not local metering or
execution state. Live notices are displayed without adding them to saved history. Context compaction
updates keep one timeline entry per compaction ID, support replacement and streamed summaries, and
preserve summary/error patch state in saved history. Unknown extension metadata is ignored.

Tool activity also accepts the ACP v1 `terminal_output_delta` and `terminal_output` conventions:
append bounded output chunks only when their terminal ID matches the enclosing tool call, retain
the reported exit code or signal, and preserve the text through conversation saves and session replay.
Status-only and content updates do not erase output. Unknown or malformed metadata is ignored.
Reported exit codes and signals are stored as separate validated fields and shown beside the tool's
reported status in its collapsed row. A nonzero code does not change that status, and output text is
never parsed to invent an exit result. The generic terminal placeholder disappears when real output
arrives; an identical sentence supplied as ordinary agent output is preserved.
This is a passive transcript of agent-owned commands; Warden provides no terminal execution or control.
After a turn ends or saved history is restored, unfinished activities show **Outcome Unknown**
without a running spinner. Their last reported status and output remain stored. A later turn or
session replay can supply a final status. Cancellation does not establish process termination.

The client advertises support for notices, context compaction, boolean configuration options and
`_meta.terminal_output_delta` display updates.
It continues to advertise no filesystem or terminal capabilities. Rich attachments, MCP forwarding,
global agent-session management and experimental v2 APIs are outside this integration.

## Ownership, cancellation and recovery

A cross-window owner claim prevents two extension hosts from opening executable connections for
the same task. It protects connection ownership only: it is not a lock on task files, agent tools,
Git delivery or rebase. A live owner cannot be displaced merely because its timestamp is old.
Another window can inspect saved history and ordinary Git state without taking that connection.

Confirmed task deletion closes this window's task connection before releasing its workspace.
Another window's live owner must disconnect there first. Deletion publishes its reservation under
the existing connection metadata lock; connection claims validate the task again while holding
that lock. Pending/deleted tasks cannot receive new prompts or recreate saved conversation records.
Chat draft/view capture still completes while executable actions are blocked. After release, only
that task's Warden-local records and archives are removed; external agent histories remain external.
Retained conversation engines observe state changes for deletion cleanup without starting repository
watchers or preview synchronization. Task Chat cannot take over the workbench's preview-owner lease
when the repository is reopened or selected elsewhere.

**Stop Turn** sends `session/cancel` and cancels pending permission requests. Warden continues to
handle the original prompt response. **Disconnect** closes the owned connection and its agent process;
an active connection may expose this as **End Agent Process**. Neither a cancelled response, a completed
prompt nor an exited stdio process proves that all agent-started background commands have stopped.
Warden does not supervise those commands or kill unrelated terminals and preview servers.
Stopping never resets, cleans or rolls back task files.

Session metadata and conversation records are stored outside the source repository and bound to
the original task/workspace/profile. A reload or connection loss preserves the last known record
and marks uncertain work accordingly. Reopening the task chat restores its connection; a connection
failure alone does not trigger a restart loop. A possibly delivered prompt is never resent automatically.
Record replacement remains atomic while bounded retries tolerate brief filesystem contention.
If replacement keeps failing, the previous record is retained and the save error remains visible.

On opening a disconnected or failed task chat, retire any failed connection and revalidate the binding
and profile. If the same agent supports
`session/load`, load its saved session and treat replayed updates as display history, not tool
execution or new prompts. Preserve the prior local record when loading fails. If loading is
unsupported, offer **New Session** while retaining the previous record; local transcript storage is not
a promise of restored model state. Changing agents likewise starts an explicit new conversation.
An empty, uninterrupted conversation is an exception when Codex reports that its saved thread has
no rollout: Codex does not persist the thread before its first prompt. If loading replays no history,
create a replacement remote session automatically while retaining the local conversation and draft.
Keep the old session ID until replacement succeeds. Other load errors and conversations containing
history or uncertain work never trigger this fallback, and it never sends a prompt.
While the new record is saved and its temporary ownership claim is released, the panel shows
**Starting New Session** and disables connection and sending. It becomes disconnected
only after reset cleanup finishes, then connects automatically, so a newly visible record cannot race
that cleanup. **New Session** remains an explicit reset, not a prerequisite for first use.

## Git and preview remain user-operated

ACP activity does not approve or complete a task. A prompt ending, permission being granted or an
agent reporting success never connects preview, commits source changes, delivers to primary,
rebases a workspace or retries a failed operation automatically.

Users coordinate their agent's activity before requesting mutations. Warden does not infer
idleness from clean Git status or cancellation and adds no agent-idle declaration. Existing Git
operation locks, workspace identity checks and source/HEAD/index checks remain in force. Delivery
still requires complete review of the pinned source HEAD, saved content tree when applicable,
delivery boundary and primary HEAD. Saved uncommitted task content can be delivered directly;
changed source content or baseline versions require fresh review. Connection previews continue to
observe live content.

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
permission/cancel behavior, connection ownership, interruption and automatic restoration on opening. Packaged
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
- [Session configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [Legacy session modes](https://agentclientprotocol.com/protocol/v1/session-modes)
- [Slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)
- [Tool calls and permission options](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Prompt cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)
- [Authentication](https://agentclientprotocol.com/protocol/v1/authentication)
- [Stdio transport](https://agentclientprotocol.com/protocol/v1/transports)
