# AGENTS.md

This file defines repository-wide instructions for coding agents working on Warden.

## Product workflow

`docs/workflow.md` defines the agreed product scope. `docs/design.md` describes the new interaction
design. These take precedence over the transitional implementation descriptions below. The user has authorized implementation of the
new workflow and UI. The new page design was developed
by an independent agent given only the agreed workflow, without reading existing UI/code. Do not
preserve old navigation or state machines merely because the current code contains them.

Warden is a passive tool: users act through it; they do not maintain extra status reports for it.
The user decomposes and orders work, runs agents with their own tools and reviews changes before
squash. Warden creates workspaces and exposes generic creation/reuse hooks; terminal tools, agent
launch, prompt delivery and process control stay outside its product boundary. No dependency
enforcement, scheduling, agent-owned decomposition, ready/idle declarations, task-complete checkbox
or separate requirement approval belongs in the product.

One workspace corresponds to one linear task and can deliver several commits. Keep it available
across deliveries; do not automatically recycle it or ask whether a delivery finishes the task.
The primary development branch (主开发分支) belongs to the requirement, not the repository default
branch. Human code edits happen in the primary directory; agents edit task workspaces. Saved primary
content is the baseline. Dependencies and user-operated tests/dev servers belong in the persistent,
independent preview directory. Default tasks, preview and temporary composition worktrees share
Warden's external bare repository at `<primary>-warden/repo.git`; each has its own files, HEAD and
index. Numbered task paths remain `<primary>-<n>`. The primary Git repository stays separate.
VS Code is the primary integration; ACP is deferred.

Connections are reversible live composition into the independent preview directory, separate from
review and squash. Never write connections into primary or add preview as a VS Code workspace root.
Use native read-only VS Code diffs for task review; no preview-versus-baseline diff is required.
Expose debounced content-based sync state and an explicitly configured idempotent preview setup script. An initial connection conflict must notify the user and fail that connection attempt,
preserving the existing preview. The Web page must support commit-message entry and ordinary Git
commit hooks without requiring terminal use. A development commit must not include other connected
workspaces by accident. After the
primary development branch changes, automatically check and display synchronization conditions;
rebase runs only on the user's request for one, selected or all workspaces. Checks must not change
active workspace files. Clean Git state does not establish agent idleness.

Accepted commit order and messages can be edited in the planned history UI. This is separate from
plan ordering; use stable delivery associations across rewritten SHAs. Do not add history undo,
restore actions or an undo timeline; users adjust the current history again. The backup-branch plus
cherry-pick proposal is the starting point for isolated preview and explicit application.

The working copy implements persistent deliveries, temporary connections, isolated rebase checks
and linear history arrangement. Keep these operations passive. Legacy low-level HTTP endpoints
remain for compatibility; they must not revive readiness gates or automatic recycling in the UI.

## Commands

- `pnpm typecheck` runs three separate tsc projects: the root one (bin, packages/shared, packages/server, test; Node lib) and `pnpm --filter @warden/web typecheck` (DOM, JSX), plus the VS Code extension project. All must pass.
- `pnpm test` is one vitest config. Unit tests sit beside sources (`packages/*/src/**/*.test.ts`), integration tests in `test/`. Web tests cover only `packages/web/src/lib/**`; there is no jsdom and no component test. One file: `pnpm exec vitest run test/api.test.ts` (add `--reporter=verbose` for names).
- `pnpm build` builds the Rust module, then web, then server. Vite empties `dist/web`, tsup writes `dist/cli.js` with `clean: false`, so web must build before server or the CLI is wiped. `pnpm build:web` alone refreshes what a running server serves from `dist/web`. Rust development uses the pinned `rust-toolchain.toml`; `pnpm build:native` rebuilds the module. CI sets `WARDEN_NATIVE=required` so a missing native build cannot silently pass through the compatibility backend.
- `pnpm dev`: server on 4100 (`tsx watch bin/cli.ts --port 4100 --no-open`) plus Vite on 5173 proxying `/api`.
- `pnpm lint` is Biome (`biome check .`): lint plus formatting, configured in `biome.json` to the house style (single quotes, semicolons, 2-space, trailing commas, 160-column lines). `pnpm exec biome check . --write` applies safe fixes and formats. `noNonNullAssertion` is off on purpose: `x[0]!` under `noUncheckedIndexedAccess` is the idiom here. CI runs lint before typecheck.

## Git access in the server

- General reads go through `runGit`/`runGitBuffer` in `packages/server/src/git.ts`, which enforce a sub-command whitelist (`worktree` only as `worktree list`, `config` only as a `--get`/`--get-all`/`--get-regexp` lookup, `var` only for the two attribute-file paths) and refuse write-capable options. Worktree observations use `worktree-state.ts` and the independent Rust core's fixed `status --porcelain=v2 --branch --untracked-files=all --no-ahead-behind -z` operation; it applies the same environment isolation and optional-lock protection. Keep HTTP/Node types out of `warden-core` and Node bindings in `warden-node`. A new read operation is documented in *Security model* in `docs/internals.md`; never add an arbitrary-command interface to the native binding.
- Repository writes use `runGitWrite` for validated operations composed by `worktrees.ts`, `shared-repository.ts`, `clones.ts` and `workflow.ts`. The external shared repository uses fixed bare initialization, ownership configuration, local exact-commit fetches and worktree creation/removal. Workflow operations additionally use explicit `rebase --onto`, server-generated `apply --index`, recovery `update-ref` and ordinary `commit -m`. Preview/replay uses isolated worktrees with hooks/signing disabled only for internal commands; never write those overrides into the shared repository configuration. Actual delivery commits use the primary checkout's normal configuration. History apply is a compare-and-swap ref update only after an identical final tree is verified. The explicit write exception outside numbered slots is the reviewer-selected development checkout: prepare and commit the reviewed version there with its normal hooks and signing; show retained staged contents for recovery. Never use `commit-tree` or bypass hooks for acceptance. No reset or clean belongs to acceptance. New writes get a line in *Security model* in `docs/internals.md`.
- A slot is normally a worktree of Warden's external shared repository (`SlotKind: shared`). Independent clones remain a compatibility option for tooling that cannot use linked worktrees, and legacy primary-linked worktrees remain supported. Git lists both repositories' task worktrees; internal preview/composition worktrees are excluded from the task inventory. Clone slots are found by scanning `<repo>-<n>` in `listWorktreesAll` and recognised by `isCloneOf` (`warden.main` in their config, or a remote URL shared with the main worktree). `resolveRepo` maps shared worktrees and clones back to primary so servers share state and locks. Branch operations use the owning repository. The one network call is `git fetch --all` in a clone on request (`runGitWrite` with `network`, run detached so ssh cannot prompt). Clone directory removal (`removeClone`, `discardClone`) stays limited to a listed clone slot or a clone that the same request just made. The shared repository outlives individual task and preview worktrees.
- Internal snapshots write only outside the repository, through `runGitSnapshot` (`add --all`, `write-tree --missing-ok`; called only from `snapshots.ts`), with `GIT_INDEX_FILE` on a throwaway copy of the index and `GIT_OBJECT_DIRECTORY` on warden's store beside the state file. Never give it alternates: git freshens (touches) objects it finds in one while writing. Reads of a snapshot pass `snapshot` to `runGit`, which adds the repository's objects as alternates.
- Worktree directories are numbered slots, never named after the branch. Delivered tasks retain their workspace and branch. New checkout requests carry a slot number; adopting a task may name a path only after matching a validated numbered checkout. Active task slots cannot be released or reused by legacy APIs. Workflow and legacy checkout mutations share `StateStore.withRepositoryLock` across HTTP servers and the agent CLI.
- A requirement has an explicit primary development branch. Delivery records persist independently of the workspace. `sourceBase` excludes prior deliveries until explicit rebase. Journal preparation before staging and pin the staged fingerprint and HEAD when committing. Never infer task completion or agent idleness. Connection snapshots and history candidates are journaled beside the state file; preserve unexpected user edits.
- The primary repository receives only user-selected final commits. Never import agent source histories or temporary composition commits there for retention or recovery. Keep recovery data outside it, journal operation backups before mutation and retire them after successful bookkeeping. Successful operations retire old generated `refs/warden/changes`, `refs/warden/deliveries` and `refs/warden/history` refs with compare-and-swap deletion; never expire user reflogs or prune their objects automatically. Default shared workspaces and clones isolate source objects from primary; legacy primary-linked worktrees deliberately share primary's object store.


## Conventions

- `packages/shared` is raw TypeScript consumed by both server and web. Server, shared, bin and test use explicit `.js` on relative imports (`'./git.js'`); web omits them. `import type` for type-only imports (`verbatimModuleSyntax`).
- API errors: `throw badRequest(msg, code)` / `notFound(...)` / `new HttpError(status, msg, code)` with lower_snake_case codes (`worktree_dirty`, `no_merge_base`); the web branches on `ApiError.code`.
- Comments are prose explaining why, placed above the branch they justify; the codebase leans on them. Keep that style and do not add comments that restate the code.
- Language: code, comments, commit messages and docs in English; user-visible UI strings in Chinese.
- Docs: `README.md` is the front page — install, the review loop in five steps, keyboard, an index — and stays short. `docs/workflow.md` owns the product contract; feature and implementation details live in the other topic files under `docs/` (`reviewing`, `agent`, `worktrees`, `environment`, `internals`, `development`). A behaviour change updates the topic file, and the README only when the loop itself changes. Links between them use the heading anchors, so renaming a heading means fixing its links.
- UI: use the shadcn/ui primitives in `packages/web/src/components/ui` and the neutral theme in `styles.css`. Tailwind v4 is shared by Vite and Storybook. shadcn's `--accent` and `--muted` are neutral surfaces, with `--muted-foreground` for secondary text. Light theme only for now.
- UI navigation lives in `WorkbenchNav`: preview, history, ordered plan, bottom synchronization/settings. `useWorkbench` owns the content destination; task selection opens review directly. `useWorkbenchData` reads actual Git operation state. Do not reintroduce old global review/orchestration tabs. Task diffs are read-only, with copyable locations. Users must review their entire intended delivery; do not add read markers, progress tracking or review-completion declarations. Inline comments, the review rail and feedback/reply commands have been removed.
- Commit planning: `workflow.changes` is the task source of truth. A planned task has no checkout, branch or baseline; workspace allocation uses the development baseline. One linear task can produce several deliveries; delivery records associate each reviewed range with its primary commit without a completion gate. Ordering expresses the user's sequence, not a dependency graph; legacy dependency metadata must not become an execution gate. Assignment names label the executor, never imply an agent was launched. Completed legacy checkboxes migrate as archived records, never accepted commits. Keep old titles, bodies and opaque historical metadata; other branches' notes require explicit import. Follow-up planning is a user action, not agent-driven task decomposition. Never reintroduce a second TODO checklist on task cards.
- Review uses one complete file list for the current comparison, independent of Git staging. Read-marker controls and the `PUT /api/targets/:key/viewed` endpoint have been removed. Do not restore staging/unstaging controls, selection state, or the removed `POST /api/targets/:key/stage` endpoint. Legacy `working`/`staged` read targets remain for explicit comparisons; local review opens `all`. Formal delivery still uses the primary index and normal commit hooks.
- Tests: `makeFixtureRepo()` from `test/fixtures/make-repo.ts` builds an isolated temp repo (`{ root, git, write, cleanup }`); API tests call the Hono app directly with `app.request`.

## Git workflow

- Commit straight to `main`; no branches or PRs. Titles are sentence-case imperative with no prefix (`Make and take down worktrees from the page`); a feature commit carries a body explaining motivation and consequences.
- Every push must be followed through CI for the exact pushed commit. If any job fails, inspect its logs, fix the cause, run the relevant checks, commit and push again, and repeat until the quality checks and the complete Windows, Linux and macOS test matrix all pass. A pending, failed, cancelled or skipped required job does not count as success; an earlier commit's green run does not validate a later push.
- Treat CI follow-up as part of the push task. Do not stop after reporting that CI has started. Report the final validated commit and its successful CI run link only after all required jobs pass.
- Release only on an explicit user request: set the same `version` in the root and `packages/vscode/package.json`, run `pnpm check:release`, commit `Release X.Y.Z`, tag `vX.Y.Z`, push main and the tag. The tag runs `.github/workflows/publish.yml`, which publishes npm through trusted publishing and the tested VSIX through a GitHub-federated Entra identity. Manual workflow runs only verify Marketplace authentication. Never publish either package locally; follow CI and both registry jobs to completion. See [Development](docs/development.md#building-and-testing).
- After editing the web UI, exercise the affected flows in a real browser against a throwaway repository. Follow [UI verification](docs/development.md#ui-verification) and report what was exercised.
