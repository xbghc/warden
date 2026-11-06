import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from './state.js';
import { WardenError } from './errors.js';

/** Keep the existing connection-claim namespace shared by the host and deletion engine. */
export function taskConnectionPaths(directory: string, repository: string, taskId: string) {
  const key = createHash('sha256')
    .update(JSON.stringify([repository, taskId]))
    .digest('hex');
  return { key, owner: path.join(directory, `${key}.owner.json`), metadata: path.join(directory, `${key}.metadata`) };
}

async function prepare(store: StateStore, taskId: string, create = true) {
  const parent = path.dirname(store.file);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  // State directories can have legitimate aliases, including macOS /var. Resolve only
  // that parent; the ACP directory itself must still be an ordinary, unredirected directory.
  const canonicalParent = await realpath(parent).catch((error: NodeJS.ErrnoException) => {
    if (create || error.code !== 'ENOENT') throw error;
    return parent;
  });
  const directory = path.join(canonicalParent, 'acp');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory))
    throw new WardenError(409, 'The conversation storage folder changed. Inspect it before changing the task workspace.', 'task_connection_invalid');
  return { ...taskConnectionPaths(directory, store.repoRoot, taskId), directory };
}

async function connectionOwner(paths: ReturnType<typeof taskConnectionPaths>) {
  const info = await lstat(paths.owner).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return undefined;
  try {
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Invalid owner file.');
    const owner = JSON.parse(await readFile(paths.owner, 'utf8'));
    if (owner.schemaVersion !== 1 || owner.taskKey !== paths.key || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.hostname !== 'string')
      throw new Error('Invalid owner record.');
    if (owner.hostname !== os.hostname()) return owner as { pid: number; hostname: string; token?: string };
    try {
      process.kill(owner.pid, 0);
      return owner as { pid: number; hostname: string; token?: string };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? undefined : (owner as { pid: number; hostname: string; token?: string });
    }
  } catch {
    throw new WardenError(409, 'The task connection owner cannot be verified. Inspect its connection record first.', 'task_connection_invalid');
  }
}

export async function taskHasConnection(store: StateStore, taskId: string) {
  return !!(await connectionOwner(await prepare(store, taskId, false)));
}

/** Keep new claims out until Git finishes; the host reserves any existing local idle session. */
export async function withIdleTaskConnection<T>(store: StateStore, taskId: string, token: string | undefined, action: () => Promise<T>): Promise<T> {
  const paths = await prepare(store, taskId);
  return new StateStore(paths.metadata, store.repoRoot).withRepositoryLock(async () => {
    const owner = await connectionOwner(paths);
    if (owner && (!token || owner.token !== token || owner.pid !== process.pid || owner.hostname !== os.hostname()))
      throw new WardenError(409, 'Automatic rebase skipped an agent connection whose idle state cannot be verified in this window.', 'task_agent_connected');
    if (token && !owner) throw new WardenError(409, 'The reserved agent connection changed before automatic rebase. Check again.', 'task_connection_changed');
    return action();
  });
}

/** Publish the deletion journal under the same short lock that grants an executable connection.
 * New connections revalidate their task under this lock before claiming it.
 */
export async function withoutTaskConnection<T>(store: StateStore, taskId: string, action: (directory: string) => Promise<T>): Promise<T> {
  const paths = await prepare(store, taskId);
  return new StateStore(paths.metadata, store.repoRoot).withRepositoryLock(async () => {
    if (await connectionOwner(paths))
      throw new WardenError(409, 'This task still has an agent connection. Disconnect it in its Warden window, then retry deletion.', 'task_agent_connected');
    return action(paths.directory);
  });
}

/** Delete only records whose stored binding and hashed filename both identify this task.
 * Third-party agent histories and other tasks' records are outside this namespace.
 */
export async function deleteTaskConversations(store: StateStore, taskId: string) {
  await withoutTaskConnection(store, taskId, async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) continue;
      const saved = await readFile(file, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => undefined);
      const binding = saved?.binding;
      if (binding?.repository !== store.repoRoot || binding.taskId !== taskId || typeof binding.identity !== 'string') continue;
      const key = createHash('sha256')
        .update(JSON.stringify([store.repoRoot, taskId, binding.identity]))
        .digest('hex');
      if (entry.name !== `${key}.json`) throw new WardenError(409, 'The task conversation filename does not match its binding.', 'task_connection_invalid');
      const archive = path.join(directory, 'archives', key);
      const archived = await lstat(archive).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (archived) {
        if (!archived.isDirectory() || archived.isSymbolicLink() || (await realpath(archive)) !== archive)
          throw new WardenError(409, 'The task conversation archive was redirected. It has been preserved.', 'task_connection_invalid');
        await rm(archive, { recursive: true });
      }
      await rm(file);
    }
  });
}
