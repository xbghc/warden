# Rust repository core

The first migration extracts worktree observations into an independent Rust library. It also
removes repeated checkout inventories from workflow queries and reuses isolated synchronization
trials when all their relevant inputs remain valid. The goal is lower repeated work and a reusable
core, with Git implementation choices made per operation and supported by measurements.

## Module boundary

| Module | Responsibility |
| --- | --- |
| `crates/warden-core` | Typed repository operations and errors, fixed Git status invocation, environment isolation, process/output limits, byte-level parsing |
| `crates/warden-node` | Asynchronous N-API conversion between owned Rust values and JavaScript values |
| `packages/server/src/worktree-state.ts` | Server adapter, HTTP error mapping and equivalent portable backend |
| `packages/server/src/native.ts` | Loading the correct prebuilt binary, with explicit required/disabled modes |
| `packages/server/src/workflow.ts` | Request-scoped checkout inventories and bounded isolated-replay reuse, alongside existing workflow coordination |

The core has no dependency on Node, Hono, HTTP status codes, Warden's JSON state store, or the web
application. Another Rust program can depend on `warden-core` directly and call
`read_worktree_state(path, GitReadOptions::default()).await` from a Tokio runtime. Its public model
contains optional HEAD and branch, changed-entry count, changed paths, and a SHA-256 fingerprint
of the exact porcelain bytes. An unborn branch has no HEAD; a detached checkout has no branch.

The Node module remains loaded for the life of the server. Its async functions use Tokio for child
processes and pipes; they do not block the JavaScript event loop or occupy libuv workers while
waiting for Git. The core limits concurrent status processes to eight. Status results themselves
are not retained across completed calls, because external editors and Git commands can change
the checkout without passing through Warden. The configured 30-second deadline includes waiting
for a concurrency slot, and each output stream is limited to 256 MiB.

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

The Rust parser consumes NUL records, including the additional source path carried by renames
and copies. A rename contributes one dirty entry. Fingerprints use raw bytes; the server still
represents filenames as UTF-8 strings, so its existing repeated-edit limitation for non-UTF-8 paths
remains. The watcher also folds in mtime and size, because another edit to an already modified file
can leave Git's porcelain output unchanged.

Both backends set `GIT_OPTIONAL_LOCKS=0`, retain ordinary user/system configuration, and remove
inherited repository, index, object-store and temporary config redirection. A Node worker passes
its own environment explicitly; Rust's process environment is not a substitute for that snapshot.
The binding has no raw-command API. See [Security model](internals.md#security-model) for the
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

Checks remain advisory. An actual rebase still requires the user's request and retains its fresh
HEAD checks, clean-state guards, independent backup, repository lock and explicit Git command.
Normal delivery commits retain ordinary Git hooks, identity and signing.

## Reproducible measurements

Build the native module, then run the synthetic read benchmark:

```sh
pnpm build:native
WARDEN_NATIVE=required pnpm bench:git --workspaces 4 --files 1000 --samples 12 --label rust
WARDEN_NATIVE=disabled pnpm bench:git --workspaces 4 --files 1000 --samples 12 --label portable
```

The script creates disposable linked workspaces and an isolated state directory. It measures:

- Idle watchers for the primary checkout and every task workspace.
- Reading the workflow with all workspaces current.
- Checking synchronization when all workspaces are current.
- The first synchronization trial after source and primary commits diverge.
- Repeated synchronization checks with identical inputs.

Each operation records wall time, process CPU time, and direct Git process starts from Git Trace2.
Git's own child processes are counted separately. Node CPU and peak RSS include the Rust binding
in process but exclude Git child-process CPU and memory. Measurements use warm filesystem caches,
include Trace2 overhead and have no preview connections. Run timing comparisons sequentially on
an otherwise idle machine; do not time them alongside compilation or the full test suite.

`--source-root` imports an older source checkout for a real baseline rather than reimplementing
its old behavior inside the benchmark. That checkout needs its dependencies installed. For an
archive without Git metadata, supply `--revision <archived-commit>` and a descriptive `--label`.
Repeat with 1, 4 and 8 workspaces to distinguish fixed costs from repeated-work growth. Keep the
portable comparison: an improvement shared by portable and Rust paths comes from reorganizing
the operation, not from Rust alone.

Use `--operations idle_watchers,workflow_get,sync_current` to narrow a follow-up measurement.

## Initial measurements

The [raw observations](benchmarks/rust-reads.json) compare original commit
`d53a18f0a0c04ae4d807d240a4936e39304f4457`, the optimized TypeScript + Git backend,
and the optimized Rust + Git backend in this change. They were collected sequentially in a
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
from moving the current operation to Rust. The binding uses two I/O workers rather than one per
CPU; it still delegates the repository scan to Git.

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

## Remaining migration

This boundary covers worktree observations and their first server consumers. Diff generation,
preview composition, snapshots, delivery, explicit rebase and history replay still use their
existing coordination modules and Git commands. They are separate migration candidates; none is
silently routed through a partially compatible native Git implementation.

The next performance decisions should measure unchanged connected previews, large diffs and
object reads. A native Git library such as `gix`, a persistent `git cat-file` process, or the current
CLI can be chosen per operation behind typed interfaces. A library change should preserve the
operation's tested semantics and outperform the organized CLI baseline on representative inputs.
Moving state persistence or mutations also requires retaining the existing cross-process lock,
ownership checks, backups and recovery journal; it is not implied by moving read parsing to Rust.

For build targets, required native testing and release artifact collection, see
[Development](development.md#building-and-testing).
