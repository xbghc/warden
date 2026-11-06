# Development

Warden is a pnpm workspace containing a VS Code extension, a reusable engine, shared contracts and
webview components. Use Node 22+ and Git for development.
The engine still supports Node 20; the VS Code test launcher requires Node 22 or newer.
Using the packaged extension requires Git; VS Code supplies the Node runtime.

## Building and testing

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm package:vscode
pnpm check:vscode
pnpm test:vscode
```

`WARDEN_VSCODE_SUITE=tree-refresh pnpm test:vscode` runs a focused native regression for branch
replacement while descendant reads are held and menu contexts change. It also checks hidden views,
tree file layout, menu state during pending repository reads and superseded expansion restores.
Settings coverage holds script-child reads while repository and connection contexts change, including hidden views.
All packaged host suites inspect the renderer logs after shutdown and fail on Warden tree errors
(including Settings), even when the extension tests exit with 0.
Set `WARDEN_VSCODE_ARTIFACTS` to retain renderer and Warden logs outside the disposable fixture directory,
including after host failures. CI uploads these logs, and failed runs print recent Warden diagnostics.
The packaged extension's CI matrix runs this regression before the full native suite on each platform.

`WARDEN_VSCODE_SUITE=deletion pnpm test:vscode` runs the packaged task deletion flow: native menu
contributions, confirmation/cancellation, local agent disconnection, chat cleanup, directory
reuse and visible retry after failed preview disconnection. The full native suite also includes it.

`WARDEN_VSCODE_SUITE=autorebase pnpm test:vscode` runs automatic rebase in the packaged host: idle
Can Rebase tasks only, busy tasks resuming after their turn, one attempt per check and the setting
turned off. The launcher writes `"warden.autoRebase": false` to the disposable user settings so other
suites see exact workspace heads; this suite and the full native suite enable it explicitly.

`build` and `build:vscode` build the extension and its webviews. `build:webview` refreshes just the
webview bundle. The VSIX contains bundled JavaScript and uses the workspace's Git CLI.
The extension requires VS Code 1.106+ for the stable Secondary Side Bar contribution point.
The extension manifest owns the release version. The repository root is private and ships no npm CLI.

| Directory | Responsibility |
| --- | --- |
| `packages/engine` | Repository sessions, workflow, Git adapters, state, preview and history |
| `packages/shared` | Domain types, review versions and validated webview actions |
| `packages/vscode` | Native views, immutable documents, commands and webview controllers |
| `packages/webview` | React/shadcn forms using packaged resources and VS Code theme colors |
| `test/compat` | Legacy in-process HTTP harness for existing behavior tests; not a product server |

Retired HTTP response types, repository summaries, commit-list parsing, note export and workspace
management comparisons stay in `test/compat` with their regression tests. The harness serves no
static web application. Product coverage uses the typed Engine and packaged extension; the
compatibility harness remains until its behavior coverage is migrated.

`pnpm typecheck` checks the engine/shared/tests, webview DOM project and extension project separately.
`pnpm test` runs colocated unit tests and isolated Git integration fixtures against the TypeScript
engine and Git CLI. CI covers Windows, Linux and macOS, including x64 and arm64 runners.
Read-only Git operations retain their argument whitelist and environment isolation. New Git writes need
an explanation in [State and security](internals.md). Never replace normal delivery commits with commit-tree.
See [Git reads](git-reads.md) for status limits, query reuse and reproducible performance measurements.

Verification after each behavior change includes its relevant edge cases: empty or missing state,
interruption and recovery, stale requests, concurrent context changes and replaced resources. Add
regression coverage for missing boundaries and reproduced defects; report the checks run and any
remaining gaps alongside the normal flow. Use real Git fixtures, ACP subprocesses and the packaged
extension host when the behavior crosses those boundaries.

The [initial test evidence baseline](qa/test-baseline-2026-11-03.md) records an exact-commit CI run,
reviewed assertions and an open audit queue. Passing suites do not establish complete edge-case
coverage. Future audits should inspect both changes since their last recorded revision and outstanding
baseline items; unchanged code does not retire an unreviewed boundary. Record evidence and remaining
limits for each item before marking it reviewed.

For branch changes, `test/acp-branches.test.ts` combines real task allocation, session persistence and
agent subprocesses, including renamed or deleted base branches. The packaged regression,
`WARDEN_VSCODE_SUITE=branches pnpm test:vscode`, also exercises running task chats
across tracked/untracked branches and detached HEAD, permission routing, unsent drafts, reopening
saved conversations and recovery from a task workspace switched to an unrelated branch. These cases
run in the full packaged host suite as well. Existing ACP tests cover unsupported or failed session
loading and cross-window ownership; an unchanged transcript alone does not prove a session resumed.

The extension invokes named typed engine commands; UI and transport code never bypass the engine's
operation validation. Engine errors retain stable codes. `Engine.close()` rejects new requests and drains
pending operations and observers. The preview-owner lease is independent of the mutation lock.
State, repository and preview locks retain permanent `.lock/v2/` containers and atomically publish
their `active` directory containing one unique owner file. Ownership tests must preserve the actual filesystem operations when controlling
reclaimer interleavings. Dead locks from the older plain-file format intentionally fail with
`legacy_lock_requires_cleanup`; follow the named-file recovery instructions in
[State and security](internals.md#state). Close all older Warden windows and processes before first
using this lock protocol; an already-running old reclaimer can otherwise move its container.

## Debugging in VS Code

Open the repository root in VS Code, locally or through Remote SSH, WSL or Dev Containers.
Install dependencies and build the extension in that window's terminal:

```sh
pnpm install
pnpm build
```

Select `Debug Warden` in Run and Debug and press F5. The launch configuration runs
`pnpm build:vscode` before each launch, then loads `packages/vscode` into an Extension Development Host.
In that new window, open a disposable Git repository to exercise Warden. Keep the source checkout
open in the original window for breakpoints, variables and the Debug Console.

The extension bundle includes source maps for TypeScript breakpoints in `packages/vscode/src`,
`packages/engine/src` and `packages/shared/src`. After changing TypeScript or webview code, stop and
start debugging again to rebuild and reload.

In Remote windows, builds and the workspace extension host run in the remote environment; the
development window appears in the local VS Code client. Use a test repository in that same remote
environment. Source debugging does not require packaging or installing a VSIX. See
[VS Code's remote extension debugging guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions#debugging-using-ssh).

### Diagnostic logs

Open **View → Output → Warden** for the extension's native log channel. It is available even when
ACP setup fails and Workbench is gated. Use **Developer: Set Log Level… → Warden** to select
Debug or Trace, then reproduce the problem. VS Code manages the local log files and their retention;
use **Developer: Open Logs Folder** to locate host logs. In SSH, WSL and container windows, Warden
runs and logs on the workspace extension host. Logs are not uploaded or stored in repository state.

- **Info** records activation, repository lifetime, engine mutations, preview status changes,
  ACP connection/session/turn lifetime, permission waits and disconnect requests.
- **Debug** adds ACP startup phases, process IDs, negotiated protocol capabilities, request methods,
  durations, first streamed update, tool status, session restoration and view routing.
- **Trace** adds engine reads, conversation saves and the types of individual ACP updates,
  including ignored foreign-session or stale-connection notifications.
- **Warning/Error** records failures, timeouts, authentication requirements, unexpected exits,
  forced termination and persistence/cleanup problems at every verbosity level that includes them.

`[diagnostic]` lines contain JSON with a timestamp and window `run` ID. Engine instances, task
conversations, ACP connection attempts, turns, permissions and timed operations have separate
correlation IDs. `operation` pairs each `.start` with its `.end`; `durationMs` uses a monotonic clock.
Outcomes distinguish `ok`, `error`, `timeout`, `cancelled` and `authentication_required`. Filter by
`connection` to inspect one attempt, or by `task` and `turn` to follow a conversation. A start without
an end identifies pending work or an interrupted host. A successful RPC does not imply that the
agent has stopped all child commands; turn completion retains its existing passive behavior.

Routine records contain selected metadata and counts, not prompts, replies, thoughts, tool inputs,
file contents, profile commands/arguments or environment dumps. ACP failures include bounded error
details and recent stderr to explain generic provider errors. Structured payload/credential fields,
known environment secrets and common credential formats are redacted before output. Stderr is
buffered across chunks; oversized lines are dropped whole. Agent-supplied free-form error messages
and stderr can still contain other project-specific context. Logging failures cannot replace the
operation's result. Explicit **Show Preview Output** and **Show Setup Script Output** retain their
user-requested script output.

### Startup performance

Warden automatically writes local `[performance]` JSON lines to **View → Output → Warden**.
Reload the window to capture a fresh activation, then copy the lines from that output channel.
No setting or agent prompt is required. These diagnostics are not uploaded or saved in repository
state. They contain fixed stage names, generated IDs, timestamps, durations and outcomes; they omit
repository paths, task content, agent commands, credentials and raw error messages.

Task Chat failures also write `[ACP Task Chat]` diagnostics to the Warden output channel and the
extension host's Debug Console. These separate error records identify the task, profile and failed
operation, retain the ACP error code and bounded error details, and include the agent's recent stderr.
Credential fields, common token formats and configured secret environment values are redacted;
prompt payloads, executable configuration and stdout are not deliberately recorded. The panel also
shows bounded error details so an `Internal error` response does not hide its underlying cause.

Each record has `version: 1`, a window activation `run` ID, a numeric `span` ID, an optional `parent`
span, a `stage`, an `event` (`start` or `end`) and a wall-clock `timestamp`. `elapsedMs` measures
time since entry into Warden's `activate`; end records also have `durationMs` and `outcome`.
Durations use a monotonic clock. Outcomes distinguish `ok`, `error`, `timeout`, `cancelled` and
`authentication_required`. A start without an end identifies a pending phase (or an interrupted
host). Logging failures do not fail the measured operation.

- `activation` includes workbench construction, repository opening and the initial refresh.
- `repository.open` includes waiting for previous work (`repository.wait`), `engine.open`,
  `repository.refresh` and restoring expanded reviews (`review.restore`). The refresh measures
  the combined workflow/preview/workspace read (`repository.get`), `workflow.context`, optional
  branch following (`workflow.configure`) and observer startup (`engine.start`) separately.
  `context.update` measures ordered context publication; unchanged values do not cross the host boundary again.
- Initial advisory synchronization checks (`rebase.check`) run separately and may finish after
  activation. Pending checks never block repository navigation or report a current workspace.
- `acp.connect` includes previous-process cleanup (`acp.cleanup`), process creation (`acp.spawn`),
  protocol negotiation (`acp.initialize`) and empty-session creation (`acp.session.new`). Explicit
  authentication has a separate `acp.authenticate` span. Reconnects get new spans within the run.

Automatic ACP connection starts once the primary directory is resolved, overlapping the initial
repository refresh. During an uninterrupted automatic startup with a configured profile, the later
of the successful `activation` and `acp.connect` end records' `elapsedMs` measures activation entry
through repository and ACP readiness, including the 300 ms connection scheduling delay. Later retries also
include the time spent waiting for user action; use `durationMs` to compare connection attempts.
Missing or invalid configuration produces no connection span;
inspect Settings for the configuration state. Authentication-required and failed attempts are not
reported as ready. Parallel and nested spans overlap, so do not sum their durations.

Only repository opens, their initial refreshes and associated background checks are instrumented; ordinary background refreshes
do not emit performance records. This measures extension-host wall time, not VS Code startup before
activation, module loading, visible paint, task-chat connections, CPU usage or individual Git commands.
Use the separate [Git benchmark](git-reads.md#reproducible-measurements) for isolated Git measurements.

## ACP verification

ACP tests use `test/fixtures/acp-agent.mjs`, an SDK-compatible child agent that performs its own file
operations. Cover stable protocol initialization with no client filesystem/terminal capabilities,
streamed updates, permission answers, cancellation, explicit authentication, automatic session restoration on opening, stale task
bindings and cross-window connection ownership. The fixture must exercise real stdio and its own tools;
client file callbacks or Warden-run agent commands would test an unsupported architecture.
Automatic read approvals cover primary/task/preview files, manual fallback for ambiguous or sensitive
targets, replaced roots and files, user-policy changes, cancellation during ownership checks and late
results after reconnect. The packaged chat suite verifies the real engine scope and rejects workspace
settings that attempt to override the User read policy.
Workspace-context coverage includes negotiated append instructions, absent/null/malformed capabilities,
visible ordinary-message fallback and replay, reconnect capability changes, instruction rejection,
old saved bindings, interrupted prompts, replaced workspaces during session setup/persistence and
primary branch changes without retargeting instructions. The packaged chat suite checks the shipped
system prompt and fallback paths, intact composer drafts and restoration without sending work.
Browser replay checks wait for the fixture to receive a prompt before cancelling that turn; a visible
Stop button alone does not establish submission. New-session checks wait for the replacement record
before testing its connected state. Startup gates bind to the replacement engine so a draining
observer from the previous repository cannot satisfy the loading assertion.
Browser navigation drains queued host actions before replacing the page, so it cannot cancel the
base-branch selection that the following view is meant to verify.
Packaged authentication-state checks use the same connection wait budget as successful startup,
including task-binding validation and process creation on Windows.
Conversation state observers must still clean up deleted tasks without acquiring preview ownership,
including after workbench replacement and while state notifications are draining during shutdown.
Also cover initial and between-turn configuration, grouped/boolean selectors, legacy mode fallback,
complete selector replacement, command updates, thought streaming, usage and compaction patch semantics.
Keep controls connection-scoped and exercise foreign-session updates and interrupted configuration requests.
Model-preference coverage includes immediate saves, new-task defaults, independent resumed choices,
profile replacement, credential rotation, invalid stored values, unavailable choices, rejected and
timed-out restoration, workspace replacement during selection and disconnection during restoration.
Reasoning controls exercise arbitrary option IDs, budget values, missing categories and model-dependent
choice replacement. The packaged chat suite checks new-task inheritance, task-specific reconnection,
explicit new-session defaults and saved-record reopening through the shipped host.

Packaged extension-host and conversation webview tests verify the shipped UI/host bridge alongside
existing native review and Git flows. Cover sidebar/editor transfers during permission requests,
missing and invalid agent profiles before and after branch selection, live configuration updates,
workspace-profile rejection, a single native Configure ACP button for missing profiles, shared native Settings
view routing without launching an editor or preset picker, stacked/collapsible view contributions,
reopening hidden views with collapsed ACP controls, the bundled custom-agent example, named profile
configuration and conversion from legacy arrays without changing profile identity,
multiline script saves, cancellation, legacy-script preservation and stale repository/configuration
rejection, preset controls available only in Settings,
automatic startup/reconfiguration connections, and gated workflow surfaces and actions
for unchecked, missing-executable, incompatible-protocol, session-setup and authentication failures.
Verify that successful initialization leaves the connection alive, unexpected exits revoke availability,
and replacement/shutdown stop owned processes and cancel pending startup. Cover stale results, no work
prompts and recovery without losing tasks or drafts. Opening Settings alone does not start
an additional connection; startup and profile saves do. Also cover
native Codex/OpenCode preset selection, command-input cancellation, existing and concurrently edited
profile preservation, workbench-selected agents for new Task Chats, automatic first-session creation
and saved-session restoration on opening, repeated opens without duplicate connections, single-row composer
mode/model/effort controls in narrow sidebars, slash completion with filtering, keyboard/mouse selection,
argument preservation and no implicit submission, Enter/Shift+Enter and IME behavior, and the absence of agent setup inside Task Chat,
per-task draft and reading-position restoration, stale view messages and concurrent background turns. Interrupted prompts must not be resent automatically, and cancel
must not claim that all agent-owned background commands have stopped. These checks do not validate a
third-party authenticated agent; record the exact agent/adapter version and supported features before
making a vendor-specific compatibility claim. See [ACP design](acp-design.md).

## UI verification

Use disposable repositories and isolated state, never a user's checkout. The browser harness uses the
actual packaged webview assets and a temporary engine; the native-host suite covers VS Code integration.

```sh
pnpm package:vscode
python3 -m pip install -r test/ui/requirements.txt
python3 -m playwright install chromium
python3 test/ui/smoke.py
python3 test/ui/acp-smoke.py
pnpm test:vscode
```

`test/ui/smoke.py` starts and closes `test/ui/harness.ts`, exercises initialization, empty states,
title-only task creation and renaming, native Settings links, rebase selection and partial selection, and saves screenshots under
`WARDEN_UI_ARTIFACTS` (default `/tmp/warden-ui-artifacts`). The harness is test-only and is not shipped.
Inspect screenshots and console errors. Preserve intentional error cases in native-host tests as well.
For manual verification, run `node --import tsx test/ui/harness.ts` and open its reported port. `/inspect`
embeds the rebase panel at 320 pixels in light, dark and high-contrast themes. `WARDEN_UI_PORT` and
`WARDEN_UI_HOST` optionally select the local test binding; defaults remain an ephemeral loopback port.
`test/ui/acp-smoke.py` uses the same packaged assets with real ACP subprocesses to exercise concurrent
task conversations, permission choices, cancellation, automatic restoration on opening and draft preservation.
Set `CHROMIUM_PATH` to use an existing browser. CI runs this test against assets read directly from
the same VSIX used by the extension-host matrix.

## Storybook

```sh
pnpm storybook
pnpm build:storybook
```

Storybook lives in `packages/webview`. It previews shared primitives and workbench states without
executing repository operations. GitHub Pages receives the Storybook artifact through its existing CI job.

## UI components

Prefer native VS Code TreeView, inputs, pickers, editors and output for ordinary interactions.
Use Storybook for the explicitly chosen webview forms, not to recreate native controls.
Reuse the shadcn primitives in `packages/webview/src/components/ui`. Theme values come from VS Code
variables, with neutral fallbacks for standalone test previews. Keep keyboard alternatives for drag
operations and accessible names on controls. The webview has a strict CSP and no direct filesystem,
shell or arbitrary VS Code command bridge.

## VS Code extension verification

`pnpm test:vscode` requires an existing VSIX, unpacks it into a temporary directory, and tests those
packaged bytes. It never silently substitutes a source build. `WARDEN_VSCODE_VERSION` selects the
host (default `1.106.0`); `VSCODE_EXECUTABLE_PATH` selects an existing executable. Linux CI uses Xvfb.
`WARDEN_VSCODE_SUITE=chat pnpm test:vscode` runs the packaged agent-setup and task-chat flows while iterating.
`WARDEN_VSCODE_SUITE=settings pnpm test:vscode` runs native Settings, ACP setup/recovery and script editors.
`WARDEN_VSCODE_SUITE=branches pnpm test:vscode` runs branch tracking, inactive restoration and repository-switch observation races.
In environments requiring an HTTP proxy, configure the test downloader's `npm_config_https_proxy`.

The suite checks native tree setup with top-level tasks, tree/list layout switching and saved preference,
nested-file navigation and refresh, row menus, drag/keyboard ordering, input cancellation, stale-session rejection,
independent expansion and native read-only snapshots, stale review rejection, preview isolation/setup/terminal,
native preview status, compact execution menus with and without a configured command, persistent sync/setup
recovery actions, Settings-row reruns and stale-row rejection, preview terminal reuse across repository
switches and recreation after closure, and diagnostic output without a Preview editor page,
ordinary commit hooks and retained-stage recovery, native commit-input cancellation and stale-version
rejection while typing, multiline delivery, fresh workspaces, stale-session
rejection and preservation of delivery records. History rewriting remains covered by engine tests. CI runs the same VSIX in minimum and
stable hosts on Windows, Linux and macOS. Branch-following coverage switches the primary checkout
through Git, including branches at the same commit, verifies per-branch task/draft restoration and
stale action rejection, quiet untracked/detached checkouts, explicit tracking of empty branches and
inactive reloads. It preserves dirty task workspaces and preview connections while away, as well as
connected-preview guards when switching between tracked branches.
On Linux with ImageMagick installed, set `WARDEN_VSCODE_BRANCH_SCREENSHOTS` to save native screenshots
of untracked, explicitly tracked empty and restored connected branches.
CI packages the VSIX after quality checks so browser and extension-host tests run alongside the engine
matrix. Marketplace publication requires the entire reusable workflow to succeed, including both matrices.
Windows and Intel macOS serialize Git integration files because each file already issues parallel Git reads.
Native chat connection checks allow 30 seconds for Git validation and agent startup or restoration.
The Windows packaged host job has a 30-minute budget for the complete suite.

## Release

Release only when explicitly requested. Change `packages/vscode/package.json`, update installation
examples, run `pnpm check:release`, commit `Release X.Y.Z`, tag `vX.Y.Z`, and push main and the tag.
Follow exact-commit CI and Marketplace publication to completion. The private root workspace does not
publish to npm. The release job downloads the VSIX that passed the entire reusable CI workflow and
publishes it through the existing Entra federation. Never publish locally.
