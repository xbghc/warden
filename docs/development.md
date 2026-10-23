# Development

Working on warden itself. Repository-wide coding-agent instructions live in [AGENTS.md](../AGENTS.md).

Use the [workflow contract](workflow.md) as the product design reference. Its
[alignment plan](workflow.md#implementation-alignment) distinguishes agreed changes from current
behavior. Keep user decisions with the user; do not build scheduling, agent handoff requirements
or a separate requirement approval system around implementation details being removed.

## Building and testing

```sh
pnpm install
pnpm build:native # Rust 1.88.0 (rustup reads rust-toolchain.toml)
pnpm dev          # API server on :4100 (tsx watch) + Vite dev server on :5173 with /api proxied
pnpm test         # vitest: diff parser, read-only review, watcher, todos, worktrees, export, state, HTTP API
pnpm typecheck
pnpm build        # dist/native (Rust) + dist/web (Vite) + dist/cli.js (tsup)
pnpm package:vscode # build an installable native VS Code extension
pnpm test:vscode    # real VS Code extension host integration (display required on Linux)
pnpm check:package # pack, unpack and exercise the real CLI with required native execution
node dist/cli.js path/to/repo
```

Layout:

```
bin/cli.ts           argument parsing, start server, open browser
packages/shared      types + target key helpers (bundled into both sides)
packages/server      Hono API, git wrapper, diff parser, read-only review, targets, worktrees, watcher, state, export
packages/vscode      workspace extension, native read-only diffs, preview terminals/tasks
packages/web         React + Vite + Tailwind v4 UI (shadcn/ui, shiki highlighting, @tanstack/react-virtual, react-markdown)
crates/warden-core   independent Rust repository operations, typed data and errors
crates/warden-node   thin asynchronous napi-rs binding; no workflow or HTTP logic
scripts/             native builds, package smoke test and repeatable Git read benchmark
test/                API integration tests on a generated git repository
```

Only `dist/`, `README.md`, `LICENSE` and `package.json` are published.

The Rust core initially batches Git status, HEAD and branch reads while keeping Git as the
implementation of repository semantics. It is a baseline for comparing operation-level native Git
libraries later. The performance work also shares checkout inventories within workflow requests
and reuses eligible isolated rebase verdicts; it does not treat changing languages as evidence of
a speedup. See [Rust core](rust-core.md) for module boundaries and benchmark methodology.

Install Rust through rustup for source builds; the checked-in toolchain and Cargo.lock pin the
compiler and dependencies. After changing Rust, run `pnpm build:native` and restart the API server
to load the rebuilt module. Ordinary npm users receive prebuilt artifacts and need Node and Git,
without a Rust compiler or install-time download. The package includes Linux glibc 2.35+ x64/arm64,
macOS 11+ x64/arm64, and Windows x64 binaries. Other targets, including musl or older glibc, use
the portable Git backend. An existing but unloadable native artifact is an error, not a silent
fallback. Source tests without a native build also use the portable backend.

Set `WARDEN_NATIVE=required` to reject a missing/unsupported native build, or
`WARDEN_NATIVE=disabled` to select the portable backend for comparison. CI requires native
execution across the platform matrix, also runs the full portable suite on Linux, runs Rust
formatting, clippy and tests, and exercises the unpacked npm tarball. The
release workflow collects the five artifacts tested for that exact tag; it does not rebuild only
the publishing machine's binary. All five must be present before publishing proceeds.

Releasing: set the same `version` in the root and `packages/vscode/package.json`, run
`pnpm check:release`, commit as `Release X.Y.Z`, tag `vX.Y.Z`, and push `main` and the tag.
Releases require an explicit user request. Never publish npm or Marketplace packages from a local
machine. The `Publish npm and VS Code` workflow runs reusable CI against the exact tag. CI rejects
mismatched package versions or tags before publication. The npm job runs lint, typecheck, build and tests through
`prepublishOnly`, and publishes over OIDC trusted publishing — no `NPM_TOKEN` secret to store or
rotate. It relies on a trusted publisher configured on the package's npmjs.com settings page (user
`xbghc`, repo `warden`, workflow `publish.yml`), and passes `--provenance` explicitly, because npm's
automatic attestation does not fire through `pnpm publish` (0.2.0 shipped without one). CI runs lint,
typecheck, tests, build, Storybook build and a package dry run on every push to `main` and every pull
request. Publishing waits for every CI job to succeed; only the two publishing jobs receive OIDC permission.
CI also runs the package smoke test with the pinned publishing npm version (12.2.1), in addition
to the version bundled with Node. The smoke test accepts both older array output and npm 12's
package-name map from `npm pack --json`, then checks and exercises the same unpacked tarball.

The VS Code CI job waits for the full test matrix, combines all five tested native modules into a
universal VSIX, checks its manifest and contents, and runs the extension-host tests against the
unpacked VSIX. It uploads `vscode-extension`; the Marketplace job downloads and publishes that exact
artifact with `vsce publish --oidc`. Source builds and packaging require Node 22 or newer for vsce 4;
the npm CLI still supports Node 20. See [VS Code publishing](vscode.md#automated-publishing) for the
one-time Marketplace trust configuration. No `VSCE_PAT` or `NPM_TOKEN` is needed.

The npm and Marketplace jobs run independently after the shared checks. If one registry rejects
a release, correct its configuration and use GitHub Actions **Re-run failed jobs** for the same tag.
Do not republish the successful registry, move an existing tag, or disable checks. A code fix needs
a new commit and version. Pushing ordinary `main` commits builds and tests artifacts without publishing.

The full test suite runs on Linux x64 with Node 20, 22 and 24, and Linux arm64, Windows x64 and
macOS x64/arm64 with Node 22. All platforms run the real Git workflow, workspace hooks, backups and failure recovery;
there is no reduced Windows suite. Publishing requires every platform job to pass. CI retains a
JUnit report for each OS/Node combination, including failed runs.

After every push, follow CI for the exact pushed commit through completion. If any job fails,
inspect its logs, fix the cause, run the relevant checks, commit and push again. Repeat until the
quality checks and the complete Windows, Linux and macOS test matrix all pass. Pending, failed,
cancelled or skipped required jobs do not count as success, and an earlier commit's successful
run does not validate a later push. CI follow-up is part of the push task: do not finish by merely
reporting that CI has started. Report the final validated commit and its successful CI run link.

Vitest separates fast unit tests (5 seconds) from real Git integration tests (30 seconds).
Integration setup and teardown hooks also have a 30-second budget; the conflict fixture drains
pending setup before cleanup even when setup times out, so Git never races deletion of its cwd.
Windows uses at most two file workers to avoid overwhelming process startup. Only the measured
long, multi-delivery, repeated clone release and history workflows have a 90-second Windows budget.
The combined delivery, history replay and rebase test has a 60-second macOS budget after exceeding
30 seconds on Intel CI runners; other macOS integration tests keep their 30-second budget. Checks
are not retried to hide failures. Use `pnpm exec vitest run --project=unit` or `--project=integration`
to narrow a run.
API cases each prepare an independent repository, index and review state, so they can run by name
or in a different order. Asynchronous tests await observable completion rather than fixed sleeps;
server cleanup drains requests, watchers and preview refreshes before deleting fixtures.

Every test worker clears inherited `GIT_*` variables before creating fixtures, so a developer's
`GIT_DIR`, index, object-store or tracing settings cannot redirect test writes into another repository.
Global and system Git configuration are disabled; identities and any hooks needed by a test must be
configured in its temporary repository. Fixtures resolve their real paths to match Git on macOS.
Filename cases use spaces, Unicode and literal pathspec characters on every platform, with colons
and double quotes additionally covered where the host filesystem permits them. Windows workspace
hooks use Git for Windows' bundled shell; see [Platform](environment.md) for prerequisites.

## UI verification

Exercise UI changes in a real browser against a disposable repository and an isolated Warden state
file. Keep test repositories, numbered workspace siblings, launchers and screenshots in a dedicated
temporary directory outside the real checkout.

1. Build the web bundle with `pnpm build:web`; rebuild and reload after further UI edits.
2. Create a temporary Git repository with a local fixture identity, a few commits and the files or
   branches the flow needs. Never use a user's real repository for browser verification.
3. Start `startServer` from `packages/server/src/index.ts` with the temporary `repoPath`, an explicit
   temporary `stateFile`, and the built `dist/web` as `webDir`. Use a `.mts` launcher when running
   outside a package so top-level await works. Confirm the server answers before opening the page.
4. Drive the affected interactions in a browser and inspect screenshots of the result. Check handled
   API errors against the expected flow; an intentional rejection is not itself a browser failure.
5. Always close the test server and await its cleanup before deleting fixtures. Stop only processes
   created for the check. Confirm `git status --short` contains no test artifacts.

Report the flows exercised and any flow that could not be reached.

## Storybook

[Browse the hosted Storybook](https://xbghc.github.io/warden/). Every push to `main` builds and deploys it through `.github/workflows/storybook-pages.yml`; the workflow can also be run manually. Repository Settings → Pages must use **GitHub Actions** as the publishing source.

Run `pnpm storybook` for isolated review and layout components at http://127.0.0.1:6006. Stories use in-memory fixtures and include interaction checks. Run `pnpm build:storybook` to build the static preview.

The new application uses one left navigation: *运行预览*, *提交历史*, the ordered *工作区* list with connection switches,
and bottom *同步工作区* / *设置* actions. A selected task contains its workspace path, hook results,
notes, files and diff. There is no second review-mode switch or task-completion declaration.

`Workspace/Workspace` stories cover connection previews, initial conflicts, stale previews,
task review, plans, settings, batch rebase, Web commits, rejected hooks and history arrangement.
Their API/event fixtures are independent of the running Git server. `UI/Primitives` shows the
shared shadcn controls. Stories demonstrate interaction states; real Git behavior is covered by
`test/workflow.test.ts` and `test/workbench.test.ts` and verified in a throwaway browser fixture.

## UI components

The shared primitives in `packages/web/src/components/ui` are adapted from the official
[shadcn/ui New York registry](https://ui.shadcn.com/docs/components) for React 18 (`forwardRef`
on controls that receive refs). They use Radix, Tailwind v4, `class-variance-authority`, and the
`cn` helper in `src/lib/utils.ts`. `packages/web/components.json` configures the shadcn CLI;
run it from `packages/web` when adding a component and retain React 18 ref support.

`src/styles.css` defines the neutral theme and application layouts. Use component variants for
common controls; keep custom styles for the diff, file tree and task editor. `--accent` and
`--muted` are shadcn surface colors. Interface text uses the
system sans-serif font, while code retains IBM Plex Mono. Vite and Storybook share the same theme.

## VS Code extension verification

`pnpm test:vscode` builds the extension and launches a disposable VS Code 1.95.3 extension host.
The suite verifies native readonly diff tabs, primary/preview isolation, setup and
preview terminal cwd. On Linux use an existing display or `xvfb-run -a pnpm test:vscode`.
`VSCODE_EXECUTABLE_PATH` can select an already downloaded VS Code executable. The fixture owns
its repository, numbered workspace, data directory and user/extension profiles, and removes them
after host shutdown. `pnpm package:vscode` creates the VSIX under `packages/vscode`; no publishing
or marketplace credentials are involved. The extension's bundled backend uses the same native
module when packaged, with the existing portable Git fallback on other supported hosts.
