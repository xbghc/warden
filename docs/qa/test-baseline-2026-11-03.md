# Test evidence baseline: 2026-11-03

The existing suites pass at the revision below. Edge-case sufficiency remains **partially audited**.
This baseline records what was executed, which assertions were inspected and what still needs
investigation. It is not a declaration that the current code or all its boundaries are adequately tested.

## Revision and evidence

- Source revision: `5ed1d27767a6558b3bfb6be4a781e0ac30c36450` on `main`.
- The checkout was clean when evidence collection began. The baseline and accompanying contract
  corrections are documentation changes after that revision; they do not change the tested code.
- [Exact-commit CI run 41622298498](https://github.com/xbghc/warden/actions/runs/41622298498)
  started at `2026-11-03T10:48:20Z`; its successful completed status was last updated at
  `2026-11-03T11:12:26Z`.
  All 16 jobs succeeded. Job steps and all seven Vitest JUnit artifacts were inspected.
- This audit reuses that CI evidence. It did not rerun the suites locally or run a new authenticated
  third-party agent session. Existing live acceptance reports are historical evidence with their own
  [environment](live-acceptance-2026-11-01.md) and [follow-up scope](live-acceptance-2026-11-01-follow-up.md).

The checked-in entry points are [Vitest configuration](../../vitest.config.ts),
[CI](../../.github/workflows/ci.yml), [the packaged host launcher](../../scripts/test-vscode.mjs)
and the [development guide](../development.md). CI tests a shared packaged VSIX in the browser
and extension hosts; source-only tests do not substitute for those checks.

| Vitest artifact / environment | Files | Discovered cases | Passed | Skipped | Failures / errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| `tests-ubuntu-22.04-node-20` | 54 | 723 | 723 | 0 | 0 |
| `tests-ubuntu-22.04-node-22` | 54 | 723 | 723 | 0 | 0 |
| `tests-ubuntu-22.04-node-24` | 54 | 723 | 723 | 0 | 0 |
| `tests-ubuntu-22.04-arm-node-22` | 54 | 723 | 723 | 0 | 0 |
| `tests-macos-latest-node-22` | 54 | 723 | 722 | 1 | 0 |
| `tests-macos-15-intel-node-22` | 54 | 723 | 722 | 1 | 0 |
| `tests-windows-latest-node-22` | 54 | 723 | 721 | 2 | 0 |

These are repeated executions of the same inventory, not 5,061 different scenarios. The
[worktree-state tests](../../test/worktree-state.test.ts) account for the skips: raw non-UTF-8
filesystem names are excluded on Windows and conditionally skipped when macOS rejects them;
the POSIX child that ignores `SIGTERM` is excluded on Windows. A skipped case is not a pass.

The same run passed release-version checks, lint, typecheck, extension/webview build, Storybook
build, VSIX packaging and asset checks. Both packaged browser scripts passed. The six packaged
host jobs cover Windows, Linux and macOS on VS Code `1.106.0` and the run's `stable` version;
each ran the focused `tree-refresh` suite and the full native suite. Platform-inapplicable launcher
steps were skipped, while the matching platform steps succeeded. `stable` is a moving selector;
the run, not a future invocation of that selector, identifies this evidence.

Counts establish execution scope. No line/branch coverage or mutation analysis was collected in
this run. The checked-in Vitest configuration and CI do not enable a coverage report. Neither
test counts nor a future coverage percentage alone establish assertion quality or temporal coverage.

## Reviewed behavioral evidence

Each row below names a bounded scenario whose test setup and assertions were read, in addition to
checking its execution evidence. It does not certify the entire module. Relevant contracts are
[workspaces](../worktrees.md), [reviewing](../reviewing.md), [state and security](../internals.md)
and [ACP ownership and recovery](../acp-design.md#ownership-cancellation-and-recovery).

| ID / boundary | Test evidence | Assertions inspected and limits |
| --- | --- | --- |
| B01: Preview conflict and replacement | [shared-preview](../../test/shared-preview.test.ts), `publishes dirty primary and task content through a shared preview and preserves its last coherent version` | A conflicting new connection preserves the old selection and preview bytes, primary HEAD/refs/index and a task index. A redirected preview Git pointer produces stale/error status without changing that task's HEAD/index. This is a controlled sequence, not all possible publication interleavings. |
| B02: Saved-content delivery | [live-delivery](../../test/live-delivery.test.ts), `squashes staged, unstaged, untracked, deleted, renamed and binary content without changing the task checkout` and `rejects saved edits made after review or during composition before touching primary` | Checks delivered bytes, unchanged source HEAD/index/status, a second incremental delivery, immutable review bytes, `review_changed`, unchanged primary and absence of preparation after stale input. Source changes during composition are injected at a known boundary. |
| B03: Commit recovery | [workflow](../../test/workflow.test.ts), `recovers a successful normal commit after a state write failure without rerunning hooks`; [live-delivery](../../test/live-delivery.test.ts), hook-failure and pruned-blob cases | A simulated journal-write failure can be retried without a second commit or hook run. Saved-content deliveries retain the next incremental boundary after hook rejection and object pruning. The journal test uses in-process injection and the committed-source service path; it does not establish abrupt host-death recovery for every delivery path. |
| B04: Task deletion and reuse | [task-deletion](../../test/task-deletion.test.ts), failed-disconnection, edits-during-disconnection and `resumes after release fails, reserves the old slot, and never cleans a replacement checkout` | Failed preview disconnection retains task/source; changed source content is preserved; failed release reserves the allocation. Closing/reopening the Engine and replacing the directory causes retry rejection until the original checkout is restored. These boundaries are exercised separately. |
| B05: State ownership and publication | [state](../../packages/engine/src/state.test.ts), replacement-contention, lost-ownership and `keeps a new repository owner while a second dead-owner reclaimer finishes late` cases | Checks bounded replacement failure, original bytes, cleanup, later retry and one mutation invocation. Ownership loss preserves the replacement owner's state/lock. Controlled concurrent reclaimers retain real unlink/rmdir operations and cannot enter the critical section together. Temporary-file write/sync faults remain in Q01. |
| B06: Rebase safety and recovery | [rebase-safety](../../test/rebase-safety.test.ts), backup failure, changed revisions after backup and `repairs interrupted bookkeeping without rebasing or running hooks a second time` | Backup failure preserves HEAD/index/content and issues no rebase. Changed source/destination revisions after backup reject before rebase. Retrying a simulated bookkeeping failure keeps the rebased HEAD and performs no second rebase/backup. This is not a process-termination test. |
| B07: ACP permissions and uncertain prompts | [acp](../../test/acp.test.ts), pending-permission allocation change, concurrent-task isolation, crash/malformed interruption and late disconnected output cases | Real child agents and wire journals verify offered-option routing, cancellation without file writes, task/cwd isolation, one prompt after interrupted-session initialization and rejection of late output. Allocation rejection is injected in the session test; real binding coverage exists separately. This does not prove termination of agent-owned background commands. |
| B08: ACP startup lifetime | [acp-readiness](../../test/acp-readiness.test.ts), `keeps the initialized ACP connection alive without a prompt until Warden closes it` and protocol/session failure cases | Checks exactly initialize/session-new, cwd, absent client file/terminal tools, live owned process before close and stopped process afterward. Failed negotiation/session creation never enters ready. Authentication and UI behavior need their separate cases. |
| B09: Stale native reads | [review-race](../../test/vscode/review-race.cjs), invoked by [tree-refresh](../../test/vscode/tree-refresh.cjs) | Against the packaged workbench method, a controlled probe verifies a three-attempt limit, unchanged pinned review and abandonment after repository replacement. The native tree suite also holds child reads across a menu-context change and hidden-view restoration; the launcher checks renderer logs for Warden tree errors. Controlled probes are not a systematic exploration of all host callbacks. |
| B10: Git identity, hooks and signing configuration | [git-env](../../packages/engine/src/git-env.test.ts), `preserves normal user configuration, author identity, hooks and signing requirements` | Real Git verifies author/committer, configured hook execution and refusal when required signing cannot start, leaving HEAD unchanged. This is lower-level Git evidence; signed delivery and its recovery through the Engine/host are Q03. |

## Inventory still requiring assertion review

The CI inventory includes the following additional areas. Their presence and passing result do not
promote them to reviewed status. Start with the listed entry points, then trace the current product
path; compatibility APIs and fixture mocks can otherwise hide a missing Engine or host assertion.

| Area | Existing entry points | Initial status |
| --- | --- | --- |
| Allocation, branch following, shutdown and preview ownership | [engine](../../test/engine.test.ts), [workflow](../../test/workflow.test.ts), [workbench](../../test/workbench.test.ts), [branches](../../test/vscode/branches.cjs) | Inventory only beyond the bounded rows above |
| Backup restoration, shallow imports, clones and legacy history | [backups](../../test/backups.test.ts), [shared repository](../../packages/engine/src/shared-repository.test.ts), [clones](../../test/clones.test.ts), [compatibility](../../test/compat) | Inventory only |
| Snapshots, unusual paths, modes, links, submodules and read-only security | [snapshots](../../test/snapshots.test.ts), [workflow reads](../../test/workflow-reads.test.ts), [Git validation](../../packages/engine/src/git.test.ts), [chat file references](../../test/chat-file-reference.test.ts) | Inventory only |
| ACP binding/storage, restoration/configuration, diagnostics and output limits | [binding](../../test/acp-binding.test.ts), [storage](../../test/acp-storage.test.ts), [sessions](../../test/acp.test.ts), [diagnostics](../../test/acp-diagnostics.test.ts), [tool output](../../test/acp-tool-output.test.ts) | Inventory only beyond B07/B08 |
| Settings, drafts, keyboard/IME, themes, permissions and webview bridge | [native Settings](../../test/vscode/settings.cjs), [browser smoke](../../test/ui/smoke.py), [ACP browser smoke](../../test/ui/acp-smoke.py), [shared action validation](../../packages/shared/src/acp.test.ts) | Inventory only; builds and screenshots alone do not verify interaction contracts |
| Query reuse, watchers, queueing and performance | [workflow reads](../../test/workflow-reads.test.ts), [watcher](../../test/watcher.test.ts), [state queue](../../packages/engine/src/worktree-state-queue.test.ts), [Git measurements](../git-reads.md) | Inventory only; no new load or endurance run |

## Open audit queue

Priorities below order audit work; they are not severity claims about reproduced product defects.
No new runtime defect was reproduced in this baseline pass.

| ID / priority | Evidence status and concrete next check | Completion evidence |
| --- | --- | --- |
| Q01 / P1 | **Gap in inspected tests:** state replacement/rename failures are exercised, but explicit failure during temporary-file `writeFile` or `sync` was not found in [state tests](../../packages/engine/src/state.test.ts). [Atomic write](../../packages/engine/src/state.ts) has distinct steps before rename. Inject a partial write/`ENOSPC` and sync/`EIO` failure against an existing state file. | Assert original state bytes remain, the writer's temporary file and ownership are cleaned up, the mutation is not silently replayed and a subsequent independent update succeeds. Preserve real filesystem behavior outside the injected boundary. |
| Q02 / P1 | **Unverified process boundary:** delivery/rebase journal failures are simulated inside the running process; deletion reopens the Engine normally. Establish deterministic child-process termination and restart around Git success versus journal publication, starting with saved-content delivery. | Record the exact stop boundary; restart a fresh Engine and assert commit/hook counts, source and primary bytes/HEAD/index, retained recovery information and explicit retry. A killed process does not establish physical power-loss durability. |
| Q03 / P1 | **Partial evidence:** B10 proves signing configuration reaches normal Git. A successful signed delivery and signer-failure recovery through `task.deliver` were not identified in the inspected delivery/host suites. | Use isolated signing fixtures; verify the final signature and identity, failure retention of the reviewed preparation, and explicit retry without a duplicate commit. No personal keys or login state. |
| Q04 / P1 | **Unreviewed combinations:** B01/B04 separately cover failed preview disconnection, source change and checkout replacement. Audit their ordering around a pending deletion and a fresh task allocation. | Identify existing assertions or add a deterministic combined fixture proving the replacement directory is untouched, the old allocation stays reserved and another task cannot inherit its session or pending operation. Do not assume the combination is missing solely from test names. |
| Q05 / P2 | **Assertion sensitivity unmeasured:** a green suite has not been checked against deliberate violations of the highest-risk guards. Start with a stale-review guard or ownership-token check in an isolated copy. | Show the relevant existing test fails for the intended invariant, not only an unrelated exception; remove the injected defect. Expand only where this exposes weak assertions. |
| Q06 / P2 | **Environment limits:** the CI matrix is local-host coverage. Current authenticated vendor behavior, Remote SSH/WSL/Dev Containers, long-running loads and all theme/accessibility combinations are not established by this run. | Select concrete supported environments and behaviors by risk; retain exact versions, procedures and observed assertions. Keep inapplicable platform cases separate from untested supported behavior. |

### Contract correction found during the audit

At the baseline revision, `workflow.md`, `acp-design.md` and `vscode.md` still described delivery
as requiring committed task content. That contradicted `worktrees.md`, `reviewing.md`, the snapshot
security contract and B02's executed assertions. Those three passages are corrected with this
baseline to describe pinned saved content and direct delivery. Legacy requests without `sourceTree`
still require a clean source, and rebase still requires a clean task checkout; their distinct guards
must not be removed to make new tests pass. See [the security model](../internals.md#security-model).

## Continuing from this baseline

1. Keep this revision and its results as historical evidence. Record a new audit's source revision,
   working-tree changes, date, environments and exact test/CI evidence rather than silently advancing
   this baseline's SHA.
2. Inspect changes since the last audited revision **and** take the next open inventory/queue item.
   During the initial audit, no code change is required to make further progress. Preserve unfinished
   items; a daily diff alone cannot clear the existing coverage debt.
3. For each boundary, record the contract, trigger/interleaving, expected protected state, test name,
   relevant assertions, fixture limitations and observed run result. Distinguish inventory-only,
   reviewed scenario, confirmed coverage gap and reproduced defect. A whole module stays partially
   audited when only some scenarios have been reviewed.
4. Close a queue item with evidence at an exact revision. Finding an existing adequate test can close
   an investigation without adding redundant tests. A reproduced defect needs a regression that
   fails before the fix and passes afterward, using real Git, ACP or packaged host boundaries where
   applicable. Retain remaining limitations and deduplicate subsequent findings by item/invariant.
5. Finish the first audit when every scoped core contract has a scenario and assertion mapping and each
   high-risk unknown has either verified evidence or an explicit unresolved decision. Report remaining
   debt and exclusions even then; passing the existing suite or increasing its count does not satisfy
   this completion criterion.

This document defines an audit starting point. It does not configure a scheduled task.
