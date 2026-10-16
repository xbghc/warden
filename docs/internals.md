# State and security

Where the review state lives, and what warden will and will not do to the repository.

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

Single user, local only. The server binds to `127.0.0.1` and executes git only through
`execFile('git', [...])`. Reads go through an argument whitelist (`rev-parse`, `diff`, `show`, `log`,
`worktree list`, `ls-files`, `status`, `merge-base`, `rev-list`, `for-each-ref`, `check-ref-format`,
`grep` without `-O` / `--open-files-in-pager`, and `config` only as `--get`, `--get-all` or
`--get-regexp` of one name or pattern) that refuses option-looking refs and any write-capable
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

Task notes and ordering write only Warden state. Explicit allocation creates/adopts a validated
numbered workspace from the selected primary baseline, without dependency enforcement.
`workflow.changes[].deliveries` stores stable delivery IDs, source ranges, primary commits and
review records. `sourceBase` distinguishes a delivered source tip from its squash commit.

`GET /workflow/rebase-checks` replays only in independent repositories under the state directory's
`operations/`. Their hooks and signing are disabled. `POST /workflow/rebase` validates source and
primary HEADs and clean checkout state, then explicitly rebases selected workspaces with
`rebase --no-autostash --onto`. Actual conflicts remain for manual handling. There is no background
rebase or workspace recycling.

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

`POST /workflow/changes/:id/accept` checks HEAD and the staged binary-diff fingerprint, then runs
ordinary `git commit -m` in the primary checkout. Identity, signing and Git hooks are preserved.
`record` instead records a user-reviewed manual commit pinned by SHA. Both require a single child
of the prepared parent and clean files. Successful delivery appends a record, preserves the source
workspace and resumes connections. No `reset`, `clean`, `commit-tree` or hook bypass is used.

History preview uses isolated `cherry-pick` and message amendments. Applying a validated linear
candidate requires the same final tree and original HEAD. The candidate is fetched locally, a
backup `refs/warden/history/<id>` is retained, and `update-ref <branch> <new> <old>` publishes it.
The real files/index need no change. `historyDraft` journals publication and subsequent delivery-SHA
mapping. No remote push or user-facing undo/restore operation is provided.

All mutation arguments are composed by the server; requests cannot supply raw Git commands or
candidate directories. Local fetches use validated repositories and exact object IDs. Source and
delivery commits are retained under generated `refs/warden/changes/` refs. Workflow writes share
a cross-process repository-operation lock; short JSON updates have their own lock. Git and file
checks reduce stale-write risks but do not stop external editors/agents from writing concurrently.

User-configured workspace hooks are the deliberate shell interface (`/bin/sh -c` with cwd/env and
bounded output/timeout). Tmux commands send literal text plus separately validated keys. Neither
interface infers agent readiness or automatically runs commands merely because a task was planned.

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
