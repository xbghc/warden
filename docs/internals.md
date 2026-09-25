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
ticked in; the local view keys hold nothing. Todos (with the ids of the comments they carry) and `checkpoints` (the tree sha, HEAD and
time of each, per worktree) are top level. State written by an older version is
migrated on load: comments filed under `working` / `staged` / `all` move into the matching scope the
first time the file is read, and the 已读 marks those views used to keep are dropped.

## Security model

Single user, local only. The server binds to `127.0.0.1` and executes git only through
`execFile('git', [...])`. Reads go through an argument whitelist (`rev-parse`, `diff`, `show`, `log`,
`worktree list`, `ls-files`, `status`, `merge-base`, `rev-list`, `grep` without `-O` /
`--open-files-in-pager`) that refuses option-looking refs and any write-capable
flag; requests that would need anything else get HTTP 400. The writes are few and each composes its
own arguments. `POST /api/targets/:key/stage` runs `git apply --cached` (with `--reverse` for the
Staged view) on a patch the server itself builds from the diff it just produced — the patch is never
taken from the request, only the line indices are, and they are checked against the diff's hash
first. `POST /api/worktrees`, `POST /api/worktrees/release` and `POST /api/worktrees/remove` run
`git worktree add`, `git branch`, `git switch`, `git worktree remove` and `git branch -d` with a
branch name git has validated, a ref that resolves, and a slot path the server composes from a
number — `<repo>-<n>` beside the main worktree; no request names a directory. The working tree and
HEAD of an existing checkout are written only inside such a slot: `git switch <branch>` into a free
one (detached, clean) when a branch is checked out there, `git switch --detach` when it is released,
and `git reset --hard` plus `git clean -fd` only on the forced release the reviewer confirmed after
a 409. Refs change only when a branch is made for a checkout (plus its upstream setting when it comes
from a remote) — undone with `branch -D` should the switch into the slot then fail — or deleted on
request after a release or removal (`-d`, so only a merged one), and the review state lives outside
the repository. A checkpoint writes only there: `git add --all [--intent-to-add]` and
`git write-tree --missing-ok`, with `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` set to files in
warden's data directory and no alternates (see [Checkpoints](reviewing.md#checkpoints)).

Binding to `127.0.0.1` keeps other machines out but not other web pages, which reach the server
through the browser. Every request whose `Host` is not `127.0.0.1` or `localhost` is refused with
403, reads included: that is what a DNS-rebinding page — its own domain re-pointed at `127.0.0.1`,
and so same-origin with warden — cannot hide. Open warden under one of those two names; a tunnel or
proxy that rewrites the host name will be refused. A mutating request the browser labels as coming
from another origin (`Sec-Fetch-Site: cross-site`, or an `Origin` that is not the server's own) is
refused with 403 as well, so a page from elsewhere cannot drive the server through the browser it
is open in.

The only request warden makes off the machine is the update check: a `GET` of
`https://registry.npmjs.org/@xbghc%2fwarden/latest`, no more than once a day, carrying nothing about
the repository or the review. `--no-update-check` (or the environment switches under [Install / run](../README.md#install--run))
removes it.
