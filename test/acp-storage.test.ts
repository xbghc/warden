import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs, { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpBinding, AcpRecord } from '@warden/shared';
import { AcpSessionStorage } from '../packages/vscode/src/acp/storage.js';

let root: string;
let directory: string;
let binding: AcpBinding;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-acp-storage-')));
  directory = path.join(root, 'data', 'acp');
  binding = {
    repository: path.join(root, 'project'),
    workspace: path.join(root, 'project-1'),
    taskId: 'task-one',
    title: 'Task one',
    branch: 'warden/task-one',
    identity: 'checkout-one',
  };
  await mkdir(binding.repository);
  await mkdir(binding.workspace);
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

function conversation(): AcpRecord {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    binding: { ...binding },
    profileId: 'agent-profile',
    profileSignature: 'a'.repeat(64),
    sessionId: 'agent-session',
    agentName: 'Fixture agent',
    canLoad: true,
    messages: [{ id: randomUUID(), role: 'user', text: 'Implement this small task.' }],
    updatedAt: new Date().toISOString(),
    interrupted: true,
  };
}

async function savedOwner(storage: AcpSessionStorage) {
  return JSON.parse(await readFile(storage.ownerFile, 'utf8')) as Record<string, unknown>;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('external ACP session storage', () => {
  it('persists interrupted conversation data across instances without writing code directories', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    expect(await storage.load()).toBeUndefined();
    const record = conversation();
    await storage.save(record);
    expect(await new AcpSessionStorage(directory, binding).load()).toEqual(record);
    expect(await readdir(binding.repository)).toEqual([]);
    expect(await readdir(binding.workspace)).toEqual([]);
    expect(await readdir(directory)).toEqual([path.basename(storage.file)]);
  });

  it('serializes captured snapshots and exposes only complete JSON during atomic replacement', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    const record = conversation();
    await storage.save(record);
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 12; index++) {
      record.messages[0]!.text = `Snapshot ${index}`;
      writes.push(storage.save(record));
    }
    record.messages[0]!.text = 'Changed after queuing';
    const reading = (async () => {
      for (let index = 0; index < 24; index++) {
        const visible = JSON.parse(await readFile(storage.file, 'utf8')) as AcpRecord;
        expect(visible.id).toBe(record.id);
        expect(visible.messages).toHaveLength(1);
      }
    })();
    await Promise.all([...writes, reading]);
    expect((await storage.load())?.messages[0]?.text).toBe('Snapshot 11');
    expect((await readdir(directory)).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('archives immutable copies while leaving the current record unchanged', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    const first = conversation();
    await storage.save(first);
    const original = await readFile(storage.file);
    await storage.archive(first);
    await storage.archive(first);
    expect(await readFile(storage.file)).toEqual(original);
    const archives = path.join(directory, 'archives', path.basename(storage.file, '.json'));
    const files = await readdir(archives);
    expect(files).toHaveLength(2);
    for (const file of files) expect(JSON.parse(await readFile(path.join(archives, file), 'utf8'))).toEqual(first);
    await storage.save(conversation());
    for (const file of files) expect(JSON.parse(await readFile(path.join(archives, file), 'utf8'))).toEqual(first);
  });

  it('preserves corrupt and unsupported records instead of replacing them on save', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    await storage.save(conversation());
    for (const contents of ['{"schemaVersion":1', JSON.stringify({ ...conversation(), schemaVersion: 2 })]) {
      await writeFile(storage.file, contents);
      await expect(storage.load()).rejects.toThrow('原文件已保留');
      await expect(storage.save(conversation())).rejects.toThrow('原文件已保留');
      expect(await readFile(storage.file, 'utf8')).toBe(contents);
    }
  });

  it('bounds disk reads and refuses executable profile fields and oversized messages', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    const record = conversation();
    await storage.save(record);
    const original = await readFile(storage.file);
    await expect(storage.save({ ...record, command: 'agent', env: { PROVIDER_TOKEN: 'must-not-persist' } } as AcpRecord)).rejects.toThrow('不支持的字段');
    await expect(storage.save({ ...record, messages: [{ id: 'oversize', role: 'agent', text: 'x'.repeat(1024 * 1024 + 1) }] })).rejects.toThrow();
    expect(await readFile(storage.file)).toEqual(original);
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 32);
    await writeFile(storage.file, huge);
    await expect(storage.load()).rejects.toThrow('大小无效');
    expect((await readFile(storage.file)).length).toBe(huge.length);
  });

  it('keeps renamed tasks resumable while rejecting mismatched checkout metadata', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    const record = conversation();
    await storage.save(record);
    expect((await new AcpSessionStorage(directory, { ...binding, title: 'Renamed task' }).load())?.sessionId).toBe(record.sessionId);
    await expect(new AcpSessionStorage(directory, { ...binding, workspace: path.join(root, 'replacement') }).load()).rejects.toThrow('身份不匹配');
    const replacement = new AcpSessionStorage(directory, { ...binding, identity: 'replacement-checkout' });
    expect(replacement.file).not.toBe(storage.file);
    expect(await replacement.load()).toBeUndefined();
    const release = await storage.claim();
    await expect(replacement.claim()).rejects.toThrow('另一个 Warden 窗口');
    await release();
  });

  it('allows exactly one simultaneous owner even when both instances share a process', async () => {
    const first = new AcpSessionStorage(directory, binding);
    const second = new AcpSessionStorage(directory, binding);
    const claims = await Promise.allSettled([first.claim(), second.claim()]);
    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
    for (const result of claims) if (result.status === 'fulfilled') await result.value();
    const release = await second.claim();
    await expect(second.claim()).rejects.toThrow('另一个 Warden 窗口');
    await release();
    await release();
  });

  it('allows only one task claim when two windows finish reclaiming the same dead metadata owner out of order', async () => {
    const first = new AcpSessionStorage(directory, binding);
    const second = new AcpSessionStorage(directory, binding);
    const lock = first.ownerFile.replace('.owner.json', '.metadata.repository.lock');
    const id = randomUUID();
    const deadOwner = path.join(lock, `owner-2147483647-${id}`);
    await mkdir(lock, { recursive: true });
    await writeFile(deadOwner, `2147483647:${id}`);
    await utimes(deadOwner, new Date(0), new Date(0));
    const bothReclaiming = signal();
    const firstReading = signal();
    const lateCleanup = signal();
    const originalUnlink = fs.unlink;
    const originalRmdir = fs.rmdir;
    let reclaimers = 0;
    let firstRead = false;
    let insideMetadataLock = false;
    vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (file === deadOwner) {
        if (++reclaimers === 1) await bothReclaiming.promise;
        else {
          bothReclaiming.resolve();
          await firstReading.promise;
        }
      }
      return originalUnlink(file);
    });
    vi.spyOn(fs, 'rmdir').mockImplementation(async (file, options) => {
      try {
        return await originalRmdir(file, options);
      } finally {
        if (file === lock && insideMetadataLock) lateCleanup.resolve();
      }
    });
    syncBuiltinESMExports();
    for (const storage of [first, second]) {
      const internal = storage as unknown as { readOwner(): Promise<unknown> };
      const originalRead = internal.readOwner.bind(internal);
      vi.spyOn(internal, 'readOwner').mockImplementation(async () => {
        const owner = await originalRead();
        if (!firstRead) {
          firstRead = true;
          insideMetadataLock = true;
          firstReading.resolve();
          await lateCleanup.promise;
          insideMetadataLock = false;
        }
        return owner;
      });
    }
    const claims: PromiseSettledResult<() => Promise<void>>[] = [];
    try {
      claims.push(...(await Promise.allSettled([first.claim(), second.claim()])));
      expect(reclaimers).toBe(2);
      expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const rejected = claims.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toHaveProperty('message', expect.stringContaining('另一个 Warden 窗口'));
    } finally {
      bothReclaiming.resolve();
      firstReading.resolve();
      lateCleanup.resolve();
      for (const result of claims) if (result.status === 'fulfilled') await result.value();
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('respects a task owner held by another extension process', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    const release = await storage.claim();
    const source = `
      const { AcpSessionStorage } = await import(process.argv[1]);
      const storage = new AcpSessionStorage(process.argv[2], JSON.parse(process.argv[3]));
      try {
        const release = await storage.claim();
        await release();
        console.log('acquired');
      } catch (error) {
        if (!error.message.includes('另一个 Warden 窗口')) throw error;
        console.log('busy');
      }
    `;
    const child = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          source,
          new URL('../packages/vscode/src/acp/storage.ts', import.meta.url).href,
          directory,
          JSON.stringify(binding),
        ],
        { encoding: 'utf8' },
      ).trim();
    try {
      expect(child()).toBe('busy');
    } finally {
      await release();
    }
    expect(child()).toBe('acquired');
  });

  it('blocks another owner from saving or archiving the task while allowing read-only loading', async () => {
    const first = new AcpSessionStorage(directory, binding);
    const second = new AcpSessionStorage(directory, binding);
    const release = await first.claim();
    const record = conversation();
    await first.save(record);
    expect(await second.load()).toEqual(record);
    await expect(second.save({ ...record, profileId: 'another-profile' })).rejects.toThrow('另一个 Warden 窗口');
    await expect(second.archive(record)).rejects.toThrow('另一个 Warden 窗口');
    expect(await first.load()).toEqual(record);
    await release();
  });

  it('reclaims only a confirmed exited process and protects a new owner from stale release', async () => {
    const first = new AcpSessionStorage(directory, binding);
    const second = new AcpSessionStorage(directory, binding);
    const staleRelease = await first.claim();
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    expect(() => process.kill(deadPid, 0)).toThrow();
    await writeFile(first.ownerFile, JSON.stringify({ ...(await savedOwner(first)), pid: deadPid }));
    const release = await second.claim();
    const current = await readFile(second.ownerFile);
    await staleRelease();
    expect(await readFile(second.ownerFile)).toEqual(current);
    await expect(first.claim()).rejects.toThrow('另一个 Warden 窗口');
    await release();
  });

  it('does not steal old claims from a live process, another host, or an inaccessible process', async () => {
    const first = new AcpSessionStorage(directory, binding);
    const second = new AcpSessionStorage(directory, binding);
    await first.claim();
    const original = await savedOwner(first);
    await writeFile(first.ownerFile, JSON.stringify({ ...original, createdAt: '2000-01-01T00:00:00.000Z' }));
    await expect(second.claim()).rejects.toThrow('另一个 Warden 窗口');
    await writeFile(first.ownerFile, JSON.stringify({ ...original, hostname: `${os.hostname()}-other-host` }));
    await expect(second.claim()).rejects.toThrow('另一个 Warden 窗口');
    await writeFile(first.ownerFile, JSON.stringify(original));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    });
    await expect(second.claim()).rejects.toThrow('另一个 Warden 窗口');
    expect(await savedOwner(first)).toEqual(original);
  });

  it('fails closed on malformed owner metadata without deleting or replacing it', async () => {
    const storage = new AcpSessionStorage(directory, binding);
    const release = await storage.claim();
    const broken = '{"pid":';
    await writeFile(storage.ownerFile, broken);
    await expect(new AcpSessionStorage(directory, binding).claim()).rejects.toThrow('占用记录无法验证');
    await expect(storage.save(conversation())).rejects.toThrow('占用记录无法验证');
    await expect(release()).rejects.toThrow('占用记录无法验证');
    expect(await readFile(storage.ownerFile, 'utf8')).toBe(broken);
  });

  it('refuses storage inside code roots and archive directory redirection', async () => {
    expect(() => new AcpSessionStorage(path.join(binding.repository, 'acp'), binding)).toThrow('工作区之外');
    expect(() => new AcpSessionStorage(path.join(binding.workspace, 'acp'), binding)).toThrow('工作区之外');
    const storage = new AcpSessionStorage(directory, binding);
    const record = conversation();
    await storage.save(record);
    await symlink(binding.repository, path.join(directory, 'archives'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(storage.archive(record)).rejects.toThrow('重定向');
    expect(await readdir(binding.repository)).toEqual([]);
    expect(await storage.load()).toEqual(record);
  });
});
