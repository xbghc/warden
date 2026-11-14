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
5 s, as is one whose heartbeat predates the last boot of this host whatever now holds its process
ID; a slow holder's is not, and a holder
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

Windows can report a directory publication collision as `EPERM` or `EACCES`, even if the other
owner releases before inspection. Publication retries within the same wait budget; only a successful
atomic rename grants ownership. Persistent permission failures with no competing owner retain their
original error, and uncertain live owners are never reclaimed.

Replacing the state JSON also retries short `EPERM`, `EACCES` and `EBUSY` failures with a bounded
backoff. Each attempt rechecks the ownership token and reuses the same fsynced temporary snapshot;
the mutation callback runs once. The previous state remains intact if replacement keeps failing,
and only the writer's own temporary file is removed. Publication never unlinks the current state.

Requested engine writes wait for that engine's active preview tick before entering the repository
lock wait. Further ticks pause while such writes are pending, so a slow local composition cannot
consume their cross-window wait budget. Reads remain available, and another window's ownership
still uses the ordinary bounded lock wait.

Conversation engines start with state-only observation to receive task deletion notifications.
They watch the state directory and retain periodic state reads, but do not watch repository checkouts,
acquire the preview-owner lease or run preview synchronization. Reopening or replacing the workbench
therefore leaves preview ownership with its repository observer, rather than a retained chat engine
whose background writes could exhaust the workbench's repository-lock wait.
Concurrent starts share the first initialization and its observation scope. Closing drains pending
initialization as well as notifications, so a late startup cannot replace callbacks or outlive shutdown.

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
`workflow.trackedBranches` retains explicitly selected base branches, including empty ones. Older state
derives this list from task branches on load, persisting it on the next write. Its selected branch alone
does not prove explicit tracking because older builds followed every checkout; empty legacy branches
require explicit selection once.

Inline comment handling has been removed. Older target fields, linked-note metadata and delivery
review records are retained as opaque historical data on unrelated writes. They are not moved,
reanchored or copied into new deliveries. New comparisons create no target state. User checkpoint records and the `ignoreDebug` preference
are retired on load and removed on the next write. Old checkpoint selections migrate to `all` in
the same workspace. Unrelated historical metadata and internal snapshot objects are retained.

## Security model

Local diagnostics use an optional host-provided sink; the extension routes it to VS Code's native
Warden log channel. Engine records contain operation names, timings, outcomes and stable error codes,
without serializing operation inputs or results. ACP adds connection/request metadata and bounded,
redacted failure details/stderr. Logging observes existing operations and adds no Git reads, writes,
network requests or repository state files. See [Diagnostic logs](development.md#diagnostic-logs)
for levels, correlation fields and the limits of redacting agent-provided free-form text.

Native Settings uses a TreeView and VS Code inputs, pickers and text editors. Setup scripts are
virtual `warden-script` documents registered only when opened from Settings. Their host-owned bindings
pin repository, session, script kind and original configuration. Save rereads `workflow.get`, rejects
stale bindings and script changes, and writes through `config.save`, preserving unrelated fields.
The editor supplies an expected configuration; `config.save` compares it under the repository/state
write locks and rejects a concurrent update with `config_changed` before writing. Existing callers
without an expected configuration retain their explicit full-configuration save behavior.
Unknown URIs, renames, directory creation and deletion are rejected. The editor adds no Git writes or direct shell
execution; preview setup retains its existing automatic configuration-change trigger. Agent profiles still use only User or
Remote User settings. Legacy webview settings navigation reveals the same native Settings view.
Named ACP objects and legacy profile arrays pass through the same executable, argument and environment
validation. Object keys become stable profile IDs, not paths or commands. Unknown client-specific
options in named entries are rejected. Preset saves retain the existing settings shape and entries.
The custom-agent example is a bundled JSON document; opening it neither changes profiles nor starts
a connection. There are no additional Git operations or workspace configuration sources.

The workbench ACP connection is separate from Engine Git operations. In a trusted workspace, startup
and changes to User or Remote User profiles automatically launch a validated profile in the primary
folder (or the first workspace folder before repository selection). The last successfully selected
profile ID is kept in extension global state; if it is absent, the first configured profile is used.
No executable or credential is stored there. The client negotiates ACP and requests an empty session,
with no filesystem or terminal capabilities, no work prompt and cancelled startup permission requests.
Authentication is explicit and uses only methods advertised by that connection. Startup creates no
Warden task, workspace or conversation record, and issues no Git or preview command.

The stdio connection remains open after initialization. Disconnect, failure, replacement and shutdown
close its stream and terminate the owned process, escalating from SIGTERM to SIGKILL after a bounded
wait. Pending connection attempts and authentication pickers are cancelled; stale results cannot unlock
the workbench. Settings edits are coalesced and failures do not trigger a restart loop. Task connections
are separately closed on shutdown, even if cleanup of the workbench connection reports an error.
Agent-owned tools, login data, empty-session records and the child commands of a running agent remain the
agent's responsibility; after stopping an agent, Warden stops the [processes it left behind](acp-design.md).
Availability is window-local and is not stored as a persistent readiness flag. Task connections retain
their own workspace cwd and start when the user opens Task Chat or sends a message. Workbench refreshes
prewarm only the read-only conversation Engine and single-checkout binding resolution (`inspectTaskWorktree`);
startup alone never opens a task session, claims session ownership or replays an uncertain prompt.

Task environment instructions use only the existing validated allocation's primary/workspace paths,
task branch and base branch. Values are JSON-quoted data; user task text and executable configuration
are not promoted into system instructions. The task connection opts into the SDK's unstable v1
system prompt field only after the agent advertises support, using append mode on creation and loading.
Unsupported agents receive labelled user-level context with actual user prompts. Rejected instructions
are not silently dropped or retried. Routine diagnostics log only the selected delivery mechanism.
The base branch comes from the current allocation and is not persisted; the saved allocation identity
already hashes it, so a changed base branch fails the identity check. This uses existing binding reads and adds no
Git writes or permission grants. Bindings are revalidated after session setup and before sending a
persisted pending prompt.

Task Chat stores a confirmed model selection as bounded option/value IDs in its existing external
conversation record and in a separate extension-global key for the profile signature. The signature
contains no environment values. Other task defaults cannot override a resumed conversation's saved
choice. Restoration revalidates the task binding and current advertised model options before an ACP
configuration request; it sends no prompt, performs no Git operation, and does not persist or restore
agent permission modes. Unavailable choices are skipped and timed-out restorations retire their
connection. Stored model preferences never become executable profile settings.

Single user, in the VS Code workspace extension host (local, SSH, WSL or container). There is no
production HTTP listener. The internal engine executes Git with argument arrays,
through Node's `execFile`, without a shell. General
reads go through an argument whitelist (`rev-parse`, `diff`, `show`, `log`,
`worktree list`, `ls-files`, `ls-tree`, `status`, `merge-base`, `rev-list`, `for-each-ref`, `check-ref-format`,
`grep` without `-O` / `--open-files-in-pager`, and `config` only as `--get`, `--get-all` or
`--get-regexp` of one name or pattern; `var` only for `GIT_ATTR_GLOBAL` and `GIT_ATTR_SYSTEM`)
that refuses option-looking refs and any write-capable
flag; requests that would need anything else receive a structured engine error. The writes are few and each composes its
own arguments. Diff review is read-only: the legacy `POST /api/targets/:key/stage` endpoint and its
partial index-patch writer have been removed. The `PUT /api/targets/:key/viewed` endpoint is also
removed and returns 404.
The read-only `repository.get` command composes existing workflow, preview and workspace readers,
sharing a detailed checkout inventory only within that observation. It introduces no additional
Git command shapes or writes. Background rebase checks keep fresh reads; their results are accepted
only for the current repository, task binding and observed version. Actual mutations never use a
UI observation as authority and retain their repository locks and fresh validation.
The read-only `repository.readRoots` command observes primary, currently allocated task checkouts and
the validated persistent preview. It reuses the guarded inventory, `rev-parse --absolute-git-dir` and
preview ownership checks, plus filesystem identity reads; it introduces no Git writes. Deleting,
unassigned, foreign or redirected workspaces and invalid previews are excluded. ACP reads check this
scope twice around task-binding validation and compare root/allocation and resolved file identities.
Registered parent-directory aliases, including macOS `/var`, retain their canonical identity; a
symlink replacing the checkout itself or a file escaping that canonical root remains ineligible.
Only explicit regular-file reads qualify; directory/search/command requests, sensitive path names and
hardlinks remain interactive. This is an approval policy for agent-reported operations, not a sandbox
or an atomic filesystem lease. Agents remain responsible for executing only the approved operation
and asking again if its resolved target changes. Policy changes during validation revoke automatic approval.
Formal delivery still prepares the primary index and commits through its validated workflow.
Review reads `ls-tree -z <revision> -- <literal-path>` to identify submodule gitlinks without loading
their commits from the parent repository; index comparisons use the existing `ls-files --stage` read.
Blob reads use `git show <revision>:<path> --` so Git never tests the version-qualified name as a
competing filesystem path, which can exceed path limits before the actual filename does.
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
`git clone --local --no-checkout` with `warden.main` set and `maintenance.autoDetach` and
`gc.autoDetach` off, repeated up to three times when git reports that a source object vanished
while it was being linked (maintenance in the main worktree's repository packed it meanwhile), then `git remote remove` / `add` /
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
writes must not, because Git can freshen alternate objects. Before capture, `ls-files --stage -z`
reads the copied index and `ls-files --modified -z` identifies files Git may rehash without source
object access. Their indexed blobs and indexed `.gitattributes` blobs are read with `show` and
copied into Warden's object store with `hash-object -w --no-filters` from a private temporary file.
Existing copies are reused. This preserves Git's automatic CRLF handling and attribute fallback
without freshening loose or packed source objects. `snapshots.ts` owns these operations.
For split indexes, it copies the referenced shared index into disposable private Git metadata and
runs only `git update-index --no-split-index` there before capturing content. Source shared indexes
are never passed to Git during that expansion, because even reading one refreshes its timestamp.
Snapshot commands disable split-index creation, filesystem-monitor shortcuts and index-change hooks;
the final `add` still uses the source repository's attributes, filters and ignore rules.

New clone workspaces receive the local Git setup a primary-linked worktree would share. A
`git config --null --get-regexp` read in each repository resolves a fixed set of keys: `user.name`,
`user.email`, `user.signingkey`, `commit.gpgsign`, `tag.gpgsign`, `gpg.*`, `core.autocrlf`,
`core.eol`, `core.safecrlf`, `core.hooksPath` and `filter.*.*`, `merge.*.*` and `diff.*.*` drivers. Keys
whose values differ from the clone's inherited ones are written with `git config --replace-all` /
`--add`, so local values and path-conditional includes carry over while matching global defaults stay
unpinned. Remotes, credentials, URL rewrites and repository-relative paths such as
`commit.template` are not copied. Warden also copies primary's `info/exclude`, `info/attributes` and,
unless `core.hooksPath` is set, the non-sample entries in its default hooks directory into the new
clone's `.git`, following symlinks. These are file copies made once at creation; a relative or
external `core.hooksPath` stays live through the copied setting.

Default task creation uses `kind: clone`; `kind: shared` remains available internally. `shared-repository.ts` owns the separate bare repository
at `<primary>-warden/repo.git`: fixed `git init --bare`, ownership configuration, local fetches of
validated exact commits, and `git worktree add` / `remove` for generated paths. Numbered task paths
stay beside primary. The repository owns task branches and objects; it is never the primary Git
common directory. Repository resolution validates its ownership and maps its task worktrees back to
primary for state and locking. Inventory excludes the bare repository and internal operation
worktrees. Existing `kind: worktree` and `kind: clone` layouts remain supported without migration.
Legacy primary-linked worktrees also validate their private Git directory and its `gitdir` backlink
against the selected checkout. Sharing a common Git directory alone does not authorize a write:
a copied `.git` pointer to another task is rejected, including after a previously valid rebase check.
Validation reads `rev-parse --show-toplevel --git-common-dir --absolute-git-dir` through the existing
Git reader, then inspects the `.git` file, private metadata directory and `gitdir` backlink with
filesystem metadata/content reads. Symlinked registrations and backlinks are refused.
Product inventory reads retain dirty-state, ownership and unfinished-operation checks, but omit
the retired management page's upstream comparisons and free-slot branch lists. The test-only HTTP
adapter adds those fields with the same validated Git reader; no new Git write path is introduced.
Primary commits are fetched into the shared repository when absent; worktrees in that repository
can already read each other's objects. Imports use `fetch --update-shallow` to retain the source's
shallow history boundary without fetching from a remote or changing primary. Source validation combines
`rev-parse --is-shallow-repository --verify <sha>^{commit}`. For an already present commit from a shallow
source, `rev-list --count <sha>` verifies that its history is traversable; a failed traversal retries the
same local fetch to repair older imports that omitted the boundary, including commits already held by
task refs. Repair counts the source's available commits with `rev-list --count <sha>` and requests an
explicit depth one greater than that count, preserving all available local history while forcing Git
to update its shallow boundary. It verifies traversal again afterward. Full sources retain the object-presence
shortcut. Git owns updates to the external repository's `shallow` file; Warden does not rewrite it directly.
Shared initialization preserves the primary commit identity.
Clone refs remain independent, while composition imports the clone commits it needs into the shared
object store. This never imports agent development history into primary.
Internal commands disable hooks/signing through command-local configuration, never by changing the
shared repository's ordinary commit configuration. Internal patch application and its index refresh
use the same isolation; staging the real delivery in primary retains its normal index and commit hooks.
Deleting a shared task branch first proves its tip is included in the primary commit or its explicit
upstream. Only then does `update-ref -d <ref> <observed-tip>` remove that exact ref in the external
repository. A squash delivery does not establish ancestry of its source branch; such branches are
retained unless a valid ancestry check permits deletion. Primary refs are never changed by this cleanup.

The TypeScript worktree-state adapter exposes a typed observation and uses the guarded Git reader
to execute exactly `git status --porcelain=v2 --branch --untracked-files=all
--no-ahead-behind -z`, returning HEAD, branch, changed-entry count, paths and a hash of the raw
status bytes. Readers in the same JavaScript environment share an eight-child concurrency limit
and a 30-second deadline, including queue time. Expired queued reads never spawn Git. The guarded
reader limits each output stream to 256 MiB and kills the direct Git child on timeout or overflow,
waiting for its close callback before returning. Overflow is `git_failed`, distinct from `git_timeout`.
After `ENOENT` or `ENOTDIR` spawn failures, both Git runners inspect the working directory's type.
Missing or non-directory paths return `unknown_worktree`; an existing directory retains `git_missing`.
This metadata read runs only on failure and does not change repository content or relax path validation.
Reads set `GIT_OPTIONAL_LOCKS=0`; the real index is not refreshed. Child processes use the calling
Node worker's environment with repository redirection removed. Status fingerprints hash original bytes; paths
retain the engine's existing UTF-8 representation. Watching repeated edits to a non-UTF-8 filename
still has the existing lossy-path limitation.

Status results are not retained across completed requests: external agents and ordinary Git
commands can change files or metadata without notifying Warden. A watcher obtains status, HEAD
and branch in one observation, and still checks mtime/size of dirty paths to detect further edits.

All Git runners discard inherited repository-location, namespace, index, object-store and temporary
configuration environment variables. `cwd` and explicitly supplied snapshot locations select the
repository; a surrounding Git hook or shell cannot redirect writes into a different repository.
Normal user/system configuration, commit identity, hooks and signing remain enabled.
Legacy slot release/removal copies the validated checkout and its Git metadata to the external backup directory
before any reset, clean, switch, branch deletion or filesystem removal. An incomplete/failed backup
blocks the mutation. Backup creation copies files without running repository filters or hooks.
Switching branches in a reused slot passes `--no-overwrite-ignore`, so Git refuses to overwrite
ignored local configuration even when status reports the slot clean.

Task creation saves its plan and allocates a fresh logical workspace under one repository lock,
using the existing validated numbered-path and shared-repository Git writes. Allocation selects
the current requirement baseline without dependency enforcement. Renaming and ordering write only
Warden state. Tasks store a title only; `body` and `acceptance` values saved by earlier versions stay
in the state file untouched but are no longer read, shown or written, and legacy checklist imports
keep their old description as unread `legacyTodo.body` data. A pre-assignment failure persists `workspaceError` on the saved task; a retry keeps its
ID and clears the error after successful assignment. When an interrupted allocation already checked out
the task's own `warden/change-<id>` branch in an unassigned, clean numbered workspace, the retry
resumes that workspace instead of failing because the branch is in use. Assigned workspaces are never replaced on retry.
Legacy plan creation remains only for imports and the compatibility adapter; desktop task use
prepares these plans explicitly, without allocating from a background read.
`workflow.changes[].deliveries` stores stable delivery IDs, source ranges, primary commits and
review records. `sourceBase` distinguishes a delivered source tip from its squash commit.

`task.deleteCheck` reads task/allocation identity, Git HEAD and branch tip, index entries, status,
ignored paths and changed-file bytes to produce a confirmation fingerprint without snapshotting
contents. `task.delete` rechecks it under the repository lock. A task connection's existing metadata
lock serializes connection acquisition with publishing `deletion`; new claims revalidate the task
inside that lock. Live or uncertain owners block deletion. Session record writes also reject deleted
or deleting tasks. The journal reserves the physical allocation throughout failures and restart.

Deletion first publishes preview without the task, using preview's existing recovery journal. It
then validates the checkout again, quits any stopped Git operation, runs `git clean -fd` under the
original ignore rules, detaches the exact observed HEAD with `update-ref --no-deref`, and runs
`reset --hard` at that same commit. It never uses `clean -x`, recursively deletes the workspace folder,
or creates a backup. Submodules and ignored-file collisions are rejected. Branch removal is limited
to allocation-proven ownership, no other registered checkout, and compare-and-delete of the observed
tip via `update-ref -d`; unknown ownership retains the branch. Missing directories permit only exact
stale `worktree remove --force` registration cleanup. No primary code, index or base-branch ref is changed.

The task's local conversation files are removed only after validating their repository/task binding
and hashed filenames; redirected archive directories are refused. Unrelated records and external
agent history remain. Successful deletion atomically replaces the active task with minimal identity
and delivery associations in `deletedTasks`, supporting idempotent completion and history mapping.
No notes or file contents are retained there. A failure keeps `deletion.error` and a native retry
action; startup never automatically repeats cleanup. Git checks do not stop external writers.

`GET /workflow/rebase-checks` replays only in isolated worktrees under the state directory's
`operations/`, backed by the external shared repository. Their commands disable hooks and signing.
`POST /workflow/rebase` validates source and
primary HEADs and clean checkout state, then explicitly rebases selected workspaces with
`rebase --no-autostash --onto`. Actual conflicts from an explicit request remain for manual handling.
A request marked `automatic` comes only from the host's automatic rebase of idle workspaces. The host
reserves local conversation activity before queuing the request. Under the repository lock, each
automatic replay also holds the task's existing connection metadata lock until Git finishes. A live
owner is accepted only with the reserved connection token from the same host process and hostname;
foreign, missing or replaced claims cannot inherit that authorization. An unclaimed task can rebase
while this metadata lock prevents a new connection claim. Tokens are internal and are not accepted
by the webview action parser. Explicit user rebase retains its existing coordination contract. When an
automatic replay stops at a conflict, the engine runs `rebase --abort` in that workspace and accepts the undo
only if HEAD is the recorded pre-rebase commit, the tree is clean and no Git operation remains.
Otherwise the conflict record and safety backup are kept as for an explicit request. There is no
workspace recycling.

Connection metadata resolves the state directory's parent before validating its `acp` child, so
system aliases such as macOS `/var` share the same claims and locks. The ACP directory itself must
remain an ordinary, unredirected directory. Conversation archive cleanup uses that same validated
canonical directory; allowing a parent alias does not permit an ACP-directory symlink.

Workflow reads share one checkout inventory per request instead of rebuilding every workspace's
inventory for each task. The extension follows observed primary checkout branch changes only for
`workflow.trackedBranches`, through `workflow.configure` with its existing integration and connection
guards. Untracked branches and detached HEAD project an empty workbench without changing saved workflow
or preview state. Explicit branch selection pins the stored engine context even while the visible
workbench is inactive. Background preview ticks read `rev-parse --symbolic-full-name HEAD` through the
existing validated Git API and skip composition, recovery and setup whenever primary is off the selected
base branch; no new Git write shape is introduced. Returning resumes ordinary content checks.
Branch changes, including entering and leaving an untracked branch, rotate
the webview session and invalidate review authorization and history/rebase results. Checkout
observations include operation markers for primary and non-slot primary checkouts, so unfinished
merges and cherry-picks suppress branch following until the user finishes or aborts them. History and check
refreshes include the branch identity; the state-only `workflow.context` read rejects mixed snapshots
when another window switches requirements during a refresh. Scoped engine writes verify the expected
base branch after acquiring the repository lock, so a request queued by an old page cannot
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

Before composing, Warden copies primary's `info/exclude` and `info/attributes` and sets its resolved
`core.autocrlf`, `core.eol`, `core.safecrlf` and `filter.*`/`merge.*`/`diff.*` driver values in the
shared repository with `git config`. It also sets `maintenance.autoDetach` and `gc.autoDetach` to
`false` there, on creation and on first use of an older repository. Git otherwise detaches automatic
maintenance after a commit: the process keeps `objects/maintenance.lock` and may repack objects after
the command returned, and a backup or allocation that inventories the repository right then stops on
a change nobody made. Maintenance still runs, inside the command that triggered it. Primary keeps
the user's own maintenance settings. Recovery of an interrupted publication runs
`reset --hard HEAD` and `clean -fd` in the preview worktree only, after verifying that every path
holds its previous or candidate content, and removes that worktree's `index.lock` once it has been
unchanged for five seconds. Patches are read and written as bytes. Every `git log` read passes
`--no-show-signature`.

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

The read-only `task.review` command also captures saved task content when the checkout is dirty or its
last delivery used a snapshot. It reuses the external temporary-index snapshot mechanism; no real
task index, HEAD, branch, hooks or files are changed. The `snapshot:<base>..<tree>` review target accepts
only full object IDs and reads exact trees through that task repository and the external snapshot
store, with no merge-base substitution. Source HEAD and the current snapshot are rechecked during
preparation and again before staging. A saved edit after review fails with `review_changed`.
Preparation and delivery records retain `sourceTree`; future review and preview subtract that tree
instead of replaying the same uncommitted contribution. The tree belongs only to its recorded source
boundary. If a manual merge or rebase advances the effective boundary, review, preparation and preview
all use that new commit even when primary has subsequently advanced again. Read-only normalization
does not save state or authorize reuse of the obsolete snapshot. Rebase still requires a clean task
checkout and retains normal Git conflict handling.
If a patch's saved base blob has been pruned from the shared repository, internal three-way composition
reads that exact blob from snapshot storage and restores it with `hash-object -w --no-filters` in the
validated sandbox repository, checking the resulting object ID. This never imports objects into primary.

`POST /workflow/changes/:id/prepare` remains for recovery and compatibility. It pins reviewed saved content and primary HEAD, composes the undelivered
range in isolation, and stages only that delivery. Existing primary user edits are rejected without
being changed. The independent runtime remains available throughout delivery. `update-index --refresh`
refreshes stat metadata before explicit `apply --index`; preview never refreshes the primary index.
Preparation is journaled after its final read-only checks and before staging. A refused staging that
left primary clean removes the journal again. An unprepared journal staged nothing: it never offers
a later base commit for recording, and resuming work discards it whatever the base branch has become.
Interrupted preparation accepts only its known reviewed tree,
preserving other edits.
Legacy requests without `sourceTree` still require a clean source so they cannot authorize unseen edits.

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
clone workspaces retain separate object stores outside primary; shared workspaces keep agent objects
in the shared repository with preview and composition; legacy primary-linked worktrees share the primary
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
interpreting the script as an agent lifecycle. Adding a task runs its configured initialization
hook after assignment is saved; renaming and ordering do not execute hooks.
Windows shell discovery uses a fixed `git --exec-path` invocation with a five-second timeout and
removes inherited `GIT_EXEC_PATH`; this installation lookup does not read or change the repository.
Setup execution uses a separate POSIX process group. Timeout or output overflow sends `SIGKILL` to
that group; Windows invokes the system directory's `taskkill.exe /PID <owned-shell> /T /F` instead.
Completion waits for successful termination and process close before releasing the repository
operation. Execution retains its ten-minute limit, 128 KiB per output stream and 16,000-character
display tail. Cleanup itself has a bounded wait; failure throws `setup_cleanup_failed` and retains
the persisted running owner. Task deletion, hook retry and rebase reject a live or uncertain setup
owner. Preview setup records the same owner and blocks retry/composition after an uncertain cleanup;
legacy preview records without an owner retain their existing interrupted-run recovery. A confirmed
dead owner permits recovery. These checks do not supervise ACP children or deliberately detached
POSIX sessions.

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
Their random URI identities survive editor reloads without re-reading mutable source content. Commit-message drafts, task-title drafts and branch-scoped task selections use VS Code workspace state. Task-note drafts saved by earlier versions are no longer read. Earlier
history drafts remain untouched; Git operation journals stay in the existing
Warden state location. Old HTTP host/origin checks remain only in `test/compat`, which is not bundled.

Updates are managed by VS Code and the Marketplace. There is no npm update request or CLI launcher.
Workspace allocation and preview composition use local Git operations. Clone fetch from
remotes is retained for regression coverage and is not exposed in the task-creation flow.
