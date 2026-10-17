# AGENTS.md

This file defines repository-wide instructions for coding agents working on Warden.

## Product workflow

`docs/workflow.md` defines the agreed product scope. `docs/design.md` describes the new interaction
design. These take precedence over the transitional implementation descriptions below. The user has authorized implementation of the
new workflow and UI. The new page design was developed
by an independent agent given only the agreed workflow, without reading existing UI/code. Do not
preserve old navigation or state machines merely because the current code contains them.

Warden is a passive tool: users act through it; they do not maintain extra status reports for it.
The user decomposes and orders work, invokes configured tmux commands and reviews changes before
squash. No dependency enforcement, scheduling, agent-owned decomposition, ready/idle declarations,
task-complete checkbox or separate requirement approval belongs in the product.

One workspace corresponds to one linear task and can deliver several commits. Keep it available
across deliveries; do not automatically recycle it or ask whether a delivery finishes the task.
The primary development branch (主开发分支) belongs to the requirement, not the repository default
branch. All code edits happen in worktrees. Dependencies and user-operated tests/dev servers belong
in the primary directory. Neovim/editor integration is out of scope.

Connections are reversible live composition into the primary directory, separate from review and
squash. An initial connection conflict must notify the user and fail that connection attempt,
preserving the existing preview. The Web page must support commit-message entry and ordinary Git
commit hooks without requiring terminal use. A development commit must not include other connected
workspaces by accident. After the
primary development branch changes, automatically check and display synchronization conditions;
rebase runs only on the user's request for one, selected or all workspaces. Checks must not change
active workspace files. Clean Git state or successful tmux input does not establish agent idleness.

Accepted commit order and messages can be edited in the planned history UI. This is separate from
plan ordering; use stable delivery associations across rewritten SHAs. Do not add history undo,
restore actions or an undo timeline; users adjust the current history again. The backup-branch plus
cherry-pick proposal is the starting point for isolated preview and explicit application.

The working copy implements persistent deliveries, temporary connections, isolated rebase checks
and linear history arrangement. Keep these operations passive. Legacy low-level HTTP endpoints
remain for compatibility; they must not revive readiness gates or automatic recycling in the UI.

## Commands

- `pnpm typecheck` runs two separate tsc projects: the root one (bin, packages/shared, packages/server, test; Node lib) and `pnpm --filter @warden/web typecheck` (DOM, JSX). Both must pass.
- `pnpm test` is one vitest config. Unit tests sit beside sources (`packages/*/src/**/*.test.ts`), integration tests in `test/`. Web tests cover only `packages/web/src/lib/**`; there is no jsdom and no component test. One file: `pnpm exec vitest run test/api.test.ts` (add `--reporter=verbose` for names).
- `pnpm build` order is load-bearing: Vite empties `dist/web`, tsup writes `dist/cli.js` with `clean: false`, so web must build before server or the CLI is wiped. `pnpm build:web` alone refreshes what a running server serves from `dist/web`.
- `pnpm dev`: server on 4100 (`tsx watch bin/cli.ts --port 4100 --no-open`) plus Vite on 5173 proxying `/api`.
- `pnpm lint` is Biome (`biome check .`): lint plus formatting, configured in `biome.json` to the house style (single quotes, semicolons, 2-space, trailing commas, 160-column lines). `pnpm exec biome check . --write` applies safe fixes and formats. `noNonNullAssertion` is off on purpose: `x[0]!` under `noUncheckedIndexedAccess` is the idiom here. CI runs lint before typecheck.

## Git access in the server

- Reads go through `runGit` in `packages/server/src/git.ts`, which enforces a sub-command whitelist (`worktree` only as `worktree list`, `config` only as a `--get`/`--get-all`/`--get-regexp` lookup) and refuses write-capable options. A new read sub-command is added to `ALLOWED_SUBCOMMANDS` and to the list in *Security model* in `docs/internals.md`.
- Repository writes use `applyToIndex` for staging and `runGitWrite` for validated operations composed by `worktrees.ts`, `clones.ts` and `workflow.ts`. Workflow operations additionally use local `fetch`, explicit `rebase --onto`, server-generated `apply --index`, recovery `update-ref` and ordinary `commit -m`. Preview/replay uses independent Git repositories with hooks/signing disabled; actual delivery commits use the primary checkout's normal configuration. History apply is a compare-and-swap ref update only after an identical final tree is verified. The explicit write exception outside numbered slots is the reviewer-selected development checkout: prepare there, let the user validate, then commit with its normal hooks and signing. Never use `commit-tree` or bypass hooks for acceptance. No reset or clean belongs to acceptance. New writes get a line in *Security model* in `docs/internals.md`.
- A slot is a linked worktree or a clone of its own (`SlotKind`; clones are the default, for repositories whose tooling breaks on linked worktrees). git lists worktrees; clone slots are found by scanning `<repo>-<n>` in `listWorktreesAll` and recognised by `isCloneOf` (`warden.main` in their config, or a remote URL shared with the main worktree). A clone exchanges no branch with the main worktree: its branches are resolved, compared and deleted inside it, and `resolveRepo` maps a clone back to its main worktree so the CLI and a server started there share the state file. The one network call is `git fetch --all` in a clone on request (`runGitWrite` with `network`, run detached so ssh cannot prompt). Deleting a clone directory (`removeClone`, `discardClone`) is the only filesystem write outside git; keep it limited to a listed clone slot, or to a clone the same request just made.
- Checkpoints write only outside the repository, through `runGitSnapshot` (`add --all [--intent-to-add]`, `write-tree --missing-ok`; called only from `checkpoints.ts`), with `GIT_INDEX_FILE` on a throwaway copy of the index and `GIT_OBJECT_DIRECTORY` on warden's store beside the state file. Never give it alternates: git freshens (touches) objects it finds in one while writing. Reads of a checkpoint pass `snapshot` to `runGit`, which adds the repository's objects as alternates.
- Worktree directories are numbered slots, never named after the branch. Delivered tasks retain their workspace and branch. New checkout requests carry a slot number; adopting a task may name a path only after matching a validated numbered checkout. Active task slots cannot be released or reused by legacy APIs. Workflow and legacy checkout mutations share `StateStore.withRepositoryLock` across HTTP servers and the agent CLI.
- A requirement has an explicit primary development branch. Delivery records persist independently of the workspace. `sourceBase` excludes prior deliveries until explicit rebase. Journal preparation before staging and pin the staged fingerprint and HEAD when committing. Never infer task completion or agent idleness. Connection snapshots and history candidates are journaled beside the state file; preserve unexpected user edits.


## Conventions

- `packages/shared` is raw TypeScript consumed by both server and web. Server, shared, bin and test use explicit `.js` on relative imports (`'./git.js'`); web omits them. `import type` for type-only imports (`verbatimModuleSyntax`).
- API errors: `throw badRequest(msg, code)` / `notFound(...)` / `new HttpError(status, msg, code)` with lower_snake_case codes (`worktree_dirty`, `no_merge_base`); the web branches on `ApiError.code`.
- Comments are prose explaining why, placed above the branch they justify; the codebase leans on them. Keep that style and do not add comments that restate the code.
- Language: code, comments, commit messages and docs in English; user-visible UI strings in Chinese.
- Docs: `README.md` is the front page — install, the review loop in five steps, keyboard, an index — and stays short. `docs/workflow.md` owns the product contract; feature and implementation details live in the other topic files under `docs/` (`reviewing`, `agent`, `worktrees`, `environment`, `internals`, `development`). A behaviour change updates the topic file, and the README only when the loop itself changes. Links between them use the heading anchors, so renaming a heading means fixing its links.
- UI: use the shadcn/ui primitives in `packages/web/src/components/ui` and the neutral theme in `styles.css`. Tailwind v4 is shared by Vite and Storybook. The violet `--feedback` colors are reserved for comments and agent feedback; shadcn's `--accent` and `--muted` are neutral surfaces, with `--muted-foreground` for secondary text. Light theme only for now.
- UI navigation lives in `WorkbenchNav`: preview, history, ordered plan, bottom synchronization/settings. `useWorkbench` owns the content destination; task selection opens review directly. `useWorkbenchData` reads actual Git operation state. Do not reintroduce old global review/orchestration tabs. Task diffs are read-only; comments and viewed marks remain available.
- Commit planning: `workflow.changes` is the task source of truth. A planned task has no checkout, branch or baseline; workspace allocation uses the development baseline. One linear task can produce several deliveries; delivery records associate each reviewed range with its primary commit without a completion gate. Ordering expresses the user's sequence, not a dependency graph; legacy dependency metadata must not become an execution gate. Assignment names label the executor, never imply an agent was launched. Completed legacy checkboxes migrate as archived records, never accepted commits. Keep old titles, bodies and comment links; other branches' notes require explicit import. The review rail is comments only; any follow-up planning is a user action, not agent-driven task decomposition. Never reintroduce a second TODO checklist on task cards.
- "Done" has one mark per kind of target, never two: staging in the local views (`working` / `staged` / `all`), the 已读 mark everywhere else. `tracksViewed` in `packages/shared/src/target.ts` is the switch; the server refuses the mark on a local view (`viewed_not_tracked`). Do not add a viewed / 已读 affordance, count or greyed-out state to the 未暂存 / 已暂存 blocks — the two disagreed whenever both were shown.
- Tests: `makeFixtureRepo()` from `test/fixtures/make-repo.ts` builds an isolated temp repo (`{ root, git, write, cleanup }`); API tests call the Hono app directly with `app.request`.

## Git workflow

- Commit straight to `main`; no branches or PRs. Titles are sentence-case imperative with no prefix (`Make and take down worktrees from the page`); a feature commit carries a body explaining motivation and consequences.
- Every push must be followed through CI for the exact pushed commit. If any job fails, inspect its logs, fix the cause, run the relevant checks, commit and push again, and repeat until the quality checks and the complete Windows, Linux and macOS test matrix all pass. A pending, failed, cancelled or skipped required job does not count as success; an earlier commit's green run does not validate a later push.
- Treat CI follow-up as part of the push task. Do not stop after reporting that CI has started. Report the final validated commit and its successful CI run link only after all required jobs pass.
- Release only on an explicit user request: bump `version` in the root package.json, commit `Release X.Y.Z`, tag `vX.Y.Z`, push main and the tag. The tag runs `.github/workflows/publish.yml`, which publishes to npm through OIDC trusted publishing. Never run `npm publish` locally (`npm whoami` fails here by design); follow both CI and publishing to completion. See [Development](docs/development.md#building-and-testing).
- After editing the web UI, exercise the affected flows in a real browser against a throwaway repository. Follow [UI verification](docs/development.md#ui-verification) and report what was exercised.
