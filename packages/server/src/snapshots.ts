import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, stat, utimes } from 'node:fs/promises';
import { runGit, runGitSnapshot, type SnapshotEnv } from './git.js';

/**
 * Where internal snapshots keep their objects: a directory of warden's beside the state file, never the
 * repository. Files the index already has right are not hashed again and their blobs are read from
 * the repository through the alternates, so a snapshot costs about what changed, not the tree.
 */
export function snapshotStore(stateFile: string): string {
  // Keep the existing object directory: preview recovery may still refer to its trees.
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

/** Object access alone, for reading a snapshot's files: no index is involved. */
export async function snapshotObjects(cwd: string, store: string): Promise<SnapshotEnv> {
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
  const [objects, index] = await Promise.all([snapshotObjects(cwd, store), repoIndex(cwd)]);
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
