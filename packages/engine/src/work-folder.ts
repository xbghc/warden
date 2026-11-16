import path from 'node:path';
import { lstat, mkdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { WardenError } from './errors.js';
import { LONG_GIT_TIMEOUT_MS, runGit, runGitWrite, type SnapshotEnv } from './git.js';
import { snapshotObjects, snapshotStore, snapshotWorktree } from './snapshots.js';

/** The folder the user works in: `<primary>-work`, beside the task workspaces. */
export function workFolderPath(primary: string): string {
  return `${primary}-work`;
}

function interrupted(): never {
  throw new WardenError(
    409,
    'An update of the work folder was interrupted and a file it was writing has other content. Inspect the work folder and retry.',
    'preview_interrupted',
  );
}

/**
 * A linked worktree of primary with a detached HEAD on Warden's latest composition. The user edits
 * and runs code here, so everything that differs from HEAD is theirs: Warden only ever writes the
 * paths a composition changed, and never resets or cleans the folder.
 */
export class WorkFolder {
  private constructor(
    readonly path: string,
    private readonly primary: string,
    private readonly stateFile: string,
  ) {}

  /** Creates the folder at `head` when it does not exist yet. */
  static async ensure(primary: string, stateFile: string, head: string): Promise<WorkFolder> {
    const folder = new WorkFolder(workFolderPath(primary), primary, stateFile);
    const present = await lstat(folder.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!present) {
      await mkdir(path.dirname(folder.path), { recursive: true });
      // Checking out a whole tree can exceed the default timeout on large repositories.
      await runGitWrite([...folder.options(), 'worktree', 'add', '--quiet', '--detach', '--', folder.path, head], {
        cwd: primary,
        timeoutMs: LONG_GIT_TIMEOUT_MS,
      });
    }
    await folder.validate();
    return folder;
  }

  static async open(primary: string, stateFile: string, location: string): Promise<WorkFolder> {
    if (location !== workFolderPath(primary)) throw new Error('Invalid work folder');
    const folder = new WorkFolder(location, primary, stateFile);
    await folder.validate();
    return folder;
  }

  private options() {
    // The path lies beneath the worktree's `.git` file, so it cannot hold hooks. Compositions
    // are not history: recording each one in the HEAD reflog would keep their objects for months.
    return ['-c', `core.hooksPath=${path.join(this.path, '.git', 'disabled-hooks')}`, '-c', 'core.logAllRefUpdates=false'];
  }

  /** The directory must still be the linked worktree of primary that Warden created there. */
  async validate() {
    const directory = await lstat(this.path);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (await realpath(this.path)) !== this.path) throw new Error('Invalid work folder');
    const git = await lstat(path.join(this.path, '.git'));
    if (!git.isFile()) throw new Error('Invalid work folder');
    const [top, common] = (await runGit(['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd: this.path })).stdout.trim().split('\n');
    if (!top || !common || (await realpath(top)) !== this.path || (await realpath(path.resolve(this.path, common))) !== path.join(this.primary, '.git'))
      throw new Error('Invalid work folder');
  }

  private write(args: string[]) {
    return runGitWrite([...this.options(), ...args], { cwd: this.path, timeoutMs: LONG_GIT_TIMEOUT_MS });
  }

  async objects(): Promise<SnapshotEnv> {
    return snapshotObjects(this.path, snapshotStore(this.stateFile));
  }

  /** The folder's saved content as a tree, tracked and untracked files alike. */
  snapshot(): Promise<string> {
    return snapshotWorktree(this.path, snapshotStore(this.stateFile));
  }

  async head(): Promise<string> {
    return (await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: this.path })).stdout.trim();
  }

  /** Brings a composition's objects into primary's repository, where this folder reads them. */
  async fetch(source: string, commit: string) {
    const exists = await runGit(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { cwd: this.path, okCodes: [0, 1, 128] });
    if (exists.code === 0) return;
    await this.write(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--', source, commit]);
  }

  /** Paths whose content differs between two trees; either may live in Warden's snapshot store. */
  private async differing(from: string, to: string): Promise<Set<string>> {
    const listed = await runGit(['diff', '--name-only', '--no-renames', '-z', from, to, '--'], { cwd: this.path, snapshot: await this.objects() });
    return new Set(listed.stdout.split('\0').filter(Boolean));
  }

  /**
   * Writes the paths that differ between `from`, the folder's content when the update was computed,
   * and `merged`, that content with the new composition merged in. A path that already holds its
   * merged content is left alone, so an interrupted update is finished by running this again.
   * Throws when one of those paths holds anything else: that is an edit made meanwhile, and it stays.
   */
  async publish(from: string, merged: string, mergedTree: string) {
    const changed = await this.differing(from, mergedTree);
    if (changed.size) {
      const actual = await this.snapshot();
      const [offFrom, offMerged] = await Promise.all([this.differing(actual, from), this.differing(actual, mergedTree)]);
      const remaining = [...changed].filter((file) => offMerged.has(file));
      if (remaining.some((file) => offFrom.has(file))) interrupted();
      await this.clearStaleIndexLock();
      const kept = new Set(
        (await runGit(['ls-tree', '-r', '--name-only', '-z', mergedTree, '--', ...remaining.map((file) => `:(literal)${file}`)], { cwd: this.path })).stdout
          .split('\0')
          .filter(Boolean),
      );
      const present = remaining.filter((file) => kept.has(file));
      for (let offset = 0; offset < present.length; offset += 200)
        await this.write(['checkout', '--quiet', merged, '--', ...present.slice(offset, offset + 200).map((file) => `:(literal)${file}`)]);
      for (const file of remaining) if (!kept.has(file)) await this.remove(file);
      // Other paths may have been edited meanwhile and are the user's; the written ones must match.
      const written = await this.differing(await this.snapshot(), mergedTree);
      if ([...changed].some((file) => written.has(file))) interrupted();
    }
  }

  /** Points HEAD and the index at the composition, so that what differs from HEAD is the user's edits. */
  async settle(composition: string) {
    await this.clearStaleIndexLock();
    await this.write(['update-ref', '--no-deref', 'HEAD', composition]);
    await this.write(['read-tree', composition]);
  }

  private async remove(file: string) {
    const target = path.join(this.path, file);
    await rm(target, { force: true });
    // Git does not keep empty directories; neither does a composition that deleted their last file.
    for (let directory = path.dirname(target); directory !== this.path && directory.startsWith(this.path + path.sep); directory = path.dirname(directory)) {
      const removed = await rmdir(directory).then(
        () => true,
        () => false,
      );
      if (!removed) break;
    }
  }

  /** A killed Git command leaves its index lock behind. The user runs Git here too, so only a lock
   * untouched for far longer than any of Warden's own commands holds one is taken for abandoned. */
  private async clearStaleIndexLock() {
    const lock = path.resolve(this.path, (await runGit(['rev-parse', '--git-path', 'index.lock'], { cwd: this.path })).stdout.trim());
    const age = await stat(lock).then(
      (info) => Date.now() - info.mtimeMs,
      () => undefined,
    );
    if (age === undefined) return;
    if (age < 30_000) throw new WardenError(409, 'Git is busy in the work folder. Retry shortly.', 'preview_source_busy');
    await rm(lock, { force: true });
  }
}
