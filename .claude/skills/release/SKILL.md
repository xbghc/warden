---
name: release
description: Cut a warden release — bump the version, commit `Release X.Y.Z`, tag `vX.Y.Z`, push, and watch the npm publish workflow that the tag triggers. Only for an explicit release request (发版); takes the version as its argument, e.g. `/release 0.9.0`.
disable-model-invocation: true
---

Release version: $ARGUMENTS

Do the steps in order and stop at the first one that fails, reporting what happened and what was left behind.

1. **Version.** If no version was given, ask for one; never guess between patch and minor. It must be `X.Y.Z` and greater than the current `"version"` in the root package.json.
2. **Clean tree.** `git status --short` must print nothing. Uncommitted work is never folded into the release commit: list what is pending and stop. If the user wants it released, commit it first in the house style (sentence-case imperative title, a body with the why, one commit per feature where the files allow) and start over.
3. **In sync.** `git fetch origin` then `git status -sb` must show `main...origin/main` with no `behind`. If main is behind, stop.
4. **Bump.** Change only `"version"` in the root package.json. `git add package.json`, commit with the title `Release X.Y.Z` (plus the usual Co-Authored-By trailer), then `git tag vX.Y.Z`.
5. **Gate.** `pnpm build && pnpm test`. On failure, undo the bump so nothing half-done stays behind: `git tag -d vX.Y.Z && git reset --hard HEAD~1`, then report the failure. Nothing has been pushed at this point.
6. **Push.** `git push origin main vX.Y.Z`.
7. **Publish.** Pushing the tag triggers `.github/workflows/publish.yml`, which publishes `@xbghc/warden` over npm trusted publishing (OIDC). Never run `npm publish` locally; `npm whoami` fails on purpose. Wait for the run — it takes under a minute; use a Monitor/until loop on `gh run list --workflow=publish.yml --limit 1` rather than tight polling — then confirm with `npm view @xbghc/warden version`. On failure, show `gh run view <id> --log-failed`.

Report: the commit and tag, the publish run's result, and the version npm now serves.
