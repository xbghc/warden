# AGENTS.md

## Core contracts

- Prioritize reliable composition of connected workspace changes into preview for testing. Evaluate additional features against this core loop.
- Warden is a passive VS Code workbench with persistent plans, deliveries and conversations. Users decompose and order work, operate agents, review changes and initiate integration.
- Each requirement has an explicit base branch. Creating a task automatically allocates its own fresh logical workspace and branch; allocation details stay internal and the workspace remains available across multiple deliveries.
- Humans edit primary; agents edit task workspaces; dependencies, tests and dev servers live in the independent preview directory. Saved primary content is the baseline. Tasks are independent clones with their own `.git` directories; preview and composition worktrees share Warden's external Git repository, separate from primary.
- Connections compose changes reversibly into preview. Review uses native read-only VS Code diffs. Primary receives user-selected final commits with normal hooks and signing. Rebase checks are read-only; rebase is user-requested.
- Tasks are top-level items in the native sidebar, without Preview or Tasks grouping rows. Preview has no editor page; its status, commands and diagnostics use the status bar, native menus and output channel.
- Warden needs an agent integration that can send messages to an identified session and bind that session to the assigned task workspace. Neither ACP nor ownership of the agent process is a product requirement. Agents own tools, child commands and execution policies; conversations remain bound to their task and repository. Agent turn completion triggers no Git or preview action. See the minimum contract in docs/agent.md.
- Agents may reference primary, other allocated task workspaces and preview in the same repository read-only; edits and commits belong to their own task workspace. ACP automatically approves verified explicit file reads once under the User/Remote User read policy. Directory, sensitive and ambiguous requests retain permission choices; this policy does not establish a filesystem sandbox.
- Warden automatically connects to the configured ACP server at startup in a trusted workspace and reconnects after User or Remote User profile changes. Keep this connection alive until disconnect, failure, replacement or shutdown, and clean up owned processes. Initialization sends no work prompt and creates no Warden task. Task conversations retain separate connections with their assigned workspace as process and session cwd; reopening Warden does not resume task work automatically.
- Workbench access requires an available agent integration. Hide Configure ACP during workspace loading and pending agent connections. Once loading has finished, an unavailable agent requiring user action shows only the native Configure ACP button, revealing the native Settings view stacked beneath Workbench in the same sidebar. There is no separate manual connection-check page. Presets, connection progress, errors, authentication and reconnect controls belong in Settings; branch, task, workspace and preview controls stay hidden until connected. Each preset has one stable profile ID and is never duplicated when selected again.

## Read by task

Read the relevant contract before editing. Workflow and interaction design take precedence over the current implementation.

| Task | Source of truth |
| --- | --- |
| Naming, interface copy and domain vocabulary | [Terminology](docs/terminology.md) |
| Product scope and interactions | [Workflow](docs/workflow.md), [design](docs/design.md) |
| Workspace allocation, Git isolation, preview, delivery and rebase | [Worktrees](docs/worktrees.md) |
| Engine Git access, snapshots, locks and recovery | [State and security](docs/internals.md); use validated Git APIs and document new reads/writes in its [security model](docs/internals.md#security-model) |
| ACP ownership, configuration and conversations | [ACP design](docs/acp-design.md), [agent usage](docs/agent.md) |
| Review targets and diffs | [Reviewing](docs/reviewing.md) |
| Build, verification, release and platform setup | [Development](docs/development.md), [environment](docs/environment.md) |

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | TypeScript: engine/shared/tests, webview and extension |
| `pnpm test` | Unit tests and isolated Git integration fixtures |
| `pnpm lint` | Biome; safe fixes: `pnpm exec biome check . --write` |
| `pnpm build` | Extension and webviews |
| `pnpm build:vscode` / `pnpm build:webview` | Rebuild extension and webviews / rebuild webview only |
| `pnpm package:vscode` / `pnpm check:vscode` / `pnpm test:vscode` | Package VSIX / check assets / test the existing packaged VSIX |
| `pnpm storybook` / `pnpm build:storybook` | Component development / static Storybook build |
| `python3 test/ui/smoke.py` | Packaged webviews in Chromium against a disposable engine fixture; [prerequisites](docs/development.md#ui-verification) |

## Conventions

- Use the canonical terms in [Terminology](docs/terminology.md). Preserve Git meanings of commit, diff and rebase; define only Warden-specific roles and conventions. Preserve existing protocol/storage identifiers unless a migration is explicitly part of the task.
- Code, comments, commit messages, docs and Warden-owned UI strings use English. Preserve the language of user content, agent-provided text and Git/script output.
- `packages/shared` is raw TypeScript shared by engine, extension and webviews. Use `import type`; relative imports include `.js` except in webviews.
- Preserve lower_snake_case engine error codes through the host. Repository operations use TypeScript and validated Git CLI calls.
- Comments explain why and sit above the relevant branch. Update the topic doc for behavior changes; keep README short and update it when the review loop changes. Repair links when renaming headings.
- Prefer native VS Code trees, inputs, pickers, editors, settings and output. Choose webviews explicitly for complex interactions; ordinary navigation and operations stay native.
- Webview UI uses Tailwind v4, shadcn/ui primitives in `packages/webview/src/components/ui` and the neutral theme in `styles.css`. Keep `--accent` and `--muted` neutral, `--muted-foreground` secondary, and honor VS Code light, dark and high-contrast theme variables.
- Git tests use `makeFixtureRepo()` from `test/fixtures/make-repo.ts`; product verification covers the typed Engine and packaged extension host.

## Git workflow

- Commit directly to `main`. Titles use sentence-case imperative without a prefix; feature commits explain motivation and consequences in the body.
- After every push, follow CI for the exact pushed commit until all required quality checks and Windows/Linux/macOS matrix jobs pass. Fix failures and repeat; report the validated commit and successful run link.
- Release only on explicit request, following [Release](docs/development.md#release) through CI-tested VSIX publication to Marketplace.

## Human acceptance loop

- Verify native UI in the packaged extension host. For webview changes, prefer Storybook (`*.stories.tsx`) for component states and exercise affected flows in a real browser against a disposable repository per [UI verification](docs/development.md#ui-verification). Report coverage.
- Run the relevant local checks and provide a concise change and verification summary for quick human acceptance. Push only when explicitly instructed.
- Verification after development must cover relevant edge cases, including interrupted operations, invalid or replaced state, and context changes during in-flight work. Add regression tests for uncovered behavior and fixes, and report which boundaries were tested and any gaps.
