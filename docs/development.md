# Development

Warden is a pnpm workspace containing a VS Code extension, a reusable engine, shared contracts and
webview components. Use Node 22+ for development and the pinned Rust toolchain for native builds.
The engine still supports Node 20; the VS Code test launcher requires Node 22 or newer.
Using the packaged extension requires Git, not a separately installed Node or Rust runtime.

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

`build` builds the Rust module and extension including its webviews. `build:vscode` rebuilds JavaScript
and webviews using available native artifacts; `build:webview` refreshes just the webview bundle.
The extension manifest owns the release version. The repository root is private and ships no npm CLI.

| Directory | Responsibility |
| --- | --- |
| `packages/engine` | Repository sessions, workflow, Git adapters, state, preview and history |
| `packages/shared` | Domain types, review versions and validated webview actions |
| `packages/vscode` | Native views, immutable documents, commands and webview controllers |
| `packages/webview` | React/shadcn forms using packaged resources and VS Code theme colors |
| `crates/warden-core` | Independent fixed Git read operations |
| `crates/warden-node` | Asynchronous Node binding |
| `test/compat` | Legacy in-process HTTP harness for existing behavior tests; not a product server |

`pnpm typecheck` checks the engine/shared/tests, webview DOM project and extension project separately.
`pnpm test` runs colocated unit tests and isolated Git integration fixtures. `WARDEN_NATIVE=required`
requires the native artifact; `WARDEN_NATIVE=disabled` exercises the compatible Git backend. CI runs both.
Read-only Git operations retain their argument whitelist and environment isolation. New Git writes need
an explanation in [State and security](internals.md). Never replace normal delivery commits with commit-tree.

The extension invokes named typed engine commands; UI and transport code never bypass the engine's
operation validation. Engine errors retain stable codes. `Engine.close()` rejects new requests and drains
pending operations and observers. The preview-owner lease is independent of the mutation lock.
State, repository and preview locks retain permanent `.lock/v2/` containers and atomically publish
their `active` directory containing one unique owner file. Ownership tests must preserve the actual filesystem operations when controlling
reclaimer interleavings. Dead locks from the older plain-file format intentionally fail with
`legacy_lock_requires_cleanup`; follow the named-file recovery instructions in
[State and security](internals.md#state). Close all older Warden windows and processes before first
using this lock protocol; an already-running old reclaimer can otherwise move its container.

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
existing native review and Git flows. Interrupted prompts must not be resent automatically, and cancel
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

`test/ui/smoke.py` starts and closes `test/ui/harness.ts`, exercises initialization, empty states, task
menus and optional settings, preview setup, collapsed history editing/application and rebase selection, and saves screenshots under
`WARDEN_UI_ARTIFACTS` (default `/tmp/warden-ui-artifacts`). The harness is test-only and is not shipped.
Inspect screenshots and console errors. Preserve intentional error cases in native-host tests as well.
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

Reuse the shadcn primitives in `packages/webview/src/components/ui`. Theme values come from VS Code
variables, with neutral fallbacks for standalone test previews. Keep keyboard alternatives for drag
operations and accessible names on controls. The webview has a strict CSP and no direct filesystem,
shell or arbitrary VS Code command bridge.

## VS Code extension verification

`pnpm test:vscode` requires an existing VSIX, unpacks it into a temporary directory, and tests those
packaged bytes. It never silently substitutes a source build. `WARDEN_VSCODE_VERSION` selects the
host (default `1.95.3`); `VSCODE_EXECUTABLE_PATH` selects an existing executable. Linux CI uses Xvfb.
In environments requiring an HTTP proxy, configure the test downloader's `npm_config_https_proxy`.

The suite checks native read-only snapshots, stale review rejection, preview isolation/setup/terminal,
ordinary commit hooks and retained-stage recovery, multiline delivery, fresh workspaces, stale-session
rejection and stable delivery mapping across history rewrites. CI runs the same VSIX in minimum and
stable hosts on Windows, Linux and macOS.

## Release

Release only when explicitly requested. Change `packages/vscode/package.json`, update installation
examples, run `pnpm check:release`, commit `Release X.Y.Z`, tag `vX.Y.Z`, and push main and the tag.
Follow exact-commit CI and Marketplace publication to completion. The private root workspace does not
publish to npm. The release job downloads the VSIX that passed the entire reusable CI workflow and
publishes it through the existing Entra federation. Never publish locally.
