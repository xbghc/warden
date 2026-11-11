import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { processExited, StateStore, taskConnectionPaths } from '@warden/engine';
import type { AcpBinding, AcpMessage, AcpRecord } from '@warden/shared';
import type { AcpStorage } from './contracts.js';
import { modelSelection } from './model-preferences.js';
import { sameAcpBinding } from './binding.js';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CLAIM_BYTES = 16 * 1024;
const MAX_MESSAGES = 10_000;
const RENAME_ATTEMPTS = 6;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object format.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error('Unsupported fields found.');
  return record;
}

function string(value: unknown, max = 500, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) throw new Error('Invalid text field.');
  return value;
}

function optionalString(value: unknown, max = 500): string | undefined {
  return value === undefined ? undefined : string(value, max, true);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid boolean field.');
  return value;
}

function timestamp(value: unknown): string {
  const text = string(value, 100);
  if (!Number.isFinite(Date.parse(text))) throw new Error('Invalid timestamp field.');
  return text;
}

function binding(value: unknown, expected?: AcpBinding): AcpBinding {
  const raw = object(value, ['repository', 'taskId', 'title', 'workspace', 'branch', 'baseBranch', 'identity']);
  const repository = string(raw.repository, 32_768);
  const workspace = string(raw.workspace, 32_768);
  if (!path.isAbsolute(repository) || !path.isAbsolute(workspace)) throw new Error('Working directories must use absolute paths.');
  return {
    repository,
    taskId: string(raw.taskId),
    title: string(raw.title, 10_000, true),
    workspace,
    branch: string(raw.branch, 4096),
    // Only 0.25.0–0.25.1 records contain this field; the allocation identity covers it either way.
    baseBranch: string(raw.baseBranch === undefined ? expected?.baseBranch : raw.baseBranch, 4096),
    identity: string(raw.identity, 4096),
  };
}

// Loading substitutes the live binding, so the base branch is not persisted and earlier
// versions' strict readers can still open records written by this one.
function persistedBinding({ repository, taskId, title, workspace, branch, identity }: AcpBinding) {
  return { repository, taskId, title, workspace, branch, identity };
}

function message(value: unknown): AcpMessage {
  const raw = object(value, ['id', 'role', 'text', 'status', 'exitCode', 'exitSignal', 'toolCallId', 'compactionId', 'compaction', 'uncertain']);
  if (typeof raw.role !== 'string' || !['user', 'agent', 'thought', 'tool', 'notice'].includes(raw.role)) throw new Error('Invalid message role.');
  if (raw.exitCode !== undefined && (typeof raw.exitCode !== 'number' || !Number.isSafeInteger(raw.exitCode))) throw new Error('Invalid command exit code.');
  const compaction = raw.compaction === undefined ? undefined : object(raw.compaction, ['summary', 'error']);
  return {
    id: string(raw.id),
    role: raw.role as AcpMessage['role'],
    text: string(raw.text, 1024 * 1024, true),
    status: optionalString(raw.status, 4096),
    exitCode: raw.exitCode as number | undefined,
    exitSignal: optionalString(raw.exitSignal, 128),
    toolCallId: optionalString(raw.toolCallId, 4096),
    compactionId: optionalString(raw.compactionId, 4096),
    compaction: compaction ? { summary: optionalString(compaction.summary, 256_000), error: optionalString(compaction.error, 256_000) } : undefined,
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
    'modelSelection',
    'canLoad',
    'messages',
    'updatedAt',
    'interrupted',
  ]);
  if (raw.schemaVersion !== 1) throw new Error('Unsupported session record version.');
  const savedBinding = binding(raw.binding, expected);
  if (!sameAcpBinding(savedBinding, expected)) throw new Error('The session record does not match the current workspace identity.');
  if (!Array.isArray(raw.messages) || raw.messages.length > MAX_MESSAGES) throw new Error('Too many messages.');
  const signature = optionalString(raw.profileSignature, 64);
  if (signature !== undefined && !HASH.test(signature)) throw new Error('Invalid profile signature.');
  const selection = modelSelection(raw.modelSelection);
  if (raw.modelSelection !== undefined && !selection) throw new Error('Invalid model preference.');
  return {
    schemaVersion: 1,
    id: string(raw.id),
    binding: savedBinding,
    profileId: optionalString(raw.profileId),
    profileSignature: signature,
    sessionId: optionalString(raw.sessionId, 4096),
    agentName: optionalString(raw.agentName, 4096),
    ...(selection ? { modelSelection: selection } : {}),
    canLoad: boolean(raw.canLoad),
    messages: raw.messages.map(message),
    updatedAt: timestamp(raw.updatedAt),
    interrupted: raw.interrupted === undefined ? undefined : boolean(raw.interrupted),
  };
}

function owner(value: unknown, taskKey: string): Owner {
  const raw = object(value, ['schemaVersion', 'taskKey', 'identity', 'hostname', 'pid', 'token', 'createdAt']);
  if (raw.schemaVersion !== 1 || raw.taskKey !== taskKey) throw new Error('Invalid session owner.');
  if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || raw.pid > 2_147_483_647) throw new Error('Invalid process ID.');
  const token = string(raw.token, 36);
  if (!TOKEN.test(token)) throw new Error('Invalid session ownership token.');
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

  constructor(
    directory: string,
    expected: AcpBinding,
    private readonly validateClaim?: () => Promise<void>,
    private readonly validateRecord?: () => Promise<void>,
  ) {
    this.binding = binding(expected);
    if (!path.isAbsolute(directory)) throw new Error('The session storage folder must use an absolute path.');
    this.directory = path.resolve(directory);
    this.assertOutside(this.directory);
    const paths = taskConnectionPaths(this.directory, this.binding.repository, this.binding.taskId);
    this.taskKey = paths.key;
    const key = digest([this.binding.repository, this.binding.taskId, this.binding.identity]);
    this.file = path.join(this.directory, `${key}.json`);
    this.ownerFile = paths.owner;
    this.archiveDirectory = path.join(this.directory, 'archives', key);
    // This short lock only serializes metadata. Holding an ACP owner claim never holds
    // the engine's repository lock and does not supervise agent execution.
    this.mutex = new StateStore(paths.metadata, this.binding.repository);
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
        await this.validateRecord?.();
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
        await this.validateRecord?.();
        await this.readRecord();
        for (const directory of [path.dirname(this.archiveDirectory), this.archiveDirectory]) {
          await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The session archive folder was redirected. Inspect the external data folder.');
        }
        if ((await realpath(this.archiveDirectory)) !== path.join(await realpath(this.directory), 'archives', path.basename(this.archiveDirectory)))
          throw new Error('The session archive folder was redirected. Inspect the external data folder.');
        await this.writeAtomic(path.join(this.archiveDirectory, `${Date.now()}-${randomUUID()}.json`), encoded);
      }),
    );
  }

  claim(): Promise<() => Promise<void>> {
    return this.serialized(() =>
      this.locked(async () => {
        const existing = await this.readOwner();
        if (existing && !this.exited(existing)) this.busy();
        // Deletion publishes its reservation under this same lock, closing the gap
        // between the session's initial validation and acquisition of its connection.
        await this.validateClaim?.();
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

  /** Identifies this connection's existing claim without granting or renewing ownership. */
  claimToken(): string | undefined {
    return this.token;
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
      throw new Error('Session records must be stored outside the primary folder and task workspaces.');
  }

  private async prepareDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The session storage folder was replaced. Inspect the external data folder.');
    this.assertOutside(await realpath(this.directory));
  }

  private encode(value: AcpRecord): string {
    const saved = record(value, this.binding);
    const encoded = `${JSON.stringify({ ...saved, binding: persistedBinding(saved.binding) })}\n`;
    if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) throw new Error('The session record exceeds 8 MiB and cannot be saved. Start a new conversation.');
    return encoded;
  }

  private async readRecord(): Promise<AcpRecord | undefined> {
    try {
      const raw = await this.readJson(this.file, MAX_RECORD_BYTES);
      return raw === undefined ? undefined : record(raw, this.binding);
    } catch (error) {
      throw new Error(
        `Unable to read the session record. The original file has been preserved: ${this.file}. Inspect the file and retry.${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readOwner(): Promise<Owner | undefined> {
    try {
      const raw = await this.readJson(this.ownerFile, MAX_CLAIM_BYTES);
      return raw === undefined ? undefined : owner(raw, this.taskKey);
    } catch (error) {
      throw new Error(
        `Unable to validate the session ownership record. It has been preserved: ${this.ownerFile}. Inspect the file and retry.${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readJson(file: string, max: number): Promise<unknown | undefined> {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('Invalid file type or size.');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > max) throw new Error('Invalid file type or size.');
      // Do not let a growing file bypass the stat limit or allocate an unbounded read buffer.
      const bytes = Buffer.allocUnsafe(max + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, Math.min(64 * 1024, bytes.length - length), null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > max) throw new Error('File size exceeds the limit.');
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
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, file);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt + 1 >= RENAME_ATTEMPTS || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
          // Windows readers or scanners can briefly block replacement. Retry the same
          // durable temporary file so the previous record stays visible until rename succeeds.
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private exited(claim: Owner): boolean {
    // A claim is written once and never refreshed, so its age proves nothing about its owner.
    return claim.hostname === os.hostname() && processExited(claim.pid);
  }

  private async assertWriteOwner() {
    const current = await this.readOwner();
    if (current && (current.token !== this.token || current.pid !== process.pid || current.hostname !== os.hostname())) this.busy();
  }

  private busy(): never {
    // The record is named so a leftover from a crashed window can be inspected and removed.
    throw new Error(`Another Warden window owns this task conversation. Disconnect it in that window first. Owner record: ${this.ownerFile}`);
  }
}
