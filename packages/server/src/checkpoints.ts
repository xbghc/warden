import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, stat, utimes } from 'node:fs/promises';
import type { Checkpoint, ReviewState, TargetKey } from '@warden/shared';
import { formatTargetKey } from '@warden/shared';
import { runGit, runGitSnapshot, type SnapshotEnv } from './git.js';

/**
 * Where checkpoints keep their objects: a directory of warden's beside the state file, never the
 * repository. Files the index already has right are not hashed again and their blobs are read from
 * the repository through the alternates, so a checkpoint costs about what changed, not the tree.
 */
export function checkpointStore(stateFile: string): string {
  return path.join(path.dirname(stateFile), 'checkpoints');
}

/** The objects directory of the repository `cwd` belongs to; a linked worktree shares the main one's. */
async function repoObjects(cwd: string): Promise<string> {
  const r = await runGit(['rev-parse', '--git-path', 'objects'], { cwd });
  return path.resolve(cwd, r.stdout.trim());
}

async function repoIndex(cwd: string): Promise<string> {
  const r = await runGit(['rev-parse', '--git-path', 'index'], { cwd });
  return path.resolve(cwd, r.stdout.trim());
}

/** Object access alone, for reading a checkpoint's files: no index is involved. */
export async function checkpointObjects(cwd: string, store: string): Promise<SnapshotEnv> {
  return { objects: path.join(store, 'objects'), alternates: await repoObjects(cwd) };
}

/**
 * Runs `fn` against a throwaway copy of the worktree's index. Starting from the real index rather
 * than an empty one is what keeps this cheap: git trusts its stat data and hashes only the files
 * that changed, which is also why the copy is dated a second before the original. A copy dated now
 * would pass off entries git was still unsure of (a file written in the same second as the index)
 * as clean; dated earlier, git looks at their content instead.
 */
async function withIndexCopy<T>(cwd: string, store: string, fn: (env: Required<SnapshotEnv>) => Promise<T>): Promise<T> {
  const tmp = path.join(store, 'tmp');
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(tmp, { recursive: true });
  const [objects, index] = await Promise.all([checkpointObjects(cwd, store), repoIndex(cwd)]);
  const copy = path.join(tmp, `index-${randomUUID()}`);
  try {
    const st = await stat(index).catch(() => undefined);
    // No index yet (nothing ever added): git starts an empty one where it is told to.
    if (st) {
      await copyFile(index, copy);
      const earlier = Math.floor(st.mtimeMs / 1000) - 1;
      await utimes(copy, earlier, earlier);
    }
    return await fn({ ...objects, index: copy });
  } finally {
    await rm(copy, { force: true });
    await rm(`${copy}.lock`, { force: true });
  }
}

/** Writes the working tree of `cwd` into the store as a tree, tracked and untracked files alike; returns its sha. */
export async function snapshotWorktree(cwd: string, store: string): Promise<string> {
  return withIndexCopy(cwd, store, async (snapshot) => {
    await runGitSnapshot(['add', '--all'], { cwd, ...snapshot });
    const r = await runGitSnapshot(['write-tree', '--missing-ok'], { cwd, ...snapshot });
    return r.stdout.trim();
  });
}

/**
 * Runs `fn` with an index under which `git diff <tree>` compares a checkpoint with the whole
 * working tree. The real index lists only tracked files; untracked ones go in as intent-to-add,
 * which hashes nothing, so they are diffed against the checkpoint like any other file — an
 * untracked file that was already there when it was taken shows what changed in it, not all of it.
 */
export async function withCheckpointIndex<T>(cwd: string, store: string, fn: (env: Required<SnapshotEnv>) => Promise<T>): Promise<T> {
  return withIndexCopy(cwd, store, async (snapshot) => {
    await runGitSnapshot(['add', '--all', '--intent-to-add'], { cwd, ...snapshot });
    return fn(snapshot);
  });
}

/** How many checkpoints a worktree keeps; taking one more drops the oldest, with its comments. */
export const MAX_CHECKPOINTS = 20;

const sameWorktree = (c: Checkpoint, worktree: string | undefined) => c.worktree === worktree;

export function checkpointsOf(state: ReviewState, worktree: string | undefined): Checkpoint[] {
  return state.checkpoints.filter((c) => sameWorktree(c, worktree));
}

export function findCheckpoint(state: ReviewState, worktree: string | undefined, id: number): Checkpoint | undefined {
  return state.checkpoints.find((c) => sameWorktree(c, worktree) && c.id === id);
}

export function checkpointKey(c: Checkpoint): TargetKey {
  return formatTargetKey({ kind: 'checkpoint', id: c.id, ...(c.worktree ? { worktree: c.worktree } : {}) });
}

/**
 * Drops a checkpoint and what was kept under its target: the comments and 已读 marks were about a
 * diff against it, and the next checkpoint may be given its number. Issues let go of those comments.
 * Its objects stay in the store; they are small and another checkpoint may share them.
 */
export function forgetCheckpoint(state: ReviewState, c: Checkpoint): void {
  state.checkpoints = state.checkpoints.filter((x) => x !== c);
  const key = checkpointKey(c);
  const gone = new Set((state.targets[key]?.comments ?? []).map((x) => x.id));
  delete state.targets[key];
  if (gone.size) for (const issue of state.issues) issue.commentIds = issue.commentIds.filter((id) => !gone.has(id));
}

/** Records a tree just written as the worktree's newest checkpoint, dropping the oldest past the limit. */
export function addCheckpoint(state: ReviewState, worktree: string | undefined, tree: string, head: string): Checkpoint {
  const mine = checkpointsOf(state, worktree);
  const id = mine.reduce((n, c) => Math.max(n, c.id), 0) + 1;
  const checkpoint: Checkpoint = { id, ...(worktree ? { worktree } : {}), tree, head, createdAt: new Date().toISOString() };
  state.checkpoints.push(checkpoint);
  for (const old of mine.slice(0, Math.max(0, mine.length + 1 - MAX_CHECKPOINTS))) forgetCheckpoint(state, old);
  return checkpoint;
}
