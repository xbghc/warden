# Development

Working on warden itself.

## Building and testing

```sh
pnpm install
pnpm dev          # API server on :4100 (tsx watch) + Vite dev server on :5173 with /api proxied
pnpm test         # vitest: diff parser, staging patches, anchoring, comment scopes, watcher, todos, worktrees, export, state, HTTP API
pnpm typecheck
pnpm build        # dist/web (Vite) + dist/cli.js (tsup, zero runtime dependencies)
node dist/cli.js path/to/repo
```

Layout:

```
bin/cli.ts           argument parsing, start server, open browser
packages/shared      types + target key / comment scope helpers (bundled into both sides)
packages/server      Hono API, git wrapper, diff parser, staging patches, targets, worktrees, anchoring, watcher, state, export, nvim
packages/web         React + Vite UI (shiki highlighting, @tanstack/react-virtual, react-markdown)
test/                API integration tests on a generated git repository
```

Only `dist/`, `README.md`, `LICENSE` and `package.json` are published.

Releasing: bump `version` in the root `package.json`, commit it as `Release X.Y.Z`, tag `vX.Y.Z`, and
push `main` and the tag (`/release` in Claude Code does all of it). Never `npm publish` from a
machine. The `Publish to npm` workflow checks the tag against the version, runs build + tests through
`prepublishOnly`, and publishes over OIDC trusted publishing — no `NPM_TOKEN` secret to store or
rotate. It relies on a trusted publisher configured on the package's npmjs.com settings page (user
`xbghc`, repo `warden`, workflow `publish.yml`), and passes `--provenance` explicitly, because npm's
automatic attestation does not fire through `pnpm publish` (0.2.0 shipped without one). CI runs lint,
typecheck, tests, build and a `publish --dry-run` on every push to `main` and every pull request.

## Storybook

[Browse the hosted Storybook](https://xbghc.github.io/warden/). Every push to `main` builds and deploys it through `.github/workflows/storybook-pages.yml`; the workflow can also be run manually. Repository Settings → Pages must use **GitHub Actions** as the publishing source.

Run `pnpm storybook` for isolated review and layout components at http://127.0.0.1:6006. Stories use in-memory fixtures and include interaction checks. Run `pnpm build:storybook` to build the static preview.

The sidebar uses a view selector for 工作区, 提交历史 and Worktree. The `Layout/Sidebar` stories demonstrate the selector together with each view’s real sidebar controls and content.
