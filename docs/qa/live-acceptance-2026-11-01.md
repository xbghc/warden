# Live acceptance: October 31–November 1, 2026

The authenticated development loop passed after fixing shallow Git imports. Two real Codex task
sessions produced three deliveries in a disposable public repository. The run also found and fixed
unstable native tree identities and horizontally overflowing permission choices. Remaining UX
findings and a native-host warning are recorded below.

## Environment and method

- Linux; packaged Warden 0.20.4; VS Code 1.106.0 extension host.
- Installed `codex-cli 0.166.0` and `@agentclientprotocol/codex-acp 2.5.0`, using the existing local
  login. The inherited model was 6 Astra. No model override was introduced.
- Public repository: [sindresorhus/escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp),
  shallow clone at `a7f7dabaf336bda98d2166848af15d9168b10bcf`.
- Primary: `/tmp/warden-live-20261031/escape-string-regexp`; task workspaces: numbered siblings.
  Warden state, VS Code user data, extension installation and npm cache were isolated under
  `/tmp/warden-live-20261031`.
- Native commands, input boxes, immutable diff documents and delivery ran in the actual packaged
  extension host. Chromium displayed the packaged Task Chat through a temporary loopback test
  bridge to that host's real conversation controller. Prompts and permission choices used the
  rendered controls and the production message-validation boundary.
- There was no native desktop clicking capability. Native interactions were driven through the
  extension-host API; this is not a claim of manual mouse acceptance of a visible desktop window.
  Windows and macOS were not exercised in this local run.
- Existing Warden checkout changes were retained. No Warden commit, push, release or remote
  contribution was made. The Git commits below exist only in the disposable clone.

The first sandboxed launch could not write Codex's own session directory. The isolated host was
then run with approved local execution, keeping the existing login rather than copying credentials.
The initial GitHub clone had a transient TLS failure; its HTTP/1.1 retry succeeded.

## Real feature and deliveries

Task A added the named export `escapeStringRegexpLiteral`, its declarations, AVA and type tests,
and README usage. It escapes literal delimiters and line terminators while retaining the existing
default export. Empty input produces `(?:)` instead of the JavaScript comment token `//`.

Task B added a runnable `examples/search.js` demonstrating literal dynamic search with assertions.
Task A then continued in the same workspace and session to clarify ownership of regexp flags.

| Delivery | Primary commit | Verified scope |
| --- | --- | --- |
| A1 | `67add4d602628c2883325ccfa0aa4abb4044c54e` | Five feature, documentation and test files |
| B1 | `a57d8bcdcf85aaa8198552fbf66da4b0a391bc6d` | Only `examples/search.js` |
| A2 | `2917a6630193605d8df205b5e7edfc959cd7c5b0` | Only the new `readme.md` increment; A1 was excluded |

All three deliveries executed the disposable primary's normal `pre-commit` hook. Primary stayed
clean after each delivery. The A1 agent source commit was absent from primary's object store after
delivery. Both task directories persisted. After explicit rebase, primary and both tasks pointed
to `2917a6630193605d8df205b5e7edfc959cd7c5b0`, with clean working trees and two retained preview
connections.

## Coverage and observed results

| Flow | Result |
| --- | --- |
| ACP startup | Real adapter connected using the existing login; opening Warden did not create a task or send a work prompt |
| Task creation | Native title input allocated separate branches and workspaces for both tasks |
| Agent execution | Real streamed replies, thoughts, commands and file edits stayed associated with their task |
| Feedback and drafts | Preview lint feedback was sent through Task Chat; an unsent follow-up survived a browser reload during the preceding turn |
| Session restoration | Restarting the extension host and reopening Task Chat retained the session ID and the two existing user prompts without replaying them |
| Concurrent sessions | A follow-up in A and work in B ran through separate workspace-bound connections; sidebar and editor presentations were exercised |
| Preview isolation | Task files appeared in the independent preview before delivery; dependencies were installed there, not in task workspaces |
| Real validation | Preview `npm test` passed lint, 10 AVA tests and tsd; `node examples/search.js` printed `Dynamic search example passed` |
| Initial connection conflict | Conflicting saved primary/task edits to `index.js` produced `preview_conflict`; the previous connection set and coherent preview were retained, and B's example did not partially appear |
| Conflict recovery | Restoring those deliberate probe edits allowed both tasks to compose successfully |
| Reversible connections | A temporary uncommitted task file disappeared from preview on disconnect and returned on reconnect; primary stayed unchanged and ignored dependencies remained available |
| Unexpected preview edit | An injected preview-file edit stopped synchronization and was preserved; restoring the exact prior file allowed synchronization to recover |
| Live and committed review | Native read-only diffs opened for live edits and, after repair, all five committed feature files |
| Dirty-source delivery | Rejected before staging primary; recorded below as a late-feedback UX problem |
| Normal and repeated delivery | A1, B1 and A2 committed independently with normal hooks; A2's review contained only `readme.md` |
| Read-only rebase check | All three directories' HEADs and index SHA-256 fingerprints were identical before and after checking |
| Explicit rebase | Both selected workspaces returned `updated`; no automatic rebase was observed |
| Real cancellation | Stop Turn settled a real Codex turn without resending it; no claim is made that cancellation terminates every agent-owned child process |
| Real permission choice | Workspace-access mode exposed Codex's actual permission choices; only `Yes, proceed` was selected, and the disposable marker was written |
| Permission layout retest | A second real permission request used the newly packaged CSS; labels fit at 380 and 280 pixels without horizontal overflow |

The old example repository's development dependencies required Node 22 and a preview-only
`@types/node@14.18.63` pin. Node 25 removed APIs used by its old lint stack, and its old TypeScript
compiler could not parse the latest Node declarations. These are testbed compatibility issues,
not Warden failures. The pin lived in the preview setup command and ignored dependencies; it did
not change repository package manifests or introduce a lockfile.

## Fixed defects

### Shallow imports lost their history boundary

**Impact:** After a real agent commit in a task allocated from a shallow clone, history traversal
failed and review reported `no_merge_base`. The file contents and source commits remained intact,
but the normal review/delivery loop was unusable.

**Cause:** An exact-commit local fetch could copy the object while rejecting its shallow roots
with exit code zero. The existing object-presence shortcut then treated that incomplete import as
usable. Git documents the need for
[`fetch --update-shallow`](https://git-scm.com/docs/git-fetch#Documentation/git-fetch.txt---update-shallow).

**Fix:** Shared imports preserve shallow boundaries. Already-present commits from shallow sources
receive a history-traversal check. A broken older import is fetched with an explicit depth covering
all locally available source history, then checked again. This also repairs commits already held
by task refs, which ordinary refetch negotiation otherwise skips. Primary and task refs are retained.

**Evidence:** Regressions failed before the fix, including a retained-task-ref case. All 12 shared
repository tests now pass, including two deliveries and rebase from a fresh shallow clone. The
same initially broken real clone recovered through Sync Preview and completed all three deliveries.

### Retained native nodes changed identity after navigation

**Impact:** `getTreeItem` calculated IDs from the current repository/base branch, including for
nodes retained from the previous context. The same node could therefore acquire another ID while
VS Code was finishing an asynchronous render.

**Fix:** Published nodes capture their original tree scope. File/folder parents retain it, and
later rendering uses that scope. A packaged-host regression asserts that an old task node's ID
does not change when the base branch changes.

This fixes the identity defect. It does **not** resolve every native tree warning: the separate
remaining warning below still occurred in VS Code 1.106.0 and is not reported as fixed.

### Long permission choices overflowed the sidebar

**Impact:** Codex's real “don't ask again” choice extended past the right edge. The command scope
could not be read in full without horizontal scrolling, despite existing normal whitespace styling.

**Fix:** Permission buttons can shrink, have a maximum width matching their container, and wrap
unbroken command/path text. Agent-provided labels, ordering and option IDs are preserved.

**Evidence:** Added a long-label Storybook state and browser regression at 320×740 and 280×520.
The regression checks each button and the permission region for horizontal overflow and verifies
that all choices and Stop Turn remain reachable. A real Codex permission request was also retested.

| Before | After |
| --- | --- |
| ![Long approval choice overflowing](assets/2026-11-01-permission-before.png) | ![Complete approval choice wrapping inside the sidebar](assets/2026-11-01-permission-after.png) |

## Remaining UI/UX findings

| Priority | Finding and reproduction | Suggested follow-up |
| --- | --- | --- |
| P2 | Commit to Base Branch asks for a message before explaining that task changes must first be committed. Observed against the live uncommitted A1 diff. Git remained untouched. | Validate this prerequisite before opening the message input, with a direct explanation and route back to Task Chat/workspace. |
| P2 | Real permission detail previews show escaped JSON, with the command truncated to two lines. The full payload is available under Details and Workspace, but routine decisions require an extra inspection step. | Present available command and cwd fields as readable text, retaining the original details and explicit agent-provided choices. |
| P2 | Agent replies containing local Markdown file links render the path as text. The B completion reply could not directly open `examples/search.js`; View Task Diff remains available. | Consider a host-validated task-file/diff link action. Do not enable arbitrary file or command URLs in agent Markdown. |
| P3 | A short feature produces many separate tool/thought disclosures, including provider review activity. At sidebar width this makes it harder to find the latest result. | Explore a compact per-turn activity group with full details still available. |

### Remaining native-host warning

The full VS Code 1.106.0 suite still emitted `TreeError [warden.task] Data tree node not found`
during rapid base-branch changes after stable IDs were added. Its stack points to VS Code's
menu-context change callback calling `rerender` on a retained element. The branch, selection,
review and subsequent workflow assertions passed, and the host exited successfully.

This remains an unresolved integration warning. The evidence does not establish that it is purely
an upstream bug or that all visible native states are unaffected. Reproduce against another VS Code
version and investigate context publication/render ordering before closing it. No timeout-based
workaround or suppression was added.

## Verification and artifacts

- `pnpm test`: 47 files, 642 tests passed after the engine and tree changes.
- Shared repository suite: 12 passed, including shallow import repair and the full delivery/rebase regression.
- `pnpm typecheck`, `pnpm lint`, packaging and packaged asset checks passed.
- Full packaged extension-host suite passed; the final chat-focused packaged suite also passed
  after the permission CSS/fixture update. The focused ACP tests passed all 69 cases.
- Both existing browser smoke suites passed; the final ACP suite included the new long permission choices.
- Storybook built successfully with `SidebarLongPermission`.
- Real feature preview checks: lint, 10 AVA tests, tsd and the executable search example passed.

Detailed local evidence is retained under `/tmp/warden-live-20261031`: `before.patch`,
`task-created.json`, `repaired-review.json`, `delivery-one.json`, `delivery-b.json`,
`review-a2.json`, `delivery-a2.json`, `conflicting-connection.json`, `preview-dirty.json`,
`connection-reversal.json`, `readonly-rebase-check.json`, `rebase-result.json`, `final-state.json`, browser artifacts and
verification logs. The temporary `run.cjs`, `host.cjs` and `op.py` are acceptance instrumentation,
not product endpoints. They were not added to the extension. Screenshots of the permission fix
are retained beside this report.
