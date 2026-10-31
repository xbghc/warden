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

`pnpm typecheck` checks the engine/shared/tests, webview DOM project and extension project separately.
`pnpm test` runs colocated unit tests and isolated Git integration fixtures against the TypeScript
engine and Git CLI. CI covers Windows, Linux and macOS, including x64 and arm64 runners.
Read-only Git operations retain their argument whitelist and environment isolation. New Git writes need
an explanation in [State and security](internals.md). Never replace normal delivery commits with commit-tree.
See [Git reads](git-reads.md) for status limits, query reuse and reproducible performance measurements.

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

## ACP verification

ACP tests use `test/fixtures/acp-agent.mjs`, an SDK-compatible child agent that performs its own file
operations. Cover stable protocol initialization with no client filesystem/terminal capabilities,
streamed updates, permission answers, cancellation, explicit authentication/restoration, stale task
bindings and cross-window connection ownership. The fixture must exercise real stdio and its own tools;
client file callbacks or Warden-run agent commands would test an unsupported architecture.
Also cover initial and between-turn configuration, grouped/boolean selectors, legacy mode fallback,
complete selector replacement, command updates, thought streaming, usage and compaction patch semantics.
Keep controls connection-scoped and exercise foreign-session updates and interrupted configuration requests.

Packaged extension-host and conversation webview tests verify the shipped UI/host bridge alongside
existing native review and Git flows. Cover sidebar/editor transfers during permission requests,
missing and invalid agent profiles before and after branch selection, live configuration updates,
workspace-profile rejection, a single native Configure ACP button for missing profiles, shared Settings
panel routing without launching the preset picker, preset controls available only in Settings,
automatic startup/reconfiguration connections, and gated workflow surfaces and actions
for unchecked, missing-executable, incompatible-protocol, session-setup and authentication failures.
Verify that successful initialization leaves the connection alive, unexpected exits revoke availability,
and replacement/shutdown stop owned processes and cancel pending startup. Cover stale results, no work
prompts and recovery without losing tasks or task-note drafts. Opening Settings alone does not start
an additional connection; startup and profile saves do. Also cover
native Codex/OpenCode preset selection, command-input cancellation, existing and concurrently edited
profile preservation, workbench-selected agents for new Task Chats, composer mode/model controls,
Enter/Shift+Enter and IME behavior, and the absence of agent setup inside Task Chat,
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
multiline task-note drafts after discarding webview-local state, save/discard behavior, optional settings and rebase selection, and saves screenshots under
`WARDEN_UI_ARTIFACTS` (default `/tmp/warden-ui-artifacts`). The harness is test-only and is not shipped.
Inspect screenshots and console errors. Preserve intentional error cases in native-host tests as well.
For manual verification, run `node --import tsx test/ui/harness.ts` and open its reported port. `/inspect`
embeds the task-note editor at 320 pixels in light, dark and high-contrast themes. `WARDEN_UI_PORT` and
`WARDEN_UI_HOST` optionally select the local test binding; defaults remain an ephemeral loopback port.
`test/ui/acp-smoke.py` uses the same packaged assets with real ACP subprocesses to exercise concurrent
task conversations, permission choices, cancellation, explicit recovery and draft preservation.
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
In environments requiring an HTTP proxy, configure the test downloader's `npm_config_https_proxy`.

The suite checks native tree setup with top-level tasks, row menus, drag/keyboard ordering, input cancellation, stale-session rejection,
independent expansion and native read-only snapshots, stale review rejection, preview isolation/setup/terminal,
native preview status, persistent failure feedback and diagnostic output without a Preview editor page,
ordinary commit hooks and retained-stage recovery, native commit-input cancellation and stale-version
rejection while typing, multiline delivery, fresh workspaces, stale-session
rejection and preservation of delivery records. History rewriting remains covered by engine tests. CI runs the same VSIX in minimum and
stable hosts on Windows, Linux and macOS. Branch-following coverage switches the primary checkout
through Git, including branches at the same commit, verifies per-branch task/draft restoration and
stale action rejection, and preserves dirty task workspaces and connected-preview switch guards.

## Release

Release only when explicitly requested. Change `packages/vscode/package.json`, update installation
examples, run `pnpm check:release`, commit `Release X.Y.Z`, tag `vX.Y.Z`, and push main and the tag.
Follow exact-commit CI and Marketplace publication to completion. The private root workspace does not
publish to npm. The release job downloads the VSIX that passed the entire reusable CI workflow and
publishes it through the existing Entra federation. Never publish locally.
