import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { StateStore } from '@warden/engine';
import type { AcpBinding, AcpMessage, AcpRecord } from '@warden/shared';
import type { AcpStorage } from './contracts.js';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CLAIM_BYTES = 16 * 1024;
const MAX_MESSAGES = 10_000;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

interface Owner {
  schemaVersion: 1;
  taskKey: string;
  identity: string;
  hostname: string;
  pid: number;
  token: string;
  createdAt: string;
}

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对象格式无效');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error('包含不支持的字段');
  return record;
}

function string(value: unknown, max = 500, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) throw new Error('文本字段无效');
  return value;
}

function optionalString(value: unknown, max = 500): string | undefined {
  return value === undefined ? undefined : string(value, max, true);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('布尔字段无效');
  return value;
}

function timestamp(value: unknown): string {
  const text = string(value, 100);
  if (!Number.isFinite(Date.parse(text))) throw new Error('时间字段无效');
  return text;
}

function binding(value: unknown): AcpBinding {
  const raw = object(value, ['repository', 'taskId', 'title', 'workspace', 'branch', 'identity']);
  const repository = string(raw.repository, 32_768);
  const workspace = string(raw.workspace, 32_768);
  if (!path.isAbsolute(repository) || !path.isAbsolute(workspace)) throw new Error('工作目录必须为绝对路径');
  return {
    repository,
    taskId: string(raw.taskId),
    title: string(raw.title, 10_000, true),
    workspace,
    branch: string(raw.branch, 4096),
    identity: string(raw.identity, 4096),
  };
}

function sameBinding(a: AcpBinding, b: AcpBinding): boolean {
  return a.repository === b.repository && a.taskId === b.taskId && a.workspace === b.workspace && a.branch === b.branch && a.identity === b.identity;
}

function message(value: unknown): AcpMessage {
  const raw = object(value, ['id', 'role', 'text', 'status', 'toolCallId', 'uncertain']);
  if (typeof raw.role !== 'string' || !['user', 'agent', 'tool', 'notice'].includes(raw.role)) throw new Error('消息角色无效');
  return {
    id: string(raw.id),
    role: raw.role as AcpMessage['role'],
    text: string(raw.text, 1024 * 1024, true),
    status: optionalString(raw.status, 4096),
    toolCallId: optionalString(raw.toolCallId, 4096),
    uncertain: raw.uncertain === undefined ? undefined : boolean(raw.uncertain),
  };
}

function record(value: unknown, expected: AcpBinding): AcpRecord {
  const raw = object(value, [
    'schemaVersion',
    'id',
    'binding',
    'profileId',
    'profileSignature',
    'sessionId',
    'agentName',
    'canLoad',
    'messages',
    'updatedAt',
    'interrupted',
  ]);
  if (raw.schemaVersion !== 1) throw new Error('不支持的会话记录版本');
  const savedBinding = binding(raw.binding);
  if (!sameBinding(savedBinding, expected)) throw new Error('会话记录与当前工作区身份不匹配');
  if (!Array.isArray(raw.messages) || raw.messages.length > MAX_MESSAGES) throw new Error('消息数量超出限制');
  const signature = optionalString(raw.profileSignature, 64);
  if (signature !== undefined && !HASH.test(signature)) throw new Error('配置签名无效');
  return {
    schemaVersion: 1,
    id: string(raw.id),
    binding: savedBinding,
    profileId: optionalString(raw.profileId),
    profileSignature: signature,
    sessionId: optionalString(raw.sessionId, 4096),
    agentName: optionalString(raw.agentName, 4096),
    canLoad: boolean(raw.canLoad),
    messages: raw.messages.map(message),
    updatedAt: timestamp(raw.updatedAt),
    interrupted: raw.interrupted === undefined ? undefined : boolean(raw.interrupted),
  };
}

function owner(value: unknown, taskKey: string): Owner {
  const raw = object(value, ['schemaVersion', 'taskKey', 'identity', 'hostname', 'pid', 'token', 'createdAt']);
  if (raw.schemaVersion !== 1 || raw.taskKey !== taskKey) throw new Error('会话占用归属无效');
  if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || raw.pid > 2_147_483_647) throw new Error('进程标识无效');
  const token = string(raw.token, 36);
  if (!TOKEN.test(token)) throw new Error('会话占用令牌无效');
  return {
    schemaVersion: 1,
    taskKey,
    identity: string(raw.identity, 4096),
    hostname: string(raw.hostname, 1024),
    pid: raw.pid,
    token,
    createdAt: timestamp(raw.createdAt),
  };
}

function digest(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Persist only conversation data, independently of executable profiles and agent processes. */
export class AcpSessionStorage implements AcpStorage {
  readonly file: string;
  readonly ownerFile: string;
  private readonly directory: string;
  private readonly binding: AcpBinding;
  private readonly taskKey: string;
  private readonly archiveDirectory: string;
  private readonly mutex: StateStore;
  private queue: Promise<unknown> = Promise.resolve();
  private token?: string;

  constructor(directory: string, expected: AcpBinding) {
    this.binding = binding(expected);
    if (!path.isAbsolute(directory)) throw new Error('会话存储目录必须为绝对路径');
    this.directory = path.resolve(directory);
    this.assertOutside(this.directory);
    this.taskKey = digest([this.binding.repository, this.binding.taskId]);
    const key = digest([this.binding.repository, this.binding.taskId, this.binding.identity]);
    this.file = path.join(this.directory, `${key}.json`);
    this.ownerFile = path.join(this.directory, `${this.taskKey}.owner.json`);
    this.archiveDirectory = path.join(this.directory, 'archives', key);
    // This short lock only serializes metadata. Holding an ACP owner claim never holds
    // the engine's repository lock and does not supervise agent execution.
    this.mutex = new StateStore(path.join(this.directory, `${this.taskKey}.metadata`), this.binding.repository);
  }

  load(): Promise<AcpRecord | undefined> {
    return this.serialized(async () => {
      await this.prepareDirectory();
      return this.readRecord();
    });
  }

  async save(value: AcpRecord): Promise<void> {
    const encoded = this.encode(value);
    await this.serialized(() =>
      this.locked(async () => {
        await this.assertWriteOwner();
        // A caller must not bypass a failed load and replace corrupt or newer metadata.
        await this.readRecord();
        await this.writeAtomic(this.file, encoded);
      }),
    );
  }

  async archive(value: AcpRecord): Promise<void> {
    const encoded = this.encode(value);
    await this.serialized(() =>
      this.locked(async () => {
        await this.assertWriteOwner();
        await this.readRecord();
        for (const directory of [path.dirname(this.archiveDirectory), this.archiveDirectory]) {
          await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('会话归档目录被重定向，请检查外部数据目录');
        }
        if ((await realpath(this.archiveDirectory)) !== path.join(await realpath(this.directory), 'archives', path.basename(this.archiveDirectory)))
          throw new Error('会话归档目录被重定向，请检查外部数据目录');
        await this.writeAtomic(path.join(this.archiveDirectory, `${Date.now()}-${randomUUID()}.json`), encoded);
      }),
    );
  }

  claim(): Promise<() => Promise<void>> {
    return this.serialized(() =>
      this.locked(async () => {
        const existing = await this.readOwner();
        if (existing && !this.exited(existing)) this.busy();
        const token = randomUUID();
        const next: Owner = {
          schemaVersion: 1,
          taskKey: this.taskKey,
          identity: this.binding.identity,
          hostname: os.hostname(),
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        };
        await this.writeAtomic(this.ownerFile, `${JSON.stringify(next)}\n`);
        this.token = token;
        return () =>
          this.serialized(() =>
            this.locked(async () => {
              const current = await this.readOwner();
              if (current?.token === token) await rm(this.ownerFile);
              if (this.token === token) this.token = undefined;
            }),
          );
      }),
    );
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.prepareDirectory();
    return this.mutex.withRepositoryLock(fn);
  }

  private assertOutside(directory: string) {
    if (within(path.resolve(this.binding.repository), directory) || within(path.resolve(this.binding.workspace), directory))
      throw new Error('会话记录必须保存在主目录和任务工作区之外');
  }

  private async prepareDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('会话存储目录已被替换，请检查外部数据目录');
    this.assertOutside(await realpath(this.directory));
  }

  private encode(value: AcpRecord): string {
    const encoded = `${JSON.stringify(record(value, this.binding))}\n`;
    if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) throw new Error('会话记录超过 8 MiB，无法继续保存；请新建对话');
    return encoded;
  }

  private async readRecord(): Promise<AcpRecord | undefined> {
    try {
      const raw = await this.readJson(this.file, MAX_RECORD_BYTES);
      return raw === undefined ? undefined : record(raw, this.binding);
    } catch (error) {
      throw new Error(`会话记录无法读取，原文件已保留：${this.file}。请检查文件后重试。${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readOwner(): Promise<Owner | undefined> {
    try {
      const raw = await this.readJson(this.ownerFile, MAX_CLAIM_BYTES);
      return raw === undefined ? undefined : owner(raw, this.taskKey);
    } catch (error) {
      throw new Error(`会话占用记录无法验证，已保留：${this.ownerFile}。请检查文件后重试。${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readJson(file: string, max: number): Promise<unknown | undefined> {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('文件类型或大小无效');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > max) throw new Error('文件类型或大小无效');
      // Do not let a growing file bypass the stat limit or allocate an unbounded read buffer.
      const bytes = Buffer.allocUnsafe(max + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, Math.min(64 * 1024, bytes.length - length), null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > max) throw new Error('文件大小超出限制');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
    } finally {
      await handle.close();
    }
  }

  private async writeAtomic(file: string, contents: string) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private exited(claim: Owner): boolean {
    if (claim.hostname !== os.hostname()) return false;
    try {
      process.kill(claim.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async assertWriteOwner() {
    const current = await this.readOwner();
    if (current && (current.token !== this.token || current.pid !== process.pid || current.hostname !== os.hostname())) this.busy();
  }

  private busy(): never {
    throw new Error('这个任务的对话已由另一个 Warden 窗口持有；请先在该窗口断开连接');
  }
}
