import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import type { SafetyBackup } from '@warden/shared';
import { HttpError } from './errors.js';
import { runGit } from './git.js';
import type { StateStore } from './state.js';

type Entry = { path: string; mode: number } & ({ kind: 'directory' } | { kind: 'file'; size: number; sha256: string } | { kind: 'symlink'; target: string });
interface Source {
  path: string;
  name: 'worktree' | 'git-common' | 'git-worktree';
  entries: Entry[];
}
interface Manifest extends SafetyBackup {
  version: 1;
  sources: Source[];
}

export const backupDirectory = (store: StateStore) => path.join(path.dirname(store.file), 'backups');
const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const digest = async (file: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

/** Links are recorded as links, never traversed; unsupported external repositories fail closed. */
async function inventory(root: string, working: boolean): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function walk(relative: string) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (working && !relative && name === '.git') continue;
      const rel = relative ? `${relative}/${name}` : name;
      const file = path.join(root, rel);
      const info = await lstat(file);
      if (working && name === '.git') throw new Error('包含嵌套仓库或子模块，请先单独备份并处理它们');
      if (!working && (name.endsWith('.lock') || (rel.endsWith('objects/info/alternates') && info.size > 0)))
        throw new Error('Git 存在锁文件或外部对象库，无法建立独立且一致的备份');
      const base = { path: rel, mode: info.mode & 0o777 };
      if (info.isSymbolicLink()) {
        if (!working) throw new Error('Git 元数据包含外部链接，无法建立独立备份');
        entries.push({ ...base, kind: 'symlink', target: await readlink(file) });
      } else if (info.isDirectory()) {
        entries.push({ ...base, kind: 'directory' });
        await walk(rel);
      } else if (info.isFile()) entries.push({ ...base, kind: 'file', size: info.size, sha256: await digest(file) });
      else throw new Error(`无法备份特殊文件：${rel}`);
    }
  }
  await walk('');
  return entries;
}

async function syncFile(file: string) {
  const handle = await open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string) {
  // Windows does not support opening directories for fsync through Node.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurable(file: string, value: unknown) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * A full, independent copy before destructive operations. Checkpoints intentionally borrow Git
 * objects and omit ignored files; neither property is safe when deleting the original checkout.
 * The manifest is published only after every copied byte and the source inventory are checked.
 */
export async function createSafetyBackup(store: StateStore, cwd: string, reason: SafetyBackup['reason']): Promise<SafetyBackup> {
  let pending: string | undefined;
  try {
    const worktree = await realpath(cwd);
    const directories = (await runGit(['rev-parse', '--git-common-dir', '--absolute-git-dir', '--show-toplevel'], { cwd: worktree })).stdout.trim().split('\n');
    if ((await realpath(directories[2]!)) !== worktree) throw new Error('工作区路径与 Git 实际工作目录不一致');
    const common = await realpath(path.resolve(worktree, directories[0]!));
    const git = await realpath(path.resolve(worktree, directories[1]!));
    const definitions: Omit<Source, 'entries'>[] = [
      { path: worktree, name: 'worktree' },
      { path: common, name: 'git-common' },
      ...(git === common ? [] : [{ path: git, name: 'git-worktree' as const }]),
    ];
    // Resolve the parent first, so even a symlinked data directory cannot recurse into itself.
    await mkdir(path.dirname(store.file), { recursive: true, mode: 0o700 });
    const data = await realpath(path.dirname(store.file));
    if (definitions.some((source) => within(source.path, data))) throw new Error('备份目录必须位于工作区和 Git 目录之外');
    const root = path.join(data, 'backups');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await realpath(root)) !== root) throw new Error('备份目录不能是符号链接');
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const destination = path.join(root, id);
    pending = path.join(root, `.pending-${id}`);
    await mkdir(pending, { mode: 0o700 });
    const head = (await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: worktree })).stdout.trim();
    const sources: Source[] = [];
    for (const source of definitions) sources.push({ ...source, entries: await inventory(source.path, source.name === 'worktree') });
    for (const source of sources) {
      const target = path.join(pending, source.name);
      await mkdir(target, { mode: 0o700 });
      for (const entry of source.entries) {
        const dest = path.join(target, entry.path);
        if (entry.kind === 'directory') await mkdir(dest, { mode: 0o700 });
        else if (entry.kind === 'file') {
          await copyFile(path.join(source.path, entry.path), dest, constants.COPYFILE_EXCL);
          await chmod(dest, 0o600);
          // Fresh copies, never hard links to objects that a later Git operation could prune.
          await syncFile(dest);
          if ((await digest(dest)) !== entry.sha256) throw new Error('复制期间文件发生变化');
        }
        // Symlink targets live in the manifest, so opening a backup cannot follow a live link.
      }
      for (const entry of [...source.entries].reverse()) if (entry.kind === 'directory') await syncDirectory(path.join(target, entry.path));
      await syncDirectory(target);
    }
    for (const source of [...sources].reverse()) {
      if (JSON.stringify(await inventory(source.path, source.name === 'worktree')) !== JSON.stringify(source.entries))
        throw new Error('备份期间工作区发生变化，请停止其他写入后重试');
    }
    if ((await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: worktree })).stdout.trim() !== head) throw new Error('备份期间 HEAD 发生变化');
    const backup: SafetyBackup = { id, path: destination, reason, createdAt: new Date().toISOString(), worktree, head };
    await writeDurable(path.join(pending, 'state.json'), await store.load());
    const manifest: Manifest = { ...backup, version: 1, sources };
    await writeDurable(path.join(pending, 'manifest.json'), manifest);
    await syncDirectory(pending);
    await rename(pending, destination);
    pending = undefined;
    await syncDirectory(root);
    return backup;
  } catch (error) {
    if (pending) await rm(pending, { recursive: true, force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(409, `安全备份未完成，操作已停止：${message}`, 'backup_failed');
  }
}

/** Revalidate immediately before mutation; copying a large object store can take minutes. */
export async function assertSafetyBackupCurrent(backup: SafetyBackup): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(backup.path, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.id !== backup.id) throw new HttpError(409, '安全备份清单不匹配，操作已停止', 'backup_invalid');
  for (const source of [...manifest.sources].reverse()) {
    try {
      if (source.name === 'worktree') {
        const directories = (await runGit(['rev-parse', '--git-common-dir', '--absolute-git-dir', '--show-toplevel', 'HEAD'], { cwd: backup.worktree })).stdout
          .trim()
          .split('\n');
        const common = manifest.sources.find((s) => s.name === 'git-common')!.path;
        const privateGit = manifest.sources.find((s) => s.name === 'git-worktree')?.path ?? common;
        if (
          (await realpath(path.resolve(backup.worktree, directories[0]!))) !== common ||
          (await realpath(path.resolve(backup.worktree, directories[1]!))) !== privateGit ||
          (await realpath(directories[2]!)) !== backup.worktree ||
          directories[3] !== backup.head
        )
          throw new Error('Git checkout identity changed');
      }
      if (JSON.stringify(await inventory(source.path, source.name === 'worktree')) === JSON.stringify(source.entries)) continue;
    } catch {
      // Missing files, new locks and inaccessible paths are all changes since the verified copy.
    }
    throw new HttpError(409, '备份后工作区发生变化，操作已停止；请停止其他写入后重试', 'backup_stale');
  }
}

/** Only completed rebase/history journals may retire their own external recovery copies.
 * Release/removal backups still protect data that no longer has a live checkout.
 */
export async function discardOperationBackup(store: StateStore, backup: SafetyBackup): Promise<void> {
  const root = await realpath(backupDirectory(store));
  if (
    !/^\d{4}-.*-[0-9a-f-]{36}$/.test(backup.id) ||
    path.basename(backup.id) !== backup.id ||
    path.dirname(path.resolve(backup.path)) !== root ||
    path.resolve(backup.path) !== path.join(root, backup.id) ||
    (backup.reason !== 'rebase' && backup.reason !== 'history')
  )
    throw new HttpError(409, '临时备份路径或用途不匹配，已保留备份', 'backup_invalid');
  // Recovery can repeat after deletion succeeded but the following state write failed.
  const info = await lstat(backup.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(409, '临时备份目录不匹配，已保留备份', 'backup_invalid');
  const manifest = JSON.parse(await readFile(path.join(backup.path, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.id !== backup.id || manifest.reason !== backup.reason || manifest.head !== backup.head)
    throw new HttpError(409, '临时备份清单不匹配，已保留备份', 'backup_invalid');
  await rm(backup.path, { recursive: true, force: true });
}

/** Completed backups are discoverable even if the operation or state update crashed afterward. */
export async function listSafetyBackups(store: StateStore): Promise<SafetyBackup[]> {
  const root = backupDirectory(store);
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const backups: SafetyBackup[] = [];
  for (const id of names
    .filter((name) => /^\d{4}-.*-[0-9a-f-]{36}$/.test(name))
    .sort()
    .reverse()) {
    const file = path.join(root, id, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')) as Manifest;
    if (manifest.version !== 1 || manifest.id !== id) throw new HttpError(409, '安全备份清单损坏，请检查备份目录', 'backup_invalid');
    const { reason, createdAt, worktree, head } = manifest;
    backups.push({ id, path: path.join(root, id), reason, createdAt, worktree, head });
  }
  return backups;
}
