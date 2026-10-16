# Safety backups

Warden makes a verified local backup before releasing an existing slot, removing an existing
checkout, actually rebasing a workspace, or applying a history arrangement. A missing/prunable
checkout has no files to copy. A synchronization that only repairs already-completed bookkeeping
does not execute another rebase. Failed confirmation/preflight checks do not start a destructive
operation. A backup failure stops the operation with `backup_failed`.
Branch switches when reusing a slot also refuse to overwrite ignored files; rebase checks ignored
paths against its target and intermediate replay commits before execution.

Backups live at `backups/<timestamp>-<uuid>/` beside this repository's `state.json`; see
[State](internals.md#state) for the data directory. `GET /api/backups` lists completed backups with
their reason, original checkout path, HEAD and backup path. Release/remove responses also include
the created `backup`. The listing survives a server restart and does not rely on a successful
post-operation state write. Warden does not automatically delete these backups or push them anywhere.

## Contents and guarantees

Each backup contains:

- `worktree/`: exact bytes of regular files' primary data streams, including tracked, untracked
  and ignored files. Deleted paths stay absent. No clean/smudge filters, Git LFS conversion or
  automatic staging are involved.
- `git-common/`: an independent copy of the common Git directory's regular-file contents, including
  objects, branches, reflogs, older stashes, packed refs and configuration.
- `git-worktree/`, for a linked worktree: its private HEAD, index and operation metadata. A clone's
  private metadata is already in `git-common/`. Index copies preserve partial staging, conflicts,
  intent-to-add entries and staged contents that differ from working files.
- `state.json`: Warden's review/workflow state at backup time.
- `manifest.json`: version, identity, source layout, SHA-256 and size of every regular file's primary
  data stream, read/write/execute permission bits, directories and symlink targets. Symlinks are
  recorded in this manifest rather than created in the backup; their external targets are never
  followed or copied.

The guarantees cover those primary data streams and the metadata explicitly recorded in the
manifest. ACLs, extended attributes, macOS resource forks and NTFS alternate data streams are not
inventoried, verified or restored by this procedure. Do not rely on these backups to preserve them,
including streams attached to directories. If your project depends on that data or metadata, make
a filesystem-level backup that preserves it before performing destructive operations in Warden.

Objects are copied, never hard-linked or borrowed through alternates. Removing the source clone,
pruning the source repository, or removing its reflogs cannot invalidate the backup. Every copied
file's primary data stream is hashed and flushed, then the source inventory is checked again for
concurrent changes. Only a complete verified backup is atomically renamed into its published directory.
Directories are also flushed on POSIX; Node cannot perform directory fsync on Windows. A crash can
leave an unpublished `.pending-*` directory, which is never listed as a completed backup.

Copies intentionally include ignored dependencies and can consume substantial time and disk
space. There is no silent truncation, size cap or age-based eviction. Keep the data directory on
storage with enough free space and remove old backups manually only after validating recovery or
copying them to retained storage. These local copies protect against operation errors, not loss of
the disk itself. They may contain local secrets; directories/files use private permissions on POSIX
and inherit the user's directory ACLs on Windows.

Nested repositories/submodules, external Git object alternates, Git metadata symlinks, special
files and active Git lock files are conservatively rejected. The backup directory must be outside
the checkout and Git directories. Handle these layouts separately before retrying; Warden will
not proceed with an incomplete backup. External editors are not stopped by Warden's lock: a final
check cannot eliminate a write racing immediately after it. Pause writers during destructive work.

## Recovery into a separate directory

Keep the backup intact. Recover into a new directory and inspect the result before deciding what
to bring back into the active project. This is an incident-recovery procedure, not a history undo UI.

1. Verify regular-file primary-stream hashes against `manifest.json`. Copy `worktree/` to a new empty
   directory. Restore its recorded file/directory permission bits and, if needed, recreate its
   symlinks from the manifest after checking each target. The copied files alone recover ignored
   and untracked content.
2. Initialize a fresh Git repository there with `git init --template=` (use
   `--object-format=sha256` when the recorded HEAD has 64 characters). Do **not** copy the old `.git`
   pointer, `config`, `worktrees/`, `commondir` or `gitdir` wholesale: these can refer to live checkouts.
3. Copy `objects/`, `refs/`, `logs/` and any `packed-refs` and `shallow` files from `git-common/` into
   the new `.git/`. For repositories using reftable, also copy `reftable/` and initialize with the
   original ref format. Preserve a separate copy of the original configuration for reference.
4. Copy `HEAD`, `index` and any `sharedindex.*` from `git-worktree/` when present, otherwise from
   `git-common/`, into the new `.git/`. Check the recorded configuration for worktree-specific
   settings, sparse checkout or an external index before interpreting status. An interrupted Git
   operation's metadata is retained for investigation; do not blindly resume hooks or sequencers.
5. Run `git fsck --full`, `git status`, `git diff`, `git diff --cached` and `git stash list` in the
   recovered directory. Verify the recorded HEAD, staged/unstaged changes and ignored files. Set
   remotes, identity, hooks and signing deliberately after inspection. Do not overwrite the live
   Warden state with the backup's `state.json`; use it to reconcile delivery/review records.

The automated recovery test deletes a clone and its original object source, reconstructs a fresh
repository, and verifies binary staged/unstaged bytes, deletions, ignored and Unicode paths, detached
HEAD, branches and multiple stash entries. Other tests cover linked-worktree indexes, unwritable
backup storage, writes during copying, restart discovery and rebase failures.
