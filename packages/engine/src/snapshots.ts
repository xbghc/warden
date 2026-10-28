import path from 'node:path';
import { copyFile, mkdir, mkdtemp, open, rm, utimes, writeFile } from 'node:fs/promises';
import { runGit, runGitSnapshot, type SnapshotEnv } from './git.js';
import { WardenError } from './errors.js';

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

async function repoIndex(cwd: string) {
  const r = await runGit(['rev-parse', '--git-path', 'index', '--show-object-format'], { cwd });
  const [index, format] = r.stdout.trim().split('\n');
  if (!index || (format !== 'sha1' && format !== 'sha256')) throw new WardenError(409, '无法识别 Git 索引位置或对象格式', 'snapshot_index_invalid');
  return { path: path.resolve(cwd, index), format, hashBytes: format === 'sha256' ? 32 : 20 };
}

/** Locate only the split-index link; Git itself expands entries and validates the copied indexes.
 * Asking Git for --shared-index-path would already freshen the source shared index's mtime.
 */
function sharedIndex(bytes: Buffer, hashBytes: number): string | undefined {
  const invalid = () => new WardenError(409, 'Git 索引格式无效，无法生成预览快照', 'snapshot_index_invalid');
  const end = bytes.length - hashBytes;
  if (end < 12 || bytes.toString('ascii', 0, 4) !== 'DIRC') throw invalid();
  const version = bytes.readUInt32BE(4);
  if (version < 2 || version > 4) throw invalid();
  const count = bytes.readUInt32BE(8);
  let offset = 12;
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    const flagsAt = start + 40 + hashBytes;
    if (flagsAt + 2 > end) throw invalid();
    const extended = (bytes.readUInt16BE(flagsAt) & 0x4000) !== 0;
    offset = flagsAt + 2 + (extended ? 2 : 0);
    if (version === 4) {
      // Version 4 replaces eight-byte entry padding with a prefix-length varint.
      do {
        if (offset >= end) throw invalid();
      } while (bytes[offset++]! & 0x80);
    }
    const terminator = bytes.indexOf(0, offset);
    if (terminator < 0 || terminator >= end) throw invalid();
    offset = version === 4 ? terminator + 1 : start + Math.ceil((terminator + 1 - start) / 8) * 8;
  }
  while (offset < end) {
    if (offset + 8 > end) throw invalid();
    const size = bytes.readUInt32BE(offset + 4);
    if (offset + 8 + size > end) throw invalid();
    if (bytes.toString('ascii', offset, offset + 4) === 'link') {
      if (size < hashBytes) throw invalid();
      const hash = bytes.subarray(offset + 8, offset + 8 + hashBytes);
      return hash.some((byte) => byte !== 0) ? hash.toString('hex') : undefined;
    }
    offset += 8 + size;
  }
  if (offset !== end) throw invalid();
  return undefined;
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
  const directory = await mkdtemp(path.join(tmp, 'index-'));
  const copy = path.join(directory, 'index');
  try {
    const source = await open(index.path, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    // No index yet (nothing ever added): git starts an empty one where it is told to.
    if (source) {
      let earlier: number;
      let bytes: Buffer;
      try {
        earlier = Math.floor((await source.stat()).mtimeMs / 1000) - 1;
        bytes = await source.readFile();
      } finally {
        await source.close();
      }
      await writeFile(copy, bytes, { flag: 'wx', mode: 0o600 });
      const shared = sharedIndex(bytes, index.hashBytes);
      if (shared) {
        // Even reading a split index touches its shared file. Give Git private metadata
        // and a copied shared index while flattening, then reuse the source configuration
        // for actual content capture with a standalone temporary index.
        await copyFile(path.join(path.dirname(index.path), `sharedindex.${shared}`), path.join(directory, `sharedindex.${shared}`));
        await mkdir(path.join(directory, 'refs'));
        await mkdir(path.join(directory, 'objects'));
        await writeFile(path.join(directory, 'HEAD'), 'ref: refs/heads/snapshot\n');
        await writeFile(
          path.join(directory, 'config'),
          `[core]\nrepositoryformatversion = ${index.format === 'sha256' ? '1' : '0'}\nbare = false\n` +
            (index.format === 'sha256' ? '[extensions]\nobjectFormat = sha256\n' : ''),
        );
        await runGitSnapshot(['update-index', '--no-split-index'], { cwd, ...objects, index: copy, gitDirectory: directory });
      }
      await utimes(copy, earlier, earlier);
    }
    return await fn({ ...objects, index: copy });
  } finally {
    await rm(directory, { recursive: true, force: true });
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
