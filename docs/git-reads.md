# Git repository reads

The engine uses TypeScript and the Git CLI for repository operations. Worktree observations use
one fixed status command. Workflow queries share checkout inventories and reuse isolated
synchronization trials only when all relevant inputs remain valid. These optimizations reduce
repeated work without maintaining a second backend or shipping native addons.

## Module boundary

| Module | Responsibility |
| --- | --- |
| `packages/engine/src/git.ts` | Validated Git calls, environment isolation, process/output limits and stable engine errors |
| `packages/engine/src/worktree-state.ts` | Typed worktree observations, fixed status invocation, bounded scheduling and porcelain parsing |
| `packages/engine/src/workflow.ts` | Request-scoped checkout inventories and bounded isolated-replay reuse, alongside existing workflow coordination |

`readWorktreeState(path)` returns optional HEAD and branch, changed-entry count, changed paths,
and a SHA-256 fingerprint of the exact porcelain bytes. An unborn branch has no HEAD; a detached
checkout has no branch. The operation is independent of UI and transport code.

Git runs in asynchronous child processes; TypeScript parses the collected output. Readers in one
JavaScript environment share a FIFO queue limiting concurrent status processes to eight. Status results themselves
are not retained across completed calls, because external editors and Git commands can change
the checkout without passing through Warden. The configured 30-second deadline includes waiting
for a concurrency slot, and each output stream is limited to 256 MiB. Expired waiters are removed
without starting Git; completed and failed reads release their slot. Timeout and output-limit
failures kill the direct child before returning through Node's close callback.

## Why status still uses Git

One fixed command replaces the watcher's three independent reads:

```sh
git status --porcelain=v2 --branch --untracked-files=all --no-ahead-behind -z
```

Git already handles ignore rules, index extensions, partially staged files, submodules, filters,
renames and platform-specific worktree semantics. Keeping that implementation gives us a useful
baseline: measure batching and query organization separately from replacing Git algorithms.
`--no-ahead-behind` avoids computing upstream graph distance for a caller that only needs identity
and dirty state. Untracked files are enumerated individually so further edits inside an untracked
directory remain observable.

The parser consumes NUL records, including the additional source path carried by renames
and copies. A rename contributes one dirty entry. Fingerprints use raw bytes; the engine still
represents filenames as UTF-8 strings, so its existing repeated-edit limitation for non-UTF-8 paths
remains. The watcher also folds in mtime and size, because another edit to an already modified file
can leave Git's porcelain output unchanged.

The guarded Git reader sets `GIT_OPTIONAL_LOCKS=0`, retains ordinary user/system configuration,
and removes inherited repository, index, object-store and temporary config redirection from the
calling Node worker's environment. The status adapter exposes no arbitrary command arguments.
See [Security model](internals.md#security-model) for the
approved reads and existing mutation protections.

## Workflow reads and synchronization checks

Previously, reading N tasks rebuilt the complete workspace inventory N times. Each inventory
itself queried every checkout. `get()` and `rebaseChecks()` now build one map for their request and
look up every task in it. Writes continue to obtain a fresh inventory under the existing repository
lock; a map from a prior response is never mutation authority.

An isolated trial is reusable only when source HEAD, target HEAD, delivery boundary, task/branch
association, physical repository identity, effective configuration and environment match. The
cache belongs to one `WorkflowService`, keeps at most 64 entries and can share an in-flight trial.
The result is a verdict, never a reusable mutable sandbox: trial repositories are disposed before
returning. Only `ready` and `conflict` verdicts survive; an I/O, timeout or other operational failure
does not become a cached conflict.

Each request still reads source HEAD/branch/dirty state and rechecks source identity, unfinished
operations, target HEAD and relevant configuration after obtaining a verdict. Dirty or moved
workspaces cannot inherit an old clean result. The delivery boundary is part of the key even when
both heads remain unchanged, because a previous squash changes which source commits should be
replayed. Returned conflict arrays are copied so a caller cannot mutate the stored verdict.

Cache admission is conservative. Config includes, custom merge/filter/fsmonitor behavior,
relative configuration locations, external attribute files and altered-history features such as shallow boundaries, grafts or
replace refs can introduce inputs not represented by commit IDs. Such repositories continue
performing isolated checks. Older Git versions without the attribute-path lookup also continue
working, without verdict reuse. Changes to configuration or filesystem identity invalidate
eligible results; there is no time-based assumption that an old result is fresh.

The attribute-path lookup follows Git's own system-attributes policy, including an absent system
path when `GIT_ATTR_NOSYSTEM` disables it. Test fixtures explicitly disable system attributes so
Git for Windows' installed defaults do not decide whether a cache-reuse test exercises reuse.
User repositories retain the attribute policy supplied by their environment and configuration.

Checks remain advisory. An actual rebase still requires the user's request and retains its fresh
HEAD checks, clean-state guards, independent backup, repository lock and explicit Git command.
Normal delivery commits retain ordinary Git hooks, identity and signing.

## Reproducible measurements

Install dependencies, then run the synthetic read benchmark:

```sh
pnpm bench:git --workspaces 4 --files 1000 --samples 12 --label typescript-git
```

The script creates disposable linked workspaces and an isolated state directory. It measures:

- Idle watchers for the primary checkout and every task workspace.
- Reading the workflow with all workspaces current.
- Checking synchronization when all workspaces are current.
- The first synchronization trial after source and primary commits diverge.
- Repeated synchronization checks with identical inputs.

Each operation records wall time, process CPU time, and direct Git process starts from Git Trace2.
Git's own child processes are counted separately. Process CPU and peak RSS exclude Git
child-process CPU and memory. Measurements use warm filesystem caches,
include Trace2 overhead and have no preview connections. Run timing comparisons sequentially on
an otherwise idle machine; do not time them alongside compilation or the full test suite.

`--source-root` imports an older source checkout for a real baseline rather than reimplementing
its old behavior inside the benchmark. That checkout needs its dependencies installed. For an
archive without Git metadata, supply `--revision <archived-commit>` and a descriptive `--label`.
Repeat with 1, 4 and 8 workspaces to distinguish fixed costs from repeated-work growth. Compare
equivalent operations and Git process counts before attributing a change to implementation speed.

Use `--operations idle_watchers,workflow_get,sync_current` to narrow a follow-up measurement.

## Historical backend comparison

The [raw observations](benchmarks/git-reads-baseline.json) predate removal of the optional Rust
backend and are retained as historical evidence, not measurements of the current revision. They compare original commit
`d53a18f0a0c04ae4d807d240a4936e39304f4457`, the optimized TypeScript + Git backend,
and the then-available optimized Rust + Git backend. They were collected sequentially in a
Linux x64 container with 8 available CPUs (AMD EPYC 9V74), Node 24.19.0 and Git 2.51.1.
These synthetic linked-worktree measurements establish a local baseline, not a latency promise
for arbitrary repositories, filesystems, clone workspaces or connected previews.

All times below are median milliseconds over 12 samples. Each fixture adds 1,000 tracked files;
N counts task workspaces and excludes the primary checkout. Git starts are direct invocations
per request or complete watcher sweep; Rust and optimized TypeScript have the same counts.

| N | Operation | Original Git CLI | Optimized TypeScript + Git | Rust + Git | Git starts: original → optimized |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Idle watchers | 11.51 | 9.97 | 9.22 | 6 → 2 |
| 1 | Workflow read | 28.20 | 32.68 | 27.93 | 11 → 11 |
| 1 | Already-current check | 40.35 | 39.71 | 32.53 | 12 → 11 |
| 1 | First divergent check | 265.58 | 384.86 | 401.17 | 26 → 36 |
| 1 | Repeated divergent check | 303.33 | 45.95 | 55.80 | 26 → 24 |
| 4 | Idle watchers | 23.77 | 15.99 | 11.48 | 15 → 5 |
| 4 | Workflow read | 175.01 | 53.71 | 54.37 | 101 → 32 |
| 4 | Already-current check | 191.09 | 74.46 | 83.95 | 105 → 32 |
| 4 | First divergent check | 1158.05 | 1054.33 | 1064.07 | 161 → 114 |
| 4 | Repeated divergent check | 1154.00 | 132.51 | 132.09 | 161 → 72 |
| 8 | Idle watchers | 35.92 | 19.65 | 19.33 | 27 → 9 |
| 8 | Workflow read | 511.99 | 86.31 | 100.37 | 361 → 60 |
| 8 | Already-current check | 629.84 | 131.07 | 151.21 | 369 → 60 |
| 8 | First divergent check | 3476.79 | 3099.18 | 3047.99 | 481 → 218 |
| 8 | Repeated divergent check | 3596.40 | 258.22 | 256.52 | 481 → 136 |

The clearest improvements come from doing less work. Every watcher needs one Git process
instead of three. Request-scoped inventory sharing changes the workflow read from quadratic
repeated scans to a linear pass: at eight task workspaces, direct Git starts fall from 361 to 60.
Reusing an eligible unchanged isolated verdict avoids recreating, fetching, checking out and
rebasing a sandbox; the eight-workspace median falls from about 3.60 seconds to 257 ms.

The portable comparison matters. It receives nearly the same gains, and the Rust ordering is
not consistent across operations or repeated runs. In the separate 24-sample follow-up at eight
workspaces, workflow reads measured 94.64 ms in portable mode and 90.02 ms in Rust mode, compared
with 86.31 ms and 100.37 ms in the table. These results do not establish a general speed advantage
from moving that operation to Rust. The removed binding used two I/O workers rather than one per
CPU; it still delegated the repository scan to Git.

There is also an explicit first-check cost: one divergent workspace takes about 266 ms in the
original code and 401 ms with Rust here (about 51% longer), with direct Git starts increasing from
26 to 36. Admission and freshness checks pay extra metadata work before a verdict can be reused.
The repeated check falls to about 56 ms, so persistent polling benefits after the first check.
At larger workspace counts, removing repeated inventories also offsets the initial validation
cost. Cold in this benchmark means a new service without verdicts; filesystem caches remain warm.

Verdict reuse applies only to the conservative configuration subset described above. Config
includes, global LFS/filter settings, custom merge behavior, external attributes and the other
exclusions continue to run isolated trials. The inventory and watcher improvements still apply.
Raw results include every sample, empirical p95, current-process CPU and peak RSS. With only 12
samples, empirical p95 is effectively the maximum and should not be treated as a production tail
latency estimate. Child-process CPU and memory are not measured, so these results do not establish
a reduction in total CPU or total memory.

## Further optimization

Diff generation, preview composition, snapshots, delivery, explicit rebase and history replay
use TypeScript coordination and validated Git commands. Their safety and recovery contracts
remain independent of read-performance optimization.

The next performance decisions should measure unchanged connected previews, large diffs and
object reads. Batching or a persistent `git cat-file` process can be evaluated per operation
behind typed interfaces. Changes must preserve tested semantics and outperform the organized
CLI baseline on representative inputs. State persistence and mutations must retain the existing
cross-process lock, ownership checks, backups and recovery journal.

For platform testing and release artifact verification, see
[Development](development.md#building-and-testing).
