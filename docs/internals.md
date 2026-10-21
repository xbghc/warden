# State and security

Where the review state lives, and what warden will and will not do to the repository.

High-risk operations also create [verified independent backups](backups.md) before changing Git
history or discarding a checkout. These are separate from review checkpoints and ordinary Git reflogs.

## State

`~/.local/share/warden/<sha1(repoRoot)[:12]>/state.json` (respects `XDG_DATA_HOME`). Plain JSON with a
`schemaVersion`, written atomically (temp file, fsync, rename) under a small lock file so multiple
instances and the agent CLI can share it. The lock carries a token of its own and is refreshed while
held: one left by a process that died is taken over after 5 s, a slow holder's is not, and a holder
whose lock was taken over meanwhile writes nothing. A file written by a newer warden is refused
rather than read as empty; one that is not a state file at all is set aside as `.corrupt-<time>`;
top-level fields this version does not know are kept when it writes. `schemaVersion` stays 1: every
warden up to 0.16 replaces a file with any other version by an empty state. Delete the directory to reset. Checkpoint objects live beside it in `checkpoints/objects`;
deleting a checkpoint leaves them there, since another may share them.

`targets` is keyed by target key, plus one *comment scope* per worktree — `local`, or
`worktree:<path>:local` — holding the comments the three local views share and the HEAD sha the last
re-anchor saw. `viewed` sits on the key of the commit, range, `base` or checkpoint target it was
ticked in; the local view keys hold nothing. `workflow.changes` holds the requirement's commit
plans and their execution records. A planned or archived task has no worktree, branch or base;
execution allocates those fields and acceptance records the final commit. Comment links, goal,
acceptance criteria and dependencies stay with the same ID. `checkpoints` remains top level.
Legacy `todos` matching the requirement or its task branches migrate on load, using stable
`todo-<id>` IDs and preserving notes and comment links. Checked notes become archived plans,
never accepted commits. Unrelated notes remain available for explicit import. State written by an older version is
migrated on load: comments filed under `working` / `staged` / `all` move into the matching scope the
first time the file is read, and the 已读 marks those views used to keep are dropped.

## Security model

Single user, local only. The server binds to `127.0.0.1` and executes Git with argument arrays,
through Node's `execFile` or the Rust core's fixed status operation, without a shell. General
reads go through an argument whitelist (`rev-parse`, `diff`, `show`, `log`,
`worktree list`, `ls-files`, `status`, `merge-base`, `rev-list`, `for-each-ref`, `check-ref-format`,
`grep` without `-O` / `--open-files-in-pager`, and `config` only as `--get`, `--get-all` or
`--get-regexp` of one name or pattern; `var` only for `GIT_ATTR_GLOBAL` and `GIT_ATTR_SYSTEM`)
that refuses option-looking refs and any write-capable
flag; requests that would need anything else get HTTP 400. The writes are few and each composes its
own arguments. `POST /api/targets/:key/stage` runs `git apply --cached` (with `--reverse` for the
Staged view) on a patch the server itself builds from the diff it just produced — the patch is never
taken from the request, only the line indices are, and they are checked against the diff's hash
first. `POST /api/worktrees`, `POST /api/worktrees/release` and `POST /api/worktrees/remove` run
`git worktree add`, `git branch`, `git switch`, `git worktree remove` and `git branch -d` with a
branch name git has validated, a ref that resolves, and a slot path the server composes from a
number — `<repo>-<n>` beside the main worktree; no request names a directory. The working tree and
HEAD of an existing checkout are normally written inside such a slot: `git switch <branch>` into a free
one (detached, clean) when a branch is checked out there, `git switch --detach` when it is released,
and `git reset --hard` plus `git clean -fd` only on the forced release the reviewer confirmed after
a 409. A clone slot (see [Clone slots](worktrees.md#clone-slots)) is made at such a path by
`git clone --local --no-checkout` with `warden.main` set, then `git remote remove` / `add` /
`set-url` / `set-head` with the names and URLs read from the main worktree's config, and a `git fetch`
of the main worktree's remote-tracking branches; after that it is written like any slot, in the
clone, plus a `git fetch --all` there when the checkout asks for one. A clone made for a checkout
that then fails is deleted again, and a clone's directory is deleted — the one write outside git —
only on a removal the reviewer confirmed after being told what only it holds, and only while it is
still a clone of this repository. Legacy checkout refs change when a branch is made for a checkout (plus its upstream setting when it comes
from a remote) — undone with `branch -D` should the switch into the slot then fail — or deleted on
request after a release or removal (`-d`, so only a merged one), and the review state lives outside
the repository. A checkpoint writes only there: `git add --all [--intent-to-add]` and
`git write-tree --missing-ok`, with `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` set to files in
warden's data directory and no alternates (see [Checkpoints](reviewing.md#checkpoints)).

New clone workspaces copy the primary repository's effective `user.name` and `user.email` with
fixed `git config` writes only when they differ from the clone's inherited defaults. This preserves
repository-local commit identity without overriding matching global defaults.

The independent `warden-core` Rust crate exposes a typed worktree observation, rather than a raw
command API. It executes exactly `git status --porcelain=v2 --branch --untracked-files=all
--no-ahead-behind -z`, returning HEAD, branch, changed-entry count, paths and a hash of the raw
status bytes. It limits concurrent status children to eight and applies a 30-second deadline,
including queue time, plus 256 MiB limits per output stream. Timeout/output-limit failures kill and
reap the direct Git child before returning. Reads set `GIT_OPTIONAL_LOCKS=0`; the real index is not
refreshed. The N-API binding passes the calling Node worker's environment explicitly, and the core
independently removes repository redirection variables. Platforms without a prebuilt module use
the same fixed operation through the guarded Node runner. Both paths hash original bytes; paths
retain the server's existing UTF-8 representation. Watching repeated edits to a non-UTF-8 filename
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

Task notes and ordering write only Warden state. Explicit allocation creates/adopts a validated
numbered workspace from the selected primary baseline, without dependency enforcement.
`workflow.changes[].deliveries` stores stable delivery IDs, source ranges, primary commits and
review records. `sourceBase` distinguishes a delivered source tip from its squash commit.

`GET /workflow/rebase-checks` replays only in independent repositories under the state directory's
`operations/`. Their hooks and signing are disabled. `POST /workflow/rebase` validates source and
primary HEADs and clean checkout state, then explicitly rebases selected workspaces with
`rebase --no-autostash --onto`. Actual conflicts remain for manual handling. There is no background
rebase or workspace recycling.

Workflow reads share one checkout inventory per request instead of rebuilding every workspace's
inventory for each task. Synchronization checks may reuse up to 64 isolated replay verdicts,
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

`PUT /preview` and the server refresh timer snapshot selected workspaces into Warden's checkpoint
object store. Server-generated binary patches are composed with `apply --index --3way` in an
independent repository, then `apply --check` / `apply` update only the primary working files.
Primary HEAD, index and complete nonignored file snapshot must match the recorded ownership state.
The durable `connectionPreview` record journals old/new snapshots before writes. Initial conflict
fails without changing the existing preview; later failure marks the preserved preview stale.

`POST /workflow/changes/:id/prepare` pins a clean source and primary HEAD, composes the undelivered
range in isolation, suspends owned preview files and stages only that delivery. `update-index
--refresh` refreshes stat metadata before explicit `apply --index`; preview itself never refreshes
the real index. Preparation is journaled first. Interrupted preparation accepts only its known
reviewed tree, preserving other edits.

Only the final binary patch enters the primary index. Neither the agent's source commits nor
temporary composition commits are fetched into the primary repository. Interrupted preparation
compares NUL-delimited raw index changes with the isolated candidate, without importing its tree
or depending on display-only diff configuration.
Preview and delivery patches share the review diff's fixed `a/` and `b/` prefixes, disabled color,
three context lines and short submodule format, with external diff and textconv disabled. Local
and global Git display settings cannot redirect delivered paths or replace the file bytes.

`POST /workflow/changes/:id/accept` checks HEAD and the staged binary-diff fingerprint, then runs
ordinary `git commit -m` in the primary checkout. Identity, signing and Git hooks are preserved.
`record` instead records a user-reviewed manual commit pinned by SHA. Both require a single child
of the prepared parent and clean files. Successful delivery appends a record, preserves the source
workspace and resumes connections. No `reset`, `clean`, `commit-tree` or hook bypass is used.

History preview uses isolated `cherry-pick` and message amendments. Applying a validated linear
candidate requires the same final tree and original HEAD. Only the selected replacement commit
graph is fetched locally; `update-ref <branch> <new> <old>` publishes it.
An independent filesystem backup is also required before fetching/publishing the candidate.
The real files/index need no change. `historyDraft` journals publication and subsequent delivery-SHA
mapping. The temporary repository and operation backup are removed after that mapping is durable.
No remote push or user-facing undo/restore operation is provided.

All mutation arguments are composed by the server; requests cannot supply raw Git commands or
candidate directories. Local fetches use validated repositories and exact object IDs. Source
history stays in the task workspace; delivery records associate it with the final primary commit
without adding retention refs. Successful delivery, synchronization and history publication retire
older versions' exact generated `refs/warden/changes/<id>/{source,accepted}`,
`refs/warden/deliveries/<id>/{source,commit}` and `refs/warden/history/<id>` refs with
`update-ref -d <ref> <observed-old-value>`. Other refs and user reflogs are preserved; ordinary Git
maintenance decides when previously retained, now-unreachable objects can be collected. Clone
workspaces isolate agent objects; explicitly selected linked worktrees share the primary object
store by Git's design. Workflow writes share
a cross-process repository-operation lock; short JSON updates have their own lock. Stale-heartbeat
recovery also requires the recorded owner process to be gone. A live owner, incomplete owner record,
or inconclusive liveness check remains occupied, so a delayed heartbeat cannot authorize a second
writer. Contenders have a bounded wait, and state writes still verify their ownership token before
publishing. Git and file checks reduce stale-write risks but do not stop external editors/agents
from writing concurrently.

User-configured workspace hooks are the deliberate shell interface (`/bin/sh -c`, or Git for
Windows' bundled `sh.exe -c`, with cwd/env and bounded output/timeout). They use the same Git
environment isolation as server Git calls. Warden records hook output and exit status without
interpreting the script as an agent lifecycle. Planning a task does not execute hooks.
Windows shell discovery uses a fixed `git --exec-path` invocation with a five-second timeout and
removes inherited `GIT_EXEC_PATH`; this installation lookup does not read or change the repository.

Binding to `127.0.0.1` keeps other machines out but not other web pages, which reach the server
through the browser. Every request whose `Host` is not `127.0.0.1` or `localhost` is refused with
403, reads included: that is what a DNS-rebinding page — its own domain re-pointed at `127.0.0.1`,
and so same-origin with warden — cannot hide. Open warden under one of those two names; a tunnel or
proxy that rewrites the host name will be refused. A mutating request the browser labels as coming
from another origin (`Sec-Fetch-Site: cross-site`, or an `Origin` that is not the server's own) is
refused with 403 as well, so a page from elsewhere cannot drive the server through the browser it
is open in.

warden itself makes one request off the machine, the update check: a `GET` of
`https://registry.npmjs.org/@xbghc%2fwarden/latest`, no more than once a day, carrying nothing about
the repository or the review. The other way out is git's own: a checkout into a clone slot with
*先 fetch 远端* ticked runs `git fetch --all` in that clone, which reaches its remotes with your git
configuration and credentials, as running it yourself would. `--no-update-check` (or the environment switches under [Install / run](../README.md#install--run))
removes it.
