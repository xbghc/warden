import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import type { SafetyBackup } from '@warden/shared';
import { WardenError } from './errors.js';
import { LONG_GIT_TIMEOUT_MS, runGit } from './git.js';
import { sharedRepositoryOwner } from './shared-repository.js';
import type { StateStore } from './state.js';

type Entry = { path: string; mode: number } & ({ kind: 'directory' } | { kind: 'file'; size: number; sha256: string } | { kind: 'symlink'; target: string });
interface Source {
  path: string;
  name: 'worktree' | 'git-common' | 'git-worktree';
  entries: Entry[];
  /** Shared repositories freeze refs separately; sibling additions do not invalidate this checkout. */
  shared?: { entries: Entry[]; branch?: string; reflog?: string };
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
async function inventory(root: string, working: boolean, shared = false): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function walk(relative: string) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (!relative && ((working && name === '.git') || (shared && name === 'worktrees'))) continue;
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

const under = (name: string, prefix: string) => name === prefix || name.startsWith(`${prefix}/`);
const objectEntry = (entry: Entry) => under(entry.path, 'objects');
const sharedMetadata = (entries: Entry[]) =>
  entries.filter((entry) => !['refs', 'logs'].some((name) => under(entry.path, name)) && entry.path !== 'packed-refs');

/** Read only ordinary metadata paths; a ref or parent directory must never escape through a link. */
async function logBytes(common: string, name: string): Promise<Buffer | undefined> {
  let current = common;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (info.isSymbolicLink() || (!info.isDirectory() && current !== path.join(common, name))) throw new Error('Git 元数据包含外部链接，无法建立独立备份');
  }
  return readFile(current);
}

/** Refs are resolved before objects are inventoried, including refs stored in packed-refs/reftable. */
async function sharedReferences(cwd: string, common: string) {
  const symbolic = (await runGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd })).stdout.trim();
  const branch = symbolic.startsWith('refs/heads/') ? symbolic : undefined;
  const refs = (await runGit(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'], { cwd })).stdout;
  const files: { path: string; bytes: Buffer }[] = [];
  for (const line of refs.split('\n').filter(Boolean)) {
    const [name = '', object = '', target = ''] = line.split('\0');
    const safe = (ref: string) => ref.startsWith('refs/') && ref.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'));
    if (!safe(name) || (target && !safe(target)) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(object)) throw new Error('Git 引用格式无效，无法建立独立备份');
    files.push({ path: name, bytes: Buffer.from(`${target ? `ref: ${target}` : object}\n`) });
  }
  let reflog: string | undefined;
  for (const name of new Set([...(branch ? [`logs/${branch}`] : []), 'logs/refs/stash'])) {
    const bytes = await logBytes(common, name);
    if (bytes) {
      files.push({ path: name, bytes });
      if (name === `logs/${branch}`) reflog = createHash('sha256').update(bytes).digest('hex');
    }
  }
  return { files, branch, reflog };
}

/** Compare selected metadata and the copied objects, while allowing new sibling objects and refs. */
async function sharedCurrent(source: Source): Promise<boolean> {
  const original = source.shared!;
  const current = sharedMetadata(await inventory(source.path, false, true));
  if (JSON.stringify(current.filter((entry) => !objectEntry(entry))) !== JSON.stringify(original.entries.filter((entry) => !objectEntry(entry)))) return false;
  const objects = new Map(current.filter(objectEntry).map((entry) => [entry.path, entry]));
  for (const entry of original.entries.filter(objectEntry)) {
    if (JSON.stringify(objects.get(entry.path)) !== JSON.stringify(entry)) return false;
  }
  const log = original.branch ? await logBytes(source.path, `logs/${original.branch}`) : undefined;
  return (log ? createHash('sha256').update(log).digest('hex') : undefined) === original.reflog;
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
 * A full, independent copy before destructive operations. Snapshots intentionally borrow Git
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
    const shared = (await sharedRepositoryOwner(worktree)) !== undefined;
    const definitions: Omit<Source, 'entries'>[] = [
      { path: worktree, name: 'worktree' },
      ...(git === common ? [] : [{ path: git, name: 'git-worktree' as const }]),
      { path: common, name: 'git-common' },
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
    let references: Awaited<ReturnType<typeof sharedReferences>> | undefined;
    for (const source of definitions) {
      // Freeze index/private metadata before capturing the objects those entries refer to.
      if (shared && source.name === 'git-common') {
        references = await sharedReferences(worktree, common);
        const entries = sharedMetadata(await inventory(source.path, false, true));
        sources.push({ ...source, entries, shared: { entries, branch: references.branch, reflog: references.reflog } });
      } else sources.push({ ...source, entries: await inventory(source.path, source.name === 'worktree') });
    }
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
      if (source.shared) {
        for (const file of references!.files) {
          const destination = path.join(target, file.path);
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          const handle = await open(destination, 'wx', 0o600);
          try {
            await handle.writeFile(file.bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        // The manifest describes the independent recovery layout, including generated loose refs.
        source.entries = await inventory(target, false);
      }
      for (const entry of [...source.entries].reverse()) if (entry.kind === 'directory') await syncDirectory(path.join(target, entry.path));
      await syncDirectory(target);
    }
    if (shared) {
      // A sibling can rewrite a captured ref and prune its old objects before our inventory.
      // Validate the independent copy, not the now-different live repository, before publishing it.
      await runGit(['fsck', '--full', '--no-dangling'], { cwd: path.join(pending, 'git-common'), timeoutMs: LONG_GIT_TIMEOUT_MS });
    }
    for (const source of [...sources].reverse()) {
      const current = source.shared
        ? await sharedCurrent(source)
        : JSON.stringify(await inventory(source.path, source.name === 'worktree')) === JSON.stringify(source.entries);
      if (!current) throw new Error('备份期间工作区发生变化，请停止其他写入后重试');
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
    throw new WardenError(409, `安全备份未完成，操作已停止：${message}`, 'backup_failed');
  }
}

/** Revalidate immediately before mutation; copying a large object store can take minutes. */
export async function assertSafetyBackupCurrent(backup: SafetyBackup): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(backup.path, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.id !== backup.id) throw new WardenError(409, '安全备份清单不匹配，操作已停止', 'backup_invalid');
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
      if (
        source.shared
          ? await sharedCurrent(source)
          : JSON.stringify(await inventory(source.path, source.name === 'worktree')) === JSON.stringify(source.entries)
      )
        continue;
    } catch {
      // Missing files, new locks and inaccessible paths are all changes since the verified copy.
    }
    throw new WardenError(409, '备份后工作区发生变化，操作已停止；请停止其他写入后重试', 'backup_stale');
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
    throw new WardenError(409, '临时备份路径或用途不匹配，已保留备份', 'backup_invalid');
  // Recovery can repeat after deletion succeeded but the following state write failed.
  const info = await lstat(backup.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WardenError(409, '临时备份目录不匹配，已保留备份', 'backup_invalid');
  const manifest = JSON.parse(await readFile(path.join(backup.path, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || manifest.id !== backup.id || manifest.reason !== backup.reason || manifest.head !== backup.head)
    throw new WardenError(409, '临时备份清单不匹配，已保留备份', 'backup_invalid');
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
    if (manifest.version !== 1 || manifest.id !== id) throw new WardenError(409, '安全备份清单损坏，请检查备份目录', 'backup_invalid');
    const { reason, createdAt, worktree, head } = manifest;
    backups.push({ id, path: path.join(root, id), reason, createdAt, worktree, head });
  }
  return backups;
}
