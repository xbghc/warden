# State and security

Where the review state lives, and what warden will and will not do to the repository.

High-risk operations also create [verified independent backups](backups.md) before changing Git
history or discarding a checkout. These are separate from preview snapshots and ordinary Git reflogs.

## State

`~/.local/share/warden/<sha1(repoRoot)[:12]>/state.json` (respects `XDG_DATA_HOME`). Plain JSON with a
`schemaVersion`, written atomically (temp file, fsync, rename) under a small lock directory so multiple
instances can share it. A permanent `.lock/v2/` container is created with exclusive directory creation;
the `active` directory inside it is published atomically with a uniquely named owner file,
whose token and heartbeat identify its holder. One left by a process that died is taken over after
5 s, a slow holder's is not, and a holder
whose lock was taken over meanwhile writes nothing. A file written by a newer warden is refused
rather than read as empty; one that is not a state file at all is set aside as `.corrupt-<time>`;
top-level fields this version does not know are kept when it writes. `schemaVersion` stays 1: every
warden up to 0.16 replaces a file with any other version by an empty state. Delete the directory to reset. Internal snapshot objects live beside it in `checkpoints/objects`. This historical directory name
is retained because preview and recovery journals can still reference its trees.

Recovery removes only the dead owner's unique file and then the empty `active` directory. A delayed
reclaimer cannot remove a newer owner's nonempty directory, and a crash between these steps leaves
an empty directory that the next contender can remove. Older Warden versions used a plain `.lock`
file. Live legacy owners remain occupied; a confirmed dead legacy owner produces an error naming
the file instead of automatic deletion, since another older writer could replace its contents
between inspection and deletion. Close older Warden windows using that repository, inspect and
remove the named legacy lock file, then retry. Do not remove a live owner's lock.

The outer `.lock` and `v2` directories persist after release. New versions use exclusive directory
creation for the outer path, so Windows directory rename cannot replace a legacy flat lock there.
Before first using this version, close all older Warden windows and processes; upgrade them before
opening them again. An already-running older reclaimer can resume a delayed rename of the old lock
path, and new code cannot prevent it from moving the new container. Once that upgrade is complete,
the permanent container blocks older binaries' ordinary lock acquisition even while the new version
is idle. These containers are protocol metadata,
not stale locks to delete. Unreleased builds that placed owner files directly in `.lock` are
rejected with `legacy_lock_requires_cleanup`; close those builds and inspect that old directory
before removing it. The new version never removes or migrates such an owner automatically.

`targets` retains opaque historical metadata keyed by the exact comparison. Legacy `viewed` maps
are discarded on load and removed on the next state write; empty target records are omitted.
Listing a diff does not update persistent review state.

`workflow.changes` holds requirement plans and their delivery records. Legacy `todos` matching the
requirement or its task branches migrate on load with stable `todo-<id>` IDs; checked notes become
archived plans, never accepted commits. Unrelated notes require explicit import.

Inline comment handling has been removed. Older target fields, linked-note metadata and delivery
review records are retained as opaque historical data on unrelated writes. They are not moved,
reanchored or copied into new deliveries. New comparisons create no target state. User checkpoint records and the `ignoreDebug` preference
are retired on load and removed on the next write. Old checkpoint selections migrate to `all` in
the same workspace. Unrelated historical metadata and internal snapshot objects are retained.

## Security model

Single user, in the VS Code workspace extension host (local, SSH, WSL or container). There is no
production HTTP listener. The internal engine executes Git with argument arrays,
through Node's `execFile` or the Rust core's fixed status operation, without a shell. General
reads go through an argument whitelist (`rev-parse`, `diff`, `show`, `log`,
`worktree list`, `ls-files`, `status`, `merge-base`, `rev-list`, `for-each-ref`, `check-ref-format`,
`grep` without `-O` / `--open-files-in-pager`, and `config` only as `--get`, `--get-all` or
`--get-regexp` of one name or pattern; `var` only for `GIT_ATTR_GLOBAL` and `GIT_ATTR_SYSTEM`)
that refuses option-looking refs and any write-capable
flag; requests that would need anything else receive a structured engine error. The writes are few and each composes its
own arguments. Diff review is read-only: the legacy `POST /api/targets/:key/stage` endpoint and its
partial index-patch writer have been removed. The `PUT /api/targets/:key/viewed` endpoint is also
removed and returns 404.
Formal delivery still prepares the primary index and commits through its validated workflow.
The sole `fsck` read shape is `git fsck --full --no-dangling`, used against independently copied
backup metadata to verify object connectivity before publishing a shared-repository backup. Caller-
supplied flags and the write-capable `--lost-found` form remain forbidden.
`POST /api/worktrees`, `POST /api/worktrees/release` and `POST /api/worktrees/remove` run
`git worktree add`, `git branch`, `git switch`, `git worktree remove` and `git branch -d` with a
branch name git has validated, a ref that resolves, and a slot path the engine composes from a
number — `<repo>-<n>` beside the main worktree; no request names a directory. The working tree and
HEAD of an existing checkout are normally written inside such a slot: `git switch <branch>` into a free
one (detached, clean) when a branch is checked out there, `git switch --detach` when it is released,
and `git reset --hard` plus `git clean -fd` only on the forced release the reviewer confirmed after
a 409. A clone slot (see [Clone slots](worktrees.md#clone-slots)) is made at such a path by
`git clone --local --no-checkout` with `warden.main` set, then `git remote remove` / `add` /
`set-url` / `set-head` with the names and URLs read from the main worktree's config, and a `git fetch`
of the main worktree's remote-tracking branches; after that it is written like any slot, in the
clone, plus a `git fetch --all` there when the checkout asks for one. A clone made for a checkout
that then fails is deleted again, and a clone's directory is deleted
only on a removal the reviewer confirmed after being told what only it holds, and only while it is
still a clone of this repository. Legacy checkout refs change when a branch is made for a checkout (plus its upstream setting when it comes
from a remote) — undone with `branch -D` should the switch into the slot then fail — or deleted on
request after a release or removal (`-d`, so only a merged one), and the review state lives outside
the repository. Internal snapshots write only there: `git add --all` and
`git write-tree --missing-ok`, with `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` set to files in
Warden's data directory and no alternates. Reads add the repository's objects as alternates;
writes must not, because Git can freshen alternate objects. `snapshots.ts` owns these operations.

New clone workspaces copy the primary repository's effective `user.name` and `user.email` with
fixed `git config` writes only when they differ from the clone's inherited defaults. This preserves
repository-local commit identity without overriding matching global defaults.

Default task creation uses `kind: shared`. `shared-repository.ts` owns the separate bare repository
at `<primary>-warden/repo.git`: fixed `git init --bare`, ownership configuration, local fetches of
validated exact commits, and `git worktree add` / `remove` for generated paths. Numbered task paths
stay beside primary. The repository owns task branches and objects; it is never the primary Git
common directory. Repository resolution validates its ownership and maps its task worktrees back to
primary for state and locking. Inventory excludes the bare repository and internal operation
worktrees. Existing `kind: worktree` and `kind: clone` layouts remain supported without migration.
Primary commits are fetched into the shared repository only when absent; worktrees in that repository
can already read each other's objects. Shared initialization preserves the primary commit identity.
Clone refs remain independent, while composition imports the clone commits it needs into the shared
object store. This never imports agent development history into primary.
Internal commands disable hooks/signing through command-local configuration, never by changing the
shared repository's ordinary commit configuration.
Deleting a shared task branch first proves its tip is included in the primary commit or its explicit
upstream. Only then does `update-ref -d <ref> <observed-tip>` remove that exact ref in the external
repository. A squash delivery does not establish ancestry of its source branch; such branches are
retained unless a valid ancestry check permits deletion. Primary refs are never changed by this cleanup.

The independent `warden-core` Rust crate exposes a typed worktree observation, rather than a raw
command API. It executes exactly `git status --porcelain=v2 --branch --untracked-files=all
--no-ahead-behind -z`, returning HEAD, branch, changed-entry count, paths and a hash of the raw
status bytes. It limits concurrent status children to eight and applies a 30-second deadline,
including queue time, plus 256 MiB limits per output stream. Timeout/output-limit failures kill and
reap the direct Git child before returning. Reads set `GIT_OPTIONAL_LOCKS=0`; the real index is not
refreshed. The N-API binding passes the calling Node worker's environment explicitly, and the core
independently removes repository redirection variables. Platforms without a prebuilt module use
the same fixed operation through the guarded Node runner. Both paths hash original bytes; paths
retain the engine's existing UTF-8 representation. Watching repeated edits to a non-UTF-8 filename
still has the existing lossy-path limitation.

Status results are not retained across completed requests: external agents and ordinary Git
commands can change files or metadata without notifying Warden. A watcher obtains status, HEAD
and branch in one observation, and still checks mtime/size of dirty paths to detect further edits.

All Git runners discard inherited repository-location, namespace, index, object-store and temporary
configuration environment variables. `cwd` and explicitly supplied snapshot locations select the
repository; a surrounding Git hook or shell cannot redirect writes into a different repository.
Normal user/system configuration, commit identity, hooks and signing remain enabled.
Release/removal copies the validated checkout and its Git metadata to the external backup directory
before any reset, clean, switch, branch deletion or filesystem removal. An incomplete/failed backup
blocks the mutation. Backup creation copies files without running repository filters or hooks.
Switching branches in a reused slot passes `--no-overwrite-ignore`, so Git refuses to overwrite
ignored local configuration even when status reports the slot clean.

Task notes and ordering write only Warden state. Explicit allocation creates a fresh logical workspace in a validated
numbered workspace from the selected primary baseline, without dependency enforcement.
`workflow.changes[].deliveries` stores stable delivery IDs, source ranges, primary commits and
review records. `sourceBase` distinguishes a delivered source tip from its squash commit.

`GET /workflow/rebase-checks` replays only in isolated worktrees under the state directory's
`operations/`, backed by the external shared repository. Their commands disable hooks and signing.
`POST /workflow/rebase` validates source and
primary HEADs and clean checkout state, then explicitly rebases selected workspaces with
`rebase --no-autostash --onto`. Actual conflicts remain for manual handling. There is no background
rebase or workspace recycling.

Workflow reads share one checkout inventory per request instead of rebuilding every workspace's
inventory for each task. The extension follows observed primary checkout branch changes through
`workflow.configure`, retaining its existing integration and connection guards. Branch changes rotate
the webview session and invalidate review authorization and history/rebase results. History and check
refreshes include the branch identity; the state-only `workflow.context` read rejects mixed snapshots
when another window switches requirements during a refresh. Scoped engine writes verify the expected
development branch after acquiring the repository lock, so a request queued by an old page cannot
mutate a newly selected requirement. ACP conversations keep their task-bound engine context.

Synchronization checks may reuse up to 64 isolated replay verdicts,
including an in-flight trial, when their commits, delivery boundary, physical repository identity,
configuration and environment match. Source HEAD, branch, clean/busy state and target HEAD are
validated again on cache hits. Only successful `ready` or `conflict` verdicts are retained;
operational failures are retried on a later request. Conditional config includes, external merge
or filter behavior, mutable global attributes, and altered-history mechanisms make the check
ineligible for reuse. Git versions without the attribute-path lookups still perform ordinary
isolated checks. This cache does not authorize rebase or change its explicit write-time guards.

Before an actual rebase, Warden rejects ignored local paths that could be overwritten by the target
or intermediate replay commits, creates an independent backup, then rechecks the observed heads
and checkout state. A retry after successful rebase but failed state persistence recognizes an
already-incorporated target and repairs bookkeeping without executing rebase hooks again.

`PUT /preview` and the refresh timer snapshot saved primary content and selected workspaces into
Warden's external snapshot store. Binary patches compose with `apply --index --3way` in a temporary
worktree of the external shared repository. A persistent runtime worktree reads the complete candidate,
checks its previous ownership tree, applies the old/new patch with `apply --index`, and advances its
own detached HEAD and index. Each task has its own HEAD and index. Primary files, HEAD and index are not touched. Ignored runtime dependencies and
caches survive; source files modified outside publication stop synchronization without being discarded.

`connectionPreview.directory` identifies the persistent runtime (validated as an operation directory).
The record journals old/new trees and the candidate worktree before publication. Recovery accepts
a complete old or new tree; ambiguous partial changes remain blocked for manual repair. Complete
publication disposes its temporary candidate worktree; the runtime retains the installed snapshot.
The shared bare repository is persistent and is not removed with a preview or operation worktree. Legacy
standalone runtime repositories remain at their original paths and continue receiving complete
candidates through local fetches. Existing standalone operation journals remain recoverable.
Legacy primary-directory previews migrate only after proving ownership, with a separate migration journal.
Initial conflicts preserve the previous selection; later failures expose stale status. Content hashes
and a debounce window drive per-workspace observed/applied versions, never agent-idleness inference.

`POST /preview/setup` reruns the user's explicit `workspaceConfig.previewSetup`. The same command
runs after initialization or code/config changes, serialized by the repository lock. It receives
preview/primary paths and exposes bounded output and exit status. It may manage ignored environment
files; source mutations make the preview stale. The VS Code workspace extension calls the existing
Hono API in process, registers read-only native review documents, and opens terminals/tasks with the
preview cwd. Workspace Trust is required. It does not add preview to the editor's workspace roots.

`POST /workflow/changes/:id/deliver` validates the message, then prepares and commits under one
repository lock. The client sends its reviewed source, source boundary and primary HEAD. Preparation
records the expected composed index fingerprint; commit checks that fingerprint rather than adopting
a newer index inspection. It preserves the ordinary hooks/signing and recovery journal described below.

`POST /workflow/changes/:id/prepare` remains for recovery and compatibility. It pins a clean source and primary HEAD, composes the undelivered
range in isolation, and stages only that delivery. Existing primary user edits are rejected without
being changed. The independent runtime remains available throughout delivery. `update-index --refresh`
refreshes stat metadata before explicit `apply --index`; preview never refreshes the primary index.
Preparation is journaled first. Interrupted preparation accepts only its known reviewed tree,
preserving other edits.

Only the final binary patch enters the primary index. Neither the agent's source commits nor
temporary composition commits are fetched into the primary repository. Interrupted preparation
compares NUL-delimited raw index changes with the isolated candidate, without importing its tree
or depending on display-only diff configuration.
Preview and delivery patches share the review diff's fixed `a/` and `b/` prefixes, disabled color,
three context lines and short submodule format, with external diff and textconv disabled. Local
and global Git display settings cannot redirect delivered paths or replace the file bytes.

`POST /workflow/changes/:id/accept` checks HEAD and the staged raw-diff fingerprint, then runs
ordinary `git commit -m` in the primary checkout. Identity, signing and Git hooks are preserved.
`record` instead records a user-reviewed manual commit pinned by SHA. Both require a single child
of the prepared parent and clean files. Successful delivery appends a record, preserves the source
workspace and refreshes connections against the new baseline. No `reset`, `clean`, `commit-tree` or hook bypass is used.

History preview uses isolated `cherry-pick` and message amendments. Applying a validated linear
candidate requires the same final tree and original HEAD. Only the selected replacement commit
graph is fetched locally; `update-ref <branch> <new> <old>` publishes it.
An independent filesystem backup is also required before fetching/publishing the candidate.
The real files/index need no change. `historyDraft` journals publication and subsequent delivery-SHA
mapping. The temporary worktree and operation backup are removed after that mapping is durable.
No remote push or user-facing undo/restore operation is provided.

All mutation arguments are composed by the engine; requests cannot supply raw Git commands or
candidate directories. Local fetches use validated repositories and exact object IDs. Source
history stays in the task workspace; delivery records associate it with the final primary commit
without adding retention refs. Successful delivery, synchronization and history publication retire
older versions' exact generated `refs/warden/changes/<id>/{source,accepted}`,
`refs/warden/deliveries/<id>/{source,commit}` and `refs/warden/history/<id>` refs with
`update-ref -d <ref> <observed-old-value>`. Other refs and user reflogs are preserved; ordinary Git
maintenance decides when previously retained, now-unreachable objects can be collected. Default
shared workspaces keep agent objects outside primary and share them with preview and composition.
Clone workspaces retain separate object stores; legacy primary-linked worktrees share the primary
object store by Git's design. Workflow writes share
a cross-process repository-operation lock; short JSON updates have their own lock. Stale-heartbeat
recovery also requires the recorded owner process to be gone. A live owner, incomplete owner record,
or inconclusive liveness check remains occupied, so a delayed heartbeat cannot authorize a second
writer. Contenders have a bounded wait, and state writes still verify their ownership token before
publishing. Git and file checks reduce stale-write risks but do not stop external editors/agents
from writing concurrently.

User-configured workspace hooks are the deliberate shell interface (`/bin/sh -c`, or Git for
Windows' bundled `sh.exe -c`, with cwd/env and bounded output/timeout). They use the same Git
environment isolation as engine Git calls. Warden records hook output and exit status without
interpreting the script as an agent lifecycle. Planning a task does not execute hooks.
Windows shell discovery uses a fixed `git --exec-path` invocation with a five-second timeout and
removes inherited `GIT_EXEC_PATH`; this installation lookup does not read or change the repository.

The webview receives only presentation models. A finite, runtime-validated action union crosses
its message boundary; session tokens reject messages from a previous repository, and each surface
can invoke only its own actions. Scripts and styles are packaged locally with a restrictive content
security policy. The extension requires workspace trust before opening an engine or running actions.
It does not expose arbitrary Git, filesystem or shell execution to a webview. User-configured hooks
and the preview command remain explicit shell entry points.

A separate token-owned preview lease elects one background synchronizer per repository. The existing
repository mutation lock still serializes writes from all windows. Watch notifications are hints;
content fingerprints and periodic reads cover missed events. Closing a session drains in-flight
operations and releases watchers and leases before another repository is opened.

Native read-only review documents are immutable snapshots stored under VS Code extension storage.
Their random URI identities survive editor reloads without re-reading mutable source content. Message
and history drafts use repository-keyed workspace state; Git operation journals stay in the existing
Warden state location. Old HTTP host/origin checks remain only in `test/compat`, which is not bundled.

Updates are managed by VS Code and the Marketplace. There is no npm update request or CLI launcher.
Workspace allocation and preview composition use local Git operations. Legacy clone-fetch code is
retained for regression coverage and is not exposed in the extension's new-workspace form.
