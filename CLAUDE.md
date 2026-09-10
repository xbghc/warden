# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm typecheck` runs two separate tsc projects: the root one (bin, packages/shared, packages/server, test; Node lib) and `pnpm --filter @warden/web typecheck` (DOM, JSX). Both must pass.
- `pnpm test` is one vitest config. Unit tests sit beside sources (`packages/*/src/**/*.test.ts`), integration tests in `test/`. Web tests cover only `packages/web/src/lib/**`; there is no jsdom and no component test. One file: `pnpm exec vitest run test/api.test.ts` (add `--reporter=verbose` for names).
- `pnpm build` order is load-bearing: Vite empties `dist/web`, tsup writes `dist/cli.js` with `clean: false`, so web must build before server or the CLI is wiped. `pnpm build:web` alone refreshes what a running server serves from `dist/web`.
- `pnpm dev`: server on 4100 (`tsx watch bin/cli.ts --port 4100 --no-open`) plus Vite on 5173 proxying `/api`.
- `pnpm lint` is Biome (`biome check .`): lint plus formatting, configured in `biome.json` to the house style (single quotes, semicolons, 2-space, trailing commas, 160-column lines). `pnpm exec biome check . --write` applies safe fixes and formats. `noNonNullAssertion` is off on purpose: `x[0]!` under `noUncheckedIndexedAccess` is the idiom here. CI runs lint before typecheck.

## Git access in the server

- Reads go through `runGit` in `packages/server/src/git.ts`, which enforces a sub-command whitelist (`worktree` only as `worktree list`) and refuses write-capable options. A new read sub-command is added to `ALLOWED_SUBCOMMANDS` and to the list in README's *Security model*.
- Writes bypass the whitelist through exactly two functions: `applyToIndex` (`git apply --cached`, staging) and `runGitWrite` (worktree add/remove, `branch -d`; called only from `worktrees.ts`). A new write goes through `runGitWrite` with arguments the server composes from validated values, never a request string, and gets a line in README's *Security model*. Nothing writes to the working tree or HEAD of an existing checkout.

## Conventions

- `packages/shared` is raw TypeScript consumed by both server and web. Server, shared, bin and test use explicit `.js` on relative imports (`'./git.js'`); web omits them. `import type` for type-only imports (`verbatimModuleSyntax`).
- API errors: `throw badRequest(msg, code)` / `notFound(...)` / `new HttpError(status, msg, code)` with lower_snake_case codes (`worktree_dirty`, `no_merge_base`); the web branches on `ApiError.code`.
- Comments are prose explaining why, placed above the branch they justify; the codebase leans on them. Keep that style and do not add comments that restate the code.
- Language: code, comments, commit messages and README in English; user-visible UI strings in Chinese.
- UI: the violet accent (`--accent`) is reserved for comment and agent-feedback affordances; navigation and selection use ink. Light theme only for now.
- UI layout: the sidebar is the only navigation — its three tabs (`Panel`) each fill the left column with the controls for whatever the middle shows, so a new destination adds a tab there, never a control to the top bar. The commit and worktree panels portal their controls into `sideSlot` rather than lifting their state. The rail (comments / 待办 / Issue) is shut unless something put content in it; anything that does must go through `openRail` in the store, since the editor and cards only exist inside it. One figure only — review progress at the top of the sidebar — is set above `--t-ui`.
- Tests: `makeFixtureRepo()` from `test/fixtures/make-repo.ts` builds an isolated temp repo (`{ root, git, write, cleanup }`); API tests call the Hono app directly with `app.request`.

## Git workflow

- Commit straight to `main`; no branches or PRs. Titles are sentence-case imperative with no prefix (`Make and take down worktrees from the page`); a feature commit carries a body explaining motivation and consequences.
- Release: bump `version` in the root package.json, commit `Release X.Y.Z`, tag `vX.Y.Z`, push main and the tag. The tag runs `.github/workflows/publish.yml`, which publishes to npm through OIDC trusted publishing. Never run `npm publish` locally (`npm whoami` fails here by design); check the run with `gh run list --workflow=publish.yml`. `/release` does all of this.
- After editing the web UI, `/ui-check` exercises the built page in a browser against a throwaway repo.
