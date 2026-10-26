import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AuthMethod,
  type ClientConnection,
  type CompactionSummaryChunk,
  type CompactionUpdate,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { AcpControls, AcpMessage, AcpPermission, AcpRecord, AcpSnapshot, AcpStatus } from '@warden/shared';
import type { AcpProfile, AcpSessionOptions } from './contracts.js';
import { availableCommands, configOptions, emptyControls, sessionModes } from './session-controls.js';

declare const __WARDEN_VERSION__: string;
const CLIENT_VERSION = typeof __WARDEN_VERSION__ === 'undefined' ? 'development' : __WARDEN_VERSION__;
const MAX_MESSAGES = 2_000;
const MAX_TEXT = 256_000;
const MAX_HISTORY = 2_000_000;
const MAX_HISTORY_BYTES = 6 * 1024 * 1024;
const MAX_PERMISSION = 32;
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
const TRUNCATION = '\n[内容已截断]';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: string, limit = MAX_TEXT) =>
  value.length > limit ? value.slice(0, Math.max(0, limit - TRUNCATION.length)) + TRUNCATION.slice(0, limit) : value;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const authRequired = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === -32000;

type Permission = {
  view: AcpPermission;
  runtime: Runtime;
  finish(value: RequestPermissionResponse): void;
};
type History = { messages: AcpMessage[]; lastChunk?: { key: string; id: string } };
type Runtime = {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  exit: Promise<void>;
  exited: boolean;
  release(): Promise<void>;
  released?: Promise<void>;
  stopping: boolean;
  initialized: boolean;
  established: boolean;
  resume: boolean;
  sessionId?: string;
  replay?: History;
  pendingUpdates?: SessionNotification[];
  pendingBytes?: number;
  configUpdated?: boolean;
  configRevision?: number;
  modeRevision?: number;
  modeUpdate?: string;
  stderr: string;
};
type Turn = { runtime: Runtime; record: AcpRecord; promise: Promise<void>; cancelling: boolean; sent: boolean; user?: AcpMessage };

/** A task-bound protocol client. Files, commands and any agent-owned background work remain the agent's responsibility. */
export class AcpSession {
  private record: AcpRecord;
  private status: AcpStatus = 'disconnected';
  private error?: string;
  private runtime?: Runtime;
  private generation = 0;
  private initialized?: Promise<void>;
  private connecting = false;
  private authenticating = false;
  private resetting = false;
  private disposed = false;
  private turn?: Turn;
  private history: History;
  private toolDisplays = new WeakMap<AcpMessage, { title: string; content: string }>();
  private permissions = new Map<string, Permission>();
  private authMethods: AuthMethod[] = [];
  private controls: AcpControls = emptyControls();
  private configuration?: { runtime: Runtime };
  private saves: Promise<void> = Promise.resolve();
  private flush?: ReturnType<typeof setTimeout>;
  private disconnecting?: Promise<void>;
  private ownsClaim = false;

  constructor(private readonly options: AcpSessionOptions) {
    this.record = this.emptyRecord();
    this.history = { messages: this.record.messages };
  }

  private emptyRecord(): AcpRecord {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      binding: { ...this.options.binding },
      canLoad: false,
      messages: [],
      updatedAt: new Date().toISOString(),
    };
  }

  snapshot(): AcpSnapshot {
    return structuredClone({
      record: this.record,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      permissions: [...this.permissions.values()].map((permission) => permission.view),
      authMethods: this.authMethods
        .filter((method) => !('type' in method && method.type === 'terminal'))
        .map((method) => ({
          id: method.id,
          name: method.name,
          description:
            'type' in method && method.type === 'terminal'
              ? `${method.description ?? ''} 请先通过 Agent 自己的终端登录；Warden 不提供终端认证。`.trim()
              : (method.description ?? undefined),
        })),
      controls: this.controls,
    });
  }

  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const saved = await this.options.storage.load();
      if (saved) {
        const binding = this.options.binding;
        if (
          ['repository', 'taskId', 'workspace', 'branch', 'identity'].some(
            (key) => saved.binding[key as keyof typeof binding] !== binding[key as keyof typeof binding],
          )
        )
          throw new Error('保存的会话不属于当前任务工作区，请重新打开任务对话');
        this.record = { ...saved, binding: { ...binding } };
        this.history = { messages: this.record.messages };
        this.boundHistory(this.history);
      }
      this.options.changed();
    })();
    return this.initialized;
  }

  private timeout<T>(operation: Promise<T>, description: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(description)), this.options.timeoutMs ?? 15_000);
    });
    return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
  }

  private current(runtime: Runtime) {
    return this.runtime === runtime && this.generation === runtime.generation && !runtime.stopping;
  }

  private notify() {
    this.options.changed();
  }

  private boundHistory(history: History) {
    const currentUser = history === this.history && this.turn?.record === this.record ? this.turn.user : undefined;
    let size = 0;
    let bytes = 0;
    const encodedSizes: number[] = [];
    for (const item of history.messages) {
      item.text = text(item.text);
      size += item.text.length;
      const encoded = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      encodedSizes.push(encoded);
      bytes += encoded;
    }
    let trimmed = false;
    // JSON escapes control characters, so a character limit alone cannot bound the saved bytes.
    // Reserve room for the truncation notice and record metadata outside this message array.
    while (history.messages.length >= MAX_MESSAGES || ((size > MAX_HISTORY || bytes > MAX_HISTORY_BYTES - 1_024) && history.messages.length > 1)) {
      // Keep the active user's message until its completion acknowledgement is persisted.
      const index = history.messages[0] === currentUser ? 1 : 0;
      size -= history.messages.splice(index, 1)[0]!.text.length;
      bytes -= encodedSizes.splice(index, 1)[0]!;
      trimmed = true;
    }
    if (trimmed && history.messages[0]?.status !== 'history_truncated')
      history.messages.unshift({ id: randomUUID(), role: 'notice', text: '较早的本地对话已超出保存上限，当前仅保留最近内容。', status: 'history_truncated' });
  }

  private persist(): Promise<void> {
    if (!this.ownsClaim) return Promise.resolve();
    clearTimeout(this.flush);
    this.flush = undefined;
    this.boundHistory(this.history);
    this.record.updatedAt = new Date().toISOString();
    const copy = structuredClone(this.record);
    const save = this.saves.catch(() => undefined).then(() => this.options.storage.save(copy));
    this.saves = save;
    return save;
  }

  private changed() {
    this.boundHistory(this.history);
    this.notify();
    if (this.flush) return;
    this.flush = setTimeout(() => {
      this.flush = undefined;
      void this.persist().catch((error) => {
        this.error = `无法保存本地会话：${message(error)}`;
        this.notify();
      });
    }, 100);
  }

  private validateProfile(profile: AcpProfile) {
    if (
      !profile.id ||
      profile.id.length > 500 ||
      typeof profile.label !== 'string' ||
      profile.label.length > 1_000 ||
      !profile.command?.trim() ||
      profile.command.includes('\0') ||
      !Array.isArray(profile.args) ||
      profile.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
      Object.entries(profile.env ?? {}).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))
    )
      throw new Error('Agent 配置无效，请检查可执行文件、参数和环境变量');
  }

  private signature(profile: AcpProfile) {
    // Credential rotation does not change the provider identity. Never persist environment values.
    return createHash('sha256')
      .update(JSON.stringify([profile.id, profile.command, profile.args, Object.keys(profile.env ?? {}).sort()]))
      .digest('hex');
  }

  async connect(profile: AcpProfile, options: { resume: boolean }): Promise<void> {
    if (this.disposed) throw new Error('此任务对话已关闭');
    if (this.connecting || this.runtime || this.disconnecting || this.resetting) throw new Error('Agent 已连接或连接操作尚未结束');
    this.validateProfile(profile);
    this.connecting = true;
    const generation = ++this.generation;
    let release: (() => Promise<void>) | undefined;
    let runtime: Runtime | undefined;
    try {
      await this.initialize();
      await this.options.validate();
      const signature = this.signature(profile);
      if (this.record.profileId && this.record.profileId !== profile.id) throw new Error('切换 Agent 前请显式新建会话，旧记录将保留');
      if (options.resume) {
        if (!this.record.sessionId) throw new Error('没有可恢复的 Agent 会话，请新建会话');
        if (this.record.profileId !== profile.id || this.record.profileSignature !== signature)
          throw new Error('Agent 配置已变化，请使用原配置继续会话，或显式新建会话');
      } else if (this.record.sessionId) throw new Error('已有历史会话，请选择继续会话或先新建会话');
      this.status = 'connecting';
      this.error = undefined;
      this.controls = emptyControls();
      this.notify();
      release = await this.options.storage.claim();
      if (generation !== this.generation || this.disposed) throw new Error('连接已取消');
      // Another window may have advanced the saved conversation while this panel was open.
      // Claim first, then reload, so connecting can never overwrite its more recent history.
      const latest = await this.options.storage.load();
      if (latest) {
        const previousId = this.record.id;
        const binding = this.options.binding;
        if (
          ['repository', 'taskId', 'workspace', 'branch', 'identity'].some(
            (key) => latest.binding[key as keyof typeof binding] !== binding[key as keyof typeof binding],
          )
        )
          throw new Error('保存的会话归属已变化，请重新打开任务对话');
        this.record = { ...latest, binding: { ...binding } };
        this.history = { messages: this.record.messages };
        if (latest.id !== previousId) throw new Error('另一窗口已更换会话，已刷新本地记录；请重新选择继续或新建会话');
        if (options.resume && (this.record.profileId !== profile.id || this.record.profileSignature !== signature || !this.record.sessionId))
          throw new Error('保存的 Agent 会话已变化，请重新选择继续或新建会话');
        if (!options.resume && this.record.sessionId) throw new Error('另一窗口已建立会话，请显式继续会话或新建会话');
      }
      await this.options.validate();
      if (generation !== this.generation || this.disposed) throw new Error('连接已取消');
      this.record.profileId = profile.id;
      this.record.profileSignature = signature;
      this.ownsClaim = true;
      runtime = this.spawn(profile, generation, release, options.resume);
      release = undefined;
      this.runtime = runtime;
      const initialized = await this.timeout(
        runtime.connection.agent.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'warden', title: 'Warden', version: CLIENT_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
          },
        }),
        'Agent 初始化超时，请检查该命令是否支持 ACP，然后重新连接',
      );
      if (!this.current(runtime)) throw new Error('连接已结束');
      if (!object(initialized) || initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('Agent 返回了无效或不兼容的 ACP 协议版本');
      runtime.initialized = true;
      this.authMethods = Array.isArray(initialized.authMethods)
        ? initialized.authMethods
            .filter(
              (method) =>
                object(method) &&
                typeof method.id === 'string' &&
                !!method.id &&
                method.id.length <= 500 &&
                typeof method.name === 'string' &&
                method.name.length <= 1_000 &&
                (method.description == null || typeof method.description === 'string') &&
                (!('type' in method) || method.type === 'terminal'),
            )
            .slice(0, 32)
        : [];
      const info = initialized.agentInfo;
      this.record.agentName =
        typeof info?.title === 'string' ? text(info.title, 1_000) : typeof info?.name === 'string' ? text(info.name, 1_000) : profile.label;
      this.record.canLoad = initialized.agentCapabilities?.loadSession === true;
      await this.openSession(runtime);
    } catch (error) {
      if (generation === this.generation) {
        this.status = 'error';
        this.error = authRequired(error) ? 'Agent 需要登录。请选择其支持的认证方式，或在外部完成登录后重新连接。' : `无法连接 Agent：${message(error)}`;
        this.notify();
      }
      if (runtime && !(runtime.initialized && authRequired(error))) await this.stopRuntime(runtime).catch(() => undefined);
      if (release) {
        await release();
        this.ownsClaim = false;
      }
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  private spawn(profile: AcpProfile, generation: number, release: () => Promise<void>, resume: boolean): Runtime {
    const child = spawn(profile.command, profile.args, {
      cwd: this.options.binding.workspace,
      env: { ...process.env, ...profile.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const runtime = { generation, child, exit, release, exited: false, stopping: false, initialized: false, established: false, resume, stderr: '' } as Runtime;
    const app = client({ name: 'Warden' })
      .onNotification('session/update', ({ params }) => this.update(runtime, params))
      .onRequest('session/request_permission', ({ params, signal }) => this.permission(runtime, params, signal));
    runtime.connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 2 * 1024 * 1024 }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      runtime.stderr = (runtime.stderr + chunk).slice(-8_192);
    });
    const ended = (reason: string) => {
      if (runtime.exited) return;
      runtime.exited = true;
      exited();
      if (this.current(runtime)) {
        this.error = reason;
        this.status = 'error';
        this.controls = emptyControls();
        if (this.turn?.runtime === runtime) this.record.interrupted = true;
        this.cancelPermissions(runtime);
        this.changed();
      }
      runtime.connection.close();
      void this.releaseRuntime(runtime).catch((error) => {
        if (generation === this.generation) {
          this.error = `Agent 已退出，但会话占用记录无法释放：${message(error)}`;
          this.notify();
        }
      });
    };
    child.once('exit', (code, signal) => ended(`Agent 进程已退出（${signal ?? code ?? '未知状态'}），请检查配置或显式继续会话。`));
    child.once('error', (error) => {
      if (!child.pid) ended(`无法启动 Agent：${message(error)}。请检查当前工作区宿主中的可执行文件路径。`);
    });
    void runtime.connection.closed.then(() => {
      if (this.current(runtime) && !runtime.exited) {
        this.status = 'error';
        this.error = 'ACP 连接已断开，本轮结果可能不完整；请检查代码后显式重新连接。';
        this.controls = emptyControls();
        if (this.turn?.runtime === runtime) this.record.interrupted = true;
        this.cancelPermissions(runtime);
        this.changed();
        void this.stopRuntime(runtime).catch((error) => {
          this.error = message(error);
          this.notify();
        });
      }
    });
    return runtime;
  }

  private async openSession(runtime: Runtime) {
    await this.options.validate();
    if (!this.current(runtime)) throw new Error('连接已结束');
    if (runtime.resume) {
      if (!this.record.canLoad) throw new Error('此 Agent 不支持恢复会话，请显式新建会话；旧记录将保留');
      const sessionId = this.record.sessionId!;
      runtime.sessionId = sessionId;
      runtime.replay = { messages: [] };
      try {
        const session = await this.timeout(
          runtime.connection.agent.request('session/load', { sessionId, cwd: this.options.binding.workspace, mcpServers: [] }),
          '恢复会话超时，请重新连接；Warden 不会自动重发消息',
        );
        if (!this.current(runtime)) throw new Error('连接已结束');
        this.initialControls(runtime, session);
        const uncertain = this.record.messages.filter((item) => item.role === 'user' && item.uncertain);
        this.record.messages = [...runtime.replay.messages, ...uncertain];
        this.history = { messages: this.record.messages };
      } finally {
        runtime.replay = undefined;
      }
    } else {
      // Agents can advertise session controls in the same stream batch as the new-session
      // response. Buffer that bounded setup window until its session ID is known.
      runtime.pendingUpdates = [];
      runtime.pendingBytes = 0;
      const session = await this.timeout(
        runtime.connection.agent.request('session/new', { cwd: this.options.binding.workspace, mcpServers: [] }),
        '创建 Agent 会话超时，请检查 Agent 后重新连接',
      );
      if (!this.current(runtime)) throw new Error('连接已结束');
      if (!object(session) || typeof session.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 500)
        throw new Error('Agent 返回了无效的会话标识，请检查 ACP 兼容性');
      runtime.sessionId = session.sessionId;
      this.record.sessionId = session.sessionId;
      this.initialControls(runtime, session);
      const pending = runtime.pendingUpdates;
      runtime.pendingUpdates = undefined;
      runtime.pendingBytes = undefined;
      for (const update of pending) this.update(runtime, update);
    }
    await this.persist();
    if (!this.current(runtime)) throw new Error('连接已结束');
    runtime.established = true;
    this.status = 'connected';
    this.error = undefined;
    this.notify();
  }

  send(value: string): Promise<void> {
    if (!value.trim() || value.length > 100_000) return Promise.reject(new Error('消息不能为空，且不能超过 100000 个字符'));
    const runtime = this.runtime;
    if (!runtime || !this.current(runtime) || !runtime.sessionId || this.status !== 'connected') return Promise.reject(new Error('请先连接 Agent 会话'));
    if (this.turn || this.connecting || this.authenticating || this.configuration) return Promise.reject(new Error('此会话已有请求正在进行，请等待或停止本轮'));
    const turn: Turn = { runtime, record: this.record, promise: Promise.resolve(), cancelling: false, sent: false };
    this.turn = turn;
    turn.promise = this.runPrompt(turn, value);
    return turn.promise;
  }

  private async runPrompt(turn: Turn, value: string) {
    const runtime = turn.runtime;
    let completed = false;
    try {
      await this.options.validate();
      if (!this.current(runtime) || turn.cancelling) throw new Error('发送已取消');
      turn.user = { id: randomUUID(), role: 'user', text: value, status: '发送中', uncertain: true };
      this.record.messages.push(turn.user);
      this.record.interrupted = true;
      this.history.lastChunk = undefined;
      this.status = 'running';
      this.error = undefined;
      await this.persist();
      this.notify();
      if (!this.current(runtime) || turn.cancelling) {
        turn.user.uncertain = false;
        turn.user.status = '发送前已取消';
        this.record.interrupted = false;
        completed = true;
        return;
      }
      turn.sent = true;
      const result = await runtime.connection.agent.request('session/prompt', { sessionId: runtime.sessionId!, prompt: [{ type: 'text', text: value }] });
      if (this.record !== turn.record) return;
      if (!object(result) || typeof result.stopReason !== 'string' || !STOP_REASONS.has(result.stopReason))
        throw new Error('Agent 返回了无效的本轮结束结果，无法确认是否完成');
      turn.user.uncertain = false;
      turn.user.status = result.stopReason === 'cancelled' ? '本轮已取消' : `已响应 · ${result.stopReason}`;
      this.record.interrupted = false;
      completed = true;
    } catch (error) {
      if (this.record === turn.record && turn.sent) this.record.interrupted = true;
      if (this.current(runtime)) {
        this.status = 'error';
        this.error = `本轮请求未完成：${message(error)}。请检查已有改动；Warden 不会自动重发。`;
      }
      throw error;
    } finally {
      this.cancelPermissions(runtime);
      this.history.lastChunk = undefined;
      try {
        if (this.record === turn.record)
          await this.persist().catch((error) => {
            if (this.current(runtime)) {
              this.status = 'error';
              this.error = `保存会话失败：${message(error)}。请检查会话记录后重新连接。`;
            }
            throw error;
          });
        // A completed response can become visible while its final save is pending.
        // Keep the turn busy until both persistence and teardown have finished.
        if (completed && this.current(runtime)) {
          this.status = 'connected';
          this.error = undefined;
        }
      } finally {
        if (this.turn === turn) this.turn = undefined;
        this.notify();
      }
    }
  }

  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.cancelling = true;
    this.status = 'cancelling';
    this.cancelPermissions(turn.runtime);
    this.notify();
    try {
      if (turn.sent)
        await this.timeout(turn.runtime.connection.agent.notify('session/cancel', { sessionId: turn.runtime.sessionId! }), '取消通知未能送达，请断开 Agent');
      await this.timeout(
        turn.promise.catch(() => undefined),
        'Agent 尚未结束本轮，结果仍不确定；可选择断开 Agent 以结束其进程',
      );
    } catch (error) {
      if (this.turn === turn) {
        this.status = 'error';
        this.error = message(error);
        this.notify();
      }
      throw error;
    }
  }

  async authenticate(methodId: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !this.current(runtime) || !runtime.initialized) throw new Error('请先连接 Agent 以获取认证方式');
    if (this.turn || this.connecting || this.authenticating || this.configuration) throw new Error('请等待当前请求结束后再登录');
    const method = this.authMethods.find((item) => item.id === methodId);
    if (!method) throw new Error('Agent 未提供此认证方式');
    if ('type' in method && method.type === 'terminal') throw new Error('此认证方式需要 Agent 自己的终端，请在外部完成登录后重新连接');
    this.authenticating = true;
    try {
      await this.options.validate();
      await this.timeout(runtime.connection.agent.request('authenticate', { methodId }), 'Agent 登录等待超时，请检查外部登录状态后重连');
      if (!this.current(runtime)) throw new Error('连接已结束');
      if (!runtime.established) await this.openSession(runtime);
      else {
        this.status = 'connected';
        this.error = undefined;
        this.notify();
      }
    } catch (error) {
      if (this.current(runtime)) {
        this.status = 'error';
        this.error = `Agent 登录失败：${message(error)}`;
        this.notify();
      }
      // A timeout does not cancel the old RPC. Retire this connection before another login or
      // load can accept delayed updates from the abandoned request into a newer replay buffer.
      if (!authRequired(error))
        await this.stopRuntime(runtime).catch((stopError) => {
          this.error = `Agent 登录失败：${message(error)}；${message(stopError)}`;
          this.notify();
        });
      throw error;
    } finally {
      this.authenticating = false;
    }
  }

  private initialControls(runtime: Runtime, session: unknown) {
    if (!object(session)) return;
    if (Array.isArray(session.configOptions) && !runtime.configUpdated) {
      this.controls.configOptions = configOptions(session.configOptions);
      delete this.controls.modes;
    } else if (this.controls.configOptions === undefined) {
      this.controls.modes = sessionModes(session.modes);
      if (this.controls.modes && runtime.modeUpdate !== undefined) this.controls.modes.currentModeId = runtime.modeUpdate;
    }
  }

  setConfigOption(configId: string, value: string | boolean): Promise<void> {
    const option = this.controls.configOptions?.find((item) => item.id === configId);
    if (!option || (option.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string' || !option.options.some((item) => item.value === value)))
      return Promise.reject(new Error('请选择 Agent 当前提供的配置值'));
    return this.configure((runtime) => {
      const current = this.controls.configOptions?.find((item) => item.id === configId);
      if (!current || (current.type === 'boolean' ? typeof value !== 'boolean' : !current.options.some((item) => item.value === value)))
        throw new Error('Agent 的配置选项已变化，请重新选择');
      return runtime.connection.agent
        .request('session/set_config_option', {
          sessionId: runtime.sessionId!,
          configId,
          ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value }),
        })
        .then((result) => {
          // Capture at the direct response continuation, before the SDK dispatches following
          // notifications. The timeout wrapper resumes later and must not overwrite them.
          const revision = runtime.configRevision;
          return () => {
            if (runtime.configRevision !== revision) return;
            this.controls.configOptions = configOptions(result.configOptions);
            delete this.controls.modes;
          };
        });
    });
  }

  setMode(modeId: string): Promise<void> {
    if (this.controls.configOptions !== undefined || !this.controls.modes?.availableModes.some((mode) => mode.id === modeId))
      return Promise.reject(new Error('请选择 Agent 当前提供的会话模式'));
    return this.configure((runtime) => {
      if (this.controls.configOptions !== undefined || !this.controls.modes?.availableModes.some((mode) => mode.id === modeId))
        throw new Error('Agent 的会话模式已变化，请重新选择');
      return runtime.connection.agent.request('session/set_mode', { sessionId: runtime.sessionId!, modeId }).then(() => {
        const revision = runtime.modeRevision;
        return () => {
          if (runtime.modeRevision === revision && this.controls.configOptions === undefined && this.controls.modes) this.controls.modes.currentModeId = modeId;
        };
      });
    });
  }

  private async configure(request: (runtime: Runtime) => Promise<() => void>): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !this.current(runtime) || !runtime.established || this.status !== 'connected') throw new Error('请先连接 Agent 会话并等待当前请求结束');
    if (this.turn || this.connecting || this.authenticating || this.configuration) throw new Error('请等待当前请求结束后再修改会话配置');
    const operation = { runtime };
    this.configuration = operation;
    this.controls.configuring = true;
    this.notify();
    let sent = false;
    let timedOut = false;
    try {
      await this.options.validate();
      if (!this.current(runtime)) throw new Error('连接已结束');
      sent = true;
      const apply = await this.timeout(request(runtime), '会话配置更新超时，请重新连接以确认 Agent 的当前配置').catch((error) => {
        timedOut = error instanceof Error && error.message.startsWith('会话配置更新超时');
        throw error;
      });
      if (!this.current(runtime)) throw new Error('连接已结束');
      apply();
      this.error = undefined;
    } catch (error) {
      if (this.current(runtime)) {
        this.error = `无法修改会话配置：${message(error)}`;
        // A timed-out RPC may still change the agent later. Retire its connection before
        // accepting another prompt or configuration request with an uncertain value.
        if (sent && timedOut) {
          this.status = 'error';
          this.controls = emptyControls();
          await this.stopRuntime(runtime);
        }
      }
      throw error;
    } finally {
      if (this.configuration === operation) {
        this.configuration = undefined;
        this.controls.configuring = false;
        this.notify();
      }
    }
  }

  private update(runtime: Runtime, notification: SessionNotification) {
    if (!this.current(runtime)) return;
    if (!runtime.sessionId && runtime.pendingUpdates) {
      const bytes = Buffer.byteLength(JSON.stringify(notification), 'utf8');
      if (runtime.pendingUpdates.length < 100 && (runtime.pendingBytes ?? 0) + bytes <= 2 * 1024 * 1024) {
        runtime.pendingUpdates.push(notification);
        runtime.pendingBytes = (runtime.pendingBytes ?? 0) + bytes;
      }
      return;
    }
    if (notification.sessionId !== runtime.sessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === 'config_option_update') {
      runtime.configUpdated = true;
      runtime.configRevision = (runtime.configRevision ?? 0) + 1;
      this.controls.configOptions = configOptions(update.configOptions);
      delete this.controls.modes;
    } else if (update.sessionUpdate === 'current_mode_update') {
      runtime.modeRevision = (runtime.modeRevision ?? 0) + 1;
      runtime.modeUpdate = text(update.currentModeId, 500);
      if (this.controls.configOptions === undefined && this.controls.modes) this.controls.modes.currentModeId = text(update.currentModeId, 500);
    } else if (update.sessionUpdate === 'available_commands_update') {
      this.controls.commands = availableCommands(update.availableCommands);
    } else if (update.sessionUpdate === 'session_info_update') {
      if (update.title === null) delete this.controls.title;
      else if (update.title !== undefined) this.controls.title = text(update.title, 1_000);
    } else if (update.sessionUpdate === 'usage_update') {
      this.controls.usage = {
        used: update.used,
        size: update.size,
        ...(update.cost ? { cost: { amount: update.cost.amount, currency: text(update.cost.currency, 32) } } : {}),
      };
    } else if (update.sessionUpdate === 'notice') {
      this.controls.notices.push({
        id: randomUUID(),
        title: text(update.title, 1_000),
        ...(update.description == null ? {} : { description: text(update.description, 4_000) }),
        severity: text(update.severity, 100),
      });
      this.controls.notices = this.controls.notices.slice(-32);
    } else if (update.sessionUpdate === 'compaction_update' || update.sessionUpdate === 'compaction_summary_chunk') {
      this.compaction(runtime.replay ?? this.history, update);
      if (!runtime.replay) this.changed();
      return;
    } else {
      this.historyUpdate(runtime, notification);
      return;
    }
    this.notify();
  }

  private historyUpdate(runtime: Runtime, notification: SessionNotification) {
    const history = runtime.replay ?? (this.turn?.runtime === runtime ? this.history : undefined);
    if (!history) return;
    const update = notification.update;
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk' ||
      (runtime.replay && update.sessionUpdate === 'user_message_chunk')
    ) {
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'agent';
      const value = update.content.type === 'text' ? update.content.text : `[当前仅支持文本，未显示 ${update.content.type} 内容]`;
      const key = `${role}:${update.messageId ?? ''}`;
      const previous = history.lastChunk?.key === key ? history.messages.find((item) => item.id === history.lastChunk!.id) : undefined;
      if (previous) previous.text = text(previous.text + value);
      else {
        const item: AcpMessage = { id: randomUUID(), role, text: text(value) };
        history.messages.push(item);
        history.lastChunk = { key, id: item.id };
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.tool(history, update);
    } else if (update.sessionUpdate === 'plan') {
      history.messages.push({ id: randomUUID(), role: 'notice', text: text(update.entries.map((entry) => `${entry.status}: ${entry.content}`).join('\n')) });
      history.lastChunk = undefined;
    }
    this.boundHistory(history);
    if (!runtime.replay) this.changed();
  }

  private compaction(history: History, update: CompactionUpdate | CompactionSummaryChunk) {
    const compactionId =
      update.compactionId.length > 4_000 || update.compactionId.startsWith('warden-sha256:')
        ? `warden-sha256:${createHash('sha256').update(update.compactionId).digest('hex')}`
        : update.compactionId;
    let item = history.messages.find((entry) => entry.compactionId === compactionId);
    if (!item) {
      item = { id: randomUUID(), role: 'notice', compactionId, compaction: {}, text: '上下文压缩', status: 'in_progress' };
      history.messages.push(item);
    }
    item.compaction ??= {};
    const display = item.compaction;
    const content = (block: ContentBlock) => (block.type === 'text' ? block.text : `[当前仅支持文本，未显示 ${block.type} 内容]`);
    if ('status' in update) {
      item.status = text(update.status, 100);
      if (update.summary !== undefined) {
        if (update.summary === null || update.summary.length === 0) delete display.summary;
        else display.summary = text(update.summary.map(content).join('\n'));
      }
      if (update.error !== undefined) {
        if (update.error === null) delete display.error;
        else display.error = text(update.error);
      }
    } else display.summary = text((display.summary ?? '') + content(update.content));
    item.text = text(['上下文压缩', display.summary, display.error].filter(Boolean).join('\n'));
    history.lastChunk = undefined;
    this.boundHistory(history);
  }

  private tool(history: History, update: ToolCallUpdate) {
    // Tool IDs are opaque and unbounded in ACP. Keep their association without allowing an
    // agent-controlled ID to exceed the local record format; reserve the hash namespace too.
    const toolCallId =
      update.toolCallId.length > 4_000 || update.toolCallId.startsWith('warden-sha256:')
        ? `warden-sha256:${createHash('sha256').update(update.toolCallId).digest('hex')}`
        : update.toolCallId;
    let item = history.messages.find((entry) => entry.toolCallId === toolCallId);
    if (!item) {
      item = { id: randomUUID(), role: 'tool', toolCallId, text: update.title ?? 'Agent 操作' };
      history.messages.push(item);
    }
    // ACP replaces title and content independently. Keep their display state with the
    // message so replay adoption preserves it and history truncation can release it.
    let display = this.toolDisplays.get(item);
    if (!display) {
      display = { title: item.text, content: '' };
      this.toolDisplays.set(item, display);
    }
    if (update.title != null) display.title = text(update.title);
    if (update.status) item.status = update.status;
    if (update.content != null) {
      const details = update.content.map((content) => {
        if (content.type === 'content' && content.content.type === 'text') return content.content.text;
        if (content.type === 'diff') return `文件改动：${content.path}（请在任务差异中审查）`;
        return content.type === 'terminal' ? 'Agent 终端活动（Warden 不管理此终端）' : '未显示非文本内容';
      });
      display.content = text(details.join('\n'));
    }
    item.text = text([display.title, display.content].filter(Boolean).join('\n'));
    history.lastChunk = undefined;
  }

  private permission(runtime: Runtime, request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (
      !this.current(runtime) ||
      request.sessionId !== runtime.sessionId ||
      this.turn?.runtime !== runtime ||
      this.turn.cancelling ||
      signal.aborted ||
      this.permissions.size >= MAX_PERMISSION
    )
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const id = randomUUID();
    const view: AcpPermission = {
      id,
      title: text(request.toolCall.title ?? 'Agent 请求授权', 1_000),
      detail: text(JSON.stringify(request.toolCall.rawInput ?? request.toolCall.locations ?? request.toolCall.content ?? '', null, 2), 12_000),
      options: request.options.map((option) => ({ id: option.optionId, label: option.name, kind: option.kind })),
    };
    return new Promise((resolve) => {
      const cancelled = () => finish({ outcome: { outcome: 'cancelled' } });
      const finish = (response: RequestPermissionResponse) => {
        if (!this.permissions.delete(id)) return;
        signal.removeEventListener('abort', cancelled);
        if (this.current(runtime) && this.turn?.runtime === runtime && !this.turn.cancelling)
          this.status = this.permissions.size ? 'waiting_permission' : 'running';
        resolve(response);
        this.notify();
      };
      this.permissions.set(id, { view, runtime, finish });
      signal.addEventListener('abort', cancelled, { once: true });
      this.status = 'waiting_permission';
      this.notify();
    });
  }

  async respondPermission(requestId: string, optionId: string): Promise<void> {
    const permission = this.permissions.get(requestId);
    if (!permission || !this.current(permission.runtime) || this.turn?.cancelling) throw new Error('此授权请求已结束，请查看当前会话');
    if (!permission.view.options.some((option) => option.id === optionId)) throw new Error('请选择 Agent 实际提供的授权选项');
    return this.options.validate().then(
      () => {
        if (this.permissions.get(requestId) !== permission || !this.current(permission.runtime) || this.turn?.cancelling)
          throw new Error('此授权请求已结束，请查看当前会话');
        permission.finish({ outcome: { outcome: 'selected', optionId } });
      },
      (error) => {
        permission.finish({ outcome: { outcome: 'cancelled' } });
        throw error;
      },
    );
  }

  private cancelPermissions(runtime?: Runtime) {
    for (const permission of [...this.permissions.values()])
      if (!runtime || permission.runtime === runtime) permission.finish({ outcome: { outcome: 'cancelled' } });
  }

  private async releaseRuntime(runtime: Runtime) {
    if (!runtime.exited) throw new Error('Agent 进程尚未确认退出，已保留会话占用记录');
    runtime.released ??= (async () => {
      const turn = this.turn?.runtime === runtime ? this.turn : undefined;
      if (turn) await turn.promise.catch(() => undefined);
      await this.persist();
      await runtime.release();
      this.ownsClaim = false;
      if (this.runtime === runtime) this.runtime = undefined;
    })();
    const released = runtime.released;
    try {
      await released;
    } catch (error) {
      if (runtime.released === released) runtime.released = undefined;
      throw error;
    }
  }

  private async stopRuntime(runtime: Runtime) {
    runtime.stopping = true;
    this.cancelPermissions(runtime);
    runtime.connection.close();
    runtime.child.stdin.destroy();
    if (!runtime.exited) {
      runtime.child.kill('SIGTERM');
      try {
        await this.timeout(runtime.exit, 'Agent 尚未退出');
      } catch {
        if (!runtime.exited) runtime.child.kill('SIGKILL');
        await this.timeout(runtime.exit, '无法确认 Agent 进程已退出，已保留占用记录；请检查该进程后重试断开');
      }
    }
    runtime.child.stdout.destroy();
    runtime.child.stderr.destroy();
    await this.releaseRuntime(runtime);
  }

  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    const operation = (async () => {
      ++this.generation;
      const runtime = this.runtime;
      this.controls = emptyControls();
      this.configuration = undefined;
      this.cancelPermissions();
      if (this.turn?.sent) this.record.interrupted = true;
      if (runtime) await this.stopRuntime(runtime);
      if (this.turn)
        await this.timeout(
          this.turn.promise.catch(() => undefined),
          'Agent 已断开，但本地请求仍未结束，请重试',
        );
      this.status = 'disconnected';
      this.error = undefined;
      this.authMethods = [];
      this.notify();
    })();
    this.disconnecting = operation;
    void operation
      .finally(() => {
        if (this.disconnecting === operation) this.disconnecting = undefined;
      })
      .catch(() => undefined);
    return operation;
  }

  async newConversation(): Promise<void> {
    if (this.disposed) throw new Error('此任务对话已关闭');
    if (this.resetting || this.connecting) throw new Error('会话操作尚未结束，请稍候');
    this.resetting = true;
    try {
      await this.initialize();
      await this.disconnect();
      const release = await this.options.storage.claim();
      this.ownsClaim = true;
      try {
        await this.options.validate();
        const latest = await this.options.storage.load();
        if (latest && (latest.messages.length || latest.sessionId)) await this.options.storage.archive(latest);
        this.record = this.emptyRecord();
        this.history = { messages: this.record.messages };
        await this.persist();
        this.notify();
      } finally {
        await release();
        this.ownsClaim = false;
      }
    } finally {
      this.resetting = false;
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    await this.disconnect();
    clearTimeout(this.flush);
    await this.saves;
  }
}
