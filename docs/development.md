# Development

Warden is a pnpm workspace containing a VS Code extension, a reusable engine, shared contracts and
webview components. Use Node 20+ for development and the pinned Rust toolchain for native builds.
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

## UI verification

Use disposable repositories and isolated state, never a user's checkout. The browser harness uses the
actual packaged webview assets and a temporary engine; the native-host suite covers VS Code integration.

```sh
pnpm package:vscode
python3 -m pip install -r test/ui/requirements.txt
python3 -m playwright install chromium
python3 test/ui/smoke.py
pnpm test:vscode
```

`test/ui/smoke.py` starts and closes `test/ui/harness.ts`, exercises task creation, initialization/settings,
preview setup, history preview/application and rebase selection, and saves screenshots under
`WARDEN_UI_ARTIFACTS` (default `/tmp/warden-ui-artifacts`). The harness is test-only and is not shipped.
Inspect screenshots and console errors. Preserve intentional error cases in native-host tests as well.
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
