import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { markUnsettledTools, updateToolOutput, type ToolDisplay } from './tool-output.js';
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
// System prompts are an opt-in draft capability; keep the rest of the client on stable types.
import type { SessionCapabilities as DraftSessionCapabilities, SystemPrompt } from '@agentclientprotocol/sdk/unstable';
import type { AcpControls, AcpMessage, AcpPermission, AcpRecord, AcpSnapshot, AcpStatus } from '@warden/shared';
import { DiagnosticLog, diagnosticError, diagnosticOutcome } from '@warden/shared';
import type { DiagnosticOutcome } from '@warden/shared';
import type { AcpProfile, AcpSessionOptions } from './contracts.js';
import { availableCommands, configOptions, emptyControls, isModelOption, sessionModes } from './session-controls.js';
import { AcpStderr, acpDiagnosticSecrets, acpErrorMessage, acpFailureLog } from './diagnostics.js';
import { approveRepositoryRead, repositoryReadRequest } from './read-permissions.js';
import { workspaceContext, workspaceContextFallback } from './workspace-context.js';
import { sameAcpBinding } from './binding.js';

declare const __WARDEN_VERSION__: string;
const CLIENT_VERSION = typeof __WARDEN_VERSION__ === 'undefined' ? 'development' : __WARDEN_VERSION__;
const MAX_MESSAGES = 2_000;
const MAX_TEXT = 256_000;
const MAX_HISTORY = 2_000_000;
const MAX_HISTORY_BYTES = 6 * 1024 * 1024;
const MAX_PERMISSION = 32;
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
const TRUNCATION = '\n[Content truncated]';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: string, limit = MAX_TEXT) =>
  value.length > limit ? value.slice(0, Math.max(0, limit - TRUNCATION.length)) + TRUNCATION.slice(0, limit) : value;
const message = acpErrorMessage;
const authRequired = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === -32000;
const missingRollout = (error: unknown, sessionId: string) => {
  if (!object(error) || error.code !== -32603) return false;
  const details = typeof error.data === 'string' ? error.data : object(error.data) ? error.data.details : undefined;
  return typeof details === 'string' && details.includes(`no rollout found for thread id ${sessionId}`);
};

type Permission = {
  view: AcpPermission;
  runtime: Runtime;
  checking: boolean;
  finish(value: RequestPermissionResponse): void;
};
type History = { messages: AcpMessage[]; lastChunk?: { key: string; id: string } };
type Runtime = {
  log: DiagnosticLog;
  profile: AcpProfile;
  generation: number;
  child: ChildProcessWithoutNullStreams;
  started: Promise<void>;
  connection: ClientConnection;
  exit: Promise<void>;
  exited: boolean;
  release(): Promise<void>;
  released?: Promise<void>;
  stopping: boolean;
  initialized: boolean;
  established: boolean;
  authenticationRequired?: boolean;
  resume: boolean;
  sessionId?: string;
  systemPrompt?: SystemPrompt;
  replay?: History;
  pendingUpdates?: SessionNotification[];
  pendingBytes?: number;
  configUpdated?: boolean;
  configRevision?: number;
  modeRevision?: number;
  modeUpdate?: string;
  stderr: AcpStderr;
};
type Turn = {
  id: string;
  updates: number;
  runtime: Runtime;
  record: AcpRecord;
  promise: Promise<void>;
  cancelling: boolean;
  sent: boolean;
  input: string;
  user?: AcpMessage;
};

/** A task-bound protocol client. Files, commands and any agent-owned background work remain the agent's responsibility. */
export class AcpSession {
  private readonly log: DiagnosticLog;
  private readonly environment: string;
  private loggedStatus: AcpStatus = 'disconnected';
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
  private toolDisplays = new WeakMap<AcpMessage, ToolDisplay>();
  private permissions = new Map<string, Permission>();
  private authMethods: AuthMethod[] = [];
  private controls: AcpControls = emptyControls();
  private configuration?: { runtime: Runtime };
  private saves: Promise<void> = Promise.resolve();
  private flush?: ReturnType<typeof setTimeout>;
  private disconnecting?: Promise<void>;
  private ownsClaim = false;

  constructor(private readonly options: AcpSessionOptions) {
    this.log = (options.log ?? new DiagnosticLog()).child({ component: 'acp.task', task: options.binding.taskId, conversation: randomUUID() });
    this.environment = workspaceContext(options.binding);
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
    const runtime = this.runtime;
    // Advertising a login method does not mean the agent needs authentication.
    const needsAuthentication = this.status === 'error' && runtime?.authenticationRequired && runtime.initialized && !runtime.exited && this.current(runtime);
    return structuredClone({
      record: this.record,
      status: this.resetting ? 'resetting' : this.status,
      ...(this.error ? { error: this.error } : {}),
      permissions: [...this.permissions.values()].filter((permission) => !permission.checking).map((permission) => permission.view),
      authMethods: (needsAuthentication ? this.authMethods : [])
        .filter((method) => !('type' in method && method.type === 'terminal'))
        .map((method) => ({
          id: method.id,
          name: method.name,
          description:
            'type' in method && method.type === 'terminal'
              ? `${method.description ?? ''} Log in using the agent's own terminal first; Warden does not provide terminal authentication.`.trim()
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
        if (!sameAcpBinding(saved.binding, binding)) throw new Error('The saved session does not belong to this task workspace. Reopen the task conversation.');
        this.record = { ...saved, binding: { ...binding } };
        markUnsettledTools(this.record.messages);
        this.history = { messages: this.record.messages };
        this.boundHistory(this.history);
      }
      this.log.write('debug', 'acp.history.loaded', { saved: !!saved, messageCount: this.record.messages.length, resumable: !!this.record.sessionId });
      this.options.changed();
    })();
    return this.initialized;
  }

  private timeout<T>(operation: Promise<T>, description: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(description), { name: 'TimeoutError' })), this.options.timeoutMs ?? 15_000);
    });
    return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
  }

  private current(runtime: Runtime) {
    return this.runtime === runtime && this.generation === runtime.generation && !runtime.stopping;
  }

  private notify() {
    if (this.status !== this.loggedStatus) {
      (this.runtime?.log ?? this.log).write('debug', 'acp.session.state', { previous: this.loggedStatus, status: this.status });
      this.loggedStatus = this.status;
    }
    this.options.changed();
  }

  private reportFailure(stage: string, error: unknown, runtime = this.runtime, log = runtime?.log ?? this.log) {
    try {
      const diagnostic = acpFailureLog(stage, error, {
        taskId: this.options.binding.taskId,
        profileId: runtime?.profile.id ?? this.record.profileId,
        stderr: runtime?.stderr.text,
        // Errors echo the typed input, not the stored text with any appended workspace context.
        secrets: [...acpDiagnosticSecrets(runtime?.profile), ...(this.turn ? [this.turn.input] : [])],
      });
      log.write(authRequired(error) ? 'warn' : 'error', 'acp.failure', { stage, ...diagnosticError(error), diagnostic });
      this.options.report?.(diagnostic);
    } catch {
      // Diagnostics must never replace the original connection failure.
    }
  }

  private async request<T>(runtime: Runtime, method: string, operation: () => Promise<T>, description?: string): Promise<T> {
    const span = runtime.log.start('acp.request', { method, turn: this.turn?.runtime === runtime ? this.turn.id : undefined });
    try {
      const result = await (description ? this.timeout(operation(), description) : operation());
      span.end(runtime.generation === this.generation ? 'ok' : 'cancelled');
      return result;
    } catch (error) {
      span.end(runtime.generation === this.generation ? diagnosticOutcome(error) : 'cancelled', diagnosticError(error));
      throw error;
    }
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
      history.messages.unshift({
        id: randomUUID(),
        role: 'notice',
        text: 'Earlier conversation history exceeded the storage limit. Only recent content has been retained.',
        status: 'history_truncated',
      });
  }

  private persist(): Promise<void> {
    if (!this.ownsClaim) return Promise.resolve();
    clearTimeout(this.flush);
    this.flush = undefined;
    this.boundHistory(this.history);
    this.record.updatedAt = new Date().toISOString();
    const copy = structuredClone(this.record);
    const save = this.saves
      .catch(() => undefined)
      .then(() => this.log.measure('acp.storage.save', () => this.options.storage.save(copy), { messageCount: copy.messages.length }, 'trace'));
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
        this.error = `Unable to save the local session: ${message(error)}`;
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
      throw new Error('Invalid agent profile. Check its executable, arguments and environment variables.');
  }

  private signature(profile: AcpProfile) {
    // Credential rotation does not change the provider identity. Never persist environment values.
    return createHash('sha256')
      .update(JSON.stringify([profile.id, profile.command, profile.args, Object.keys(profile.env ?? {}).sort()]))
      .digest('hex');
  }

  async connect(profile: AcpProfile, options: { resume: boolean }): Promise<void> {
    if (this.disposed) throw new Error('This task conversation is closed.');
    if (this.connecting || this.runtime || this.disconnecting || this.resetting)
      throw new Error('The agent is already connected or a connection attempt is still running.');
    this.validateProfile(profile);
    this.connecting = true;
    const log = this.log.child({ connection: randomUUID(), profile: profile.id }, acpDiagnosticSecrets(profile));
    const span = log.start('acp.connect', { resume: options.resume }, 'info');
    let outcome: DiagnosticOutcome = 'error';
    const generation = ++this.generation;
    let release: (() => Promise<void>) | undefined;
    let runtime: Runtime | undefined;
    let stage = 'validate';
    try {
      await this.initialize();
      await this.options.validate();
      const signature = this.signature(profile);
      if (this.record.profileId && this.record.profileId !== profile.id)
        throw new Error('Start a new session before switching agents. The previous record will be preserved.');
      if (options.resume) {
        if (!this.record.sessionId) throw new Error('No agent session is available to resume. Start a new session.');
        if (this.record.profileId !== profile.id || this.record.profileSignature !== signature)
          throw new Error('The agent profile changed. Resume with the original profile or start a new session.');
      } else if (this.record.sessionId) throw new Error('A previous session exists. Resume it or start a new session first.');
      this.status = 'connecting';
      this.error = undefined;
      this.controls = emptyControls();
      this.notify();
      stage = 'claim';
      release = await log.measure('acp.storage.claim', () => this.options.storage.claim());
      if (generation !== this.generation || this.disposed) throw new Error('Connection cancelled.');
      // Another window may have advanced the saved conversation while this panel was open.
      // Claim first, then reload, so connecting can never overwrite its more recent history.
      const latest = await this.options.storage.load();
      if (latest) {
        const previousId = this.record.id;
        const binding = this.options.binding;
        if (!sameAcpBinding(latest.binding, binding)) throw new Error('Saved session ownership changed. Reopen the task conversation.');
        this.record = { ...latest, binding: { ...binding } };
        this.history = { messages: this.record.messages };
        if (latest.id !== previousId)
          throw new Error('Another window replaced the session. Local history was refreshed; choose whether to resume or start a new session.');
        if (options.resume && (this.record.profileId !== profile.id || this.record.profileSignature !== signature || !this.record.sessionId))
          throw new Error('The saved agent session changed. Choose whether to resume or start a new session.');
        if (!options.resume && this.record.sessionId) throw new Error('Another window created a session. Resume it explicitly or start a new session.');
      }
      await this.options.validate();
      if (generation !== this.generation || this.disposed) throw new Error('Connection cancelled.');
      this.record.profileId = profile.id;
      this.record.profileSignature = signature;
      this.ownsClaim = true;
      stage = 'spawn';
      runtime = this.spawn(profile, generation, release, options.resume, log);
      release = undefined;
      this.runtime = runtime;
      // Missing executables must fail before the protocol writes to their closed pipes.
      await log.measure('acp.spawn', () => this.timeout(runtime!.started, 'Starting the agent timed out.'));
      if (!this.current(runtime) || runtime.exited) throw new Error('Connection closed.');
      stage = 'initialize';
      const initialized = await this.request(
        runtime,
        'initialize',
        () =>
          runtime!.connection.agent.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: 'warden', title: 'Warden', version: CLIENT_VERSION },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              _meta: { terminal_output_delta: true },
              session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
            },
          }),
        'Agent initialization timed out. Check that the command supports ACP, then reconnect.',
      );
      if (!this.current(runtime)) throw new Error('Connection closed.');
      if (!object(initialized) || initialized.protocolVersion !== PROTOCOL_VERSION)
        throw new Error('The agent returned an invalid or incompatible ACP protocol version.');
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
      // The draft field is opt-in; an absent, null or malformed capability is not support.
      if (object((initialized.agentCapabilities?.sessionCapabilities as DraftSessionCapabilities | undefined)?.systemPrompt))
        runtime.systemPrompt = { mode: 'append', content: [{ type: 'text', text: this.environment }] };
      log.write('debug', 'acp.negotiated', {
        protocolVersion: initialized.protocolVersion,
        loadSession: this.record.canLoad,
        authMethods: this.authMethods.length,
        agentVersion: initialized.agentInfo?.version,
        workspaceContext: runtime.systemPrompt ? 'system' : 'user',
      });
      stage = options.resume ? 'session/load' : 'session/new';
      await this.openSession(runtime);
      outcome = 'ok';
    } catch (error) {
      outcome = generation !== this.generation ? 'cancelled' : diagnosticOutcome(error);
      if (generation === this.generation) {
        this.reportFailure(stage, error, runtime, log);
        if (runtime) runtime.authenticationRequired = authRequired(error);
        this.status = 'error';
        this.error = authRequired(error)
          ? 'The agent requires authentication. Choose a supported method, or log in externally and reconnect.'
          : `Unable to connect to the agent: ${message(error)}`;
        if (runtime && !runtime.initialized) this.options.connectionFailed?.(profile, this.error);
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
      span.end(outcome, { stage });
    }
  }

  private spawn(profile: AcpProfile, generation: number, release: () => Promise<void>, resume: boolean, log: DiagnosticLog): Runtime {
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
    const runtime = {
      log,
      profile,
      generation,
      child,
      started: once(child, 'spawn').then(() => undefined),
      exit,
      release,
      exited: false,
      stopping: false,
      initialized: false,
      established: false,
      resume,
      stderr: new AcpStderr(),
    } as Runtime;
    const app = client({ name: 'Warden' })
      .onNotification('session/update', ({ params }) => this.update(runtime, params))
      .onRequest('session/request_permission', ({ params, signal }) => this.permission(runtime, params, signal));
    runtime.connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 2 * 1024 * 1024 }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      runtime.stderr.append(chunk);
    });
    child.once('spawn', () => log.write('debug', 'acp.process.started', { pid: child.pid }));
    const ended = (reason: string) => {
      if (runtime.exited) return;
      runtime.exited = true;
      exited();
      if (this.current(runtime)) {
        this.reportFailure('process', new Error(reason), runtime);
        this.error = reason;
        this.options.connectionFailed?.(profile, reason);
        this.status = 'error';
        this.controls = emptyControls();
        if (this.turn?.runtime === runtime) this.record.interrupted = true;
        this.cancelPermissions(runtime);
        this.changed();
      }
      runtime.connection.close();
      void this.releaseRuntime(runtime).catch((error) => {
        this.reportFailure('ownership/release', error, runtime);
        if (generation === this.generation) {
          this.error = `The agent exited, but its session ownership could not be released: ${message(error)}`;
          this.notify();
        }
      });
    };
    child.once('exit', (code, signal) => {
      log.write(runtime.stopping ? 'debug' : 'warn', 'acp.process.exited', { pid: child.pid, exitCode: code, signal, expected: runtime.stopping });
      ended(`The agent process exited (${signal ?? code ?? 'unknown status'}). Check the profile or explicitly resume the session.`);
    });
    child.once('error', (error) => {
      if (!child.pid) ended(`Unable to start the agent: ${message(error)}. Check the executable path on the current workspace host.`);
    });
    void runtime.connection.closed.then(() => {
      log.write('debug', 'acp.transport.closed', { expected: runtime.stopping || runtime.exited });
      if (this.current(runtime) && !runtime.exited) {
        this.status = 'error';
        this.error = 'The ACP connection closed. This turn may be incomplete; inspect the code before reconnecting.';
        this.options.connectionFailed?.(profile, this.error);
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
    if (!this.current(runtime)) throw new Error('Connection closed.');
    const environment = runtime.systemPrompt ? { systemPrompt: runtime.systemPrompt } : {};
    if (runtime.resume) {
      if (!this.record.canLoad) throw new Error('This agent cannot resume sessions. Start a new session explicitly; the previous record will be preserved.');
      const sessionId = this.record.sessionId!;
      runtime.sessionId = sessionId;
      runtime.replay = { messages: [] };
      try {
        const session = await this.request(
          runtime,
          'session/load',
          () => runtime.connection.agent.request('session/load', { sessionId, cwd: this.options.binding.workspace, mcpServers: [], ...environment }),
          'Resuming the session timed out. Reconnect; Warden will not resend messages automatically.',
        ).catch((error) => {
          if (authRequired(error)) this.options.connectionFailed?.(runtime.profile, message(error));
          throw error;
        });
        await this.options.validate();
        if (!this.current(runtime)) throw new Error('Connection closed.');
        this.initialControls(runtime, session);
        const uncertain = this.record.messages.filter((item) => item.role === 'user' && item.uncertain);
        this.record.messages = [...runtime.replay.messages, ...uncertain];
        markUnsettledTools(this.record.messages);
        this.history = { messages: this.record.messages };
      } catch (error) {
        if (
          !this.current(runtime) ||
          !missingRollout(error, sessionId) ||
          this.record.messages.length ||
          this.record.interrupted ||
          runtime.replay.messages.length
        )
          throw error;
        // Codex persists a rollout only after the first prompt. A never-used session can
        // disappear with its process; retain the local conversation and draft when replacing it.
        await this.options.validate();
        if (!this.current(runtime)) throw new Error('Connection closed.');
        runtime.log.write('info', 'acp.session.recreate_empty', { reason: 'missing_rollout' });
        runtime.resume = false;
        runtime.sessionId = undefined;
        this.controls = emptyControls();
      } finally {
        runtime.replay = undefined;
      }
    }
    if (!runtime.resume) {
      // Agents can advertise session controls in the same stream batch as the new-session
      // response. Buffer that bounded setup window until its session ID is known.
      runtime.pendingUpdates = [];
      runtime.pendingBytes = 0;
      const session = await this.request(
        runtime,
        'session/new',
        () => runtime.connection.agent.request('session/new', { cwd: this.options.binding.workspace, mcpServers: [], ...environment }),
        'Creating the agent session timed out. Check the agent and reconnect.',
      ).catch((error) => {
        this.options.connectionFailed?.(runtime.profile, message(error));
        throw error;
      });
      await this.options.validate();
      if (!this.current(runtime)) throw new Error('Connection closed.');
      if (!object(session) || typeof session.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 500) {
        const error = new Error('The agent returned an invalid session ID. Check ACP compatibility.');
        this.options.connectionFailed?.(runtime.profile, error.message);
        throw error;
      }
      runtime.sessionId = session.sessionId;
      this.record.sessionId = session.sessionId;
      this.initialControls(runtime, session);
      const pending = runtime.pendingUpdates;
      runtime.pendingUpdates = undefined;
      runtime.pendingBytes = undefined;
      for (const update of pending) this.update(runtime, update);
    }
    await this.restoreModel(runtime);
    await this.persist();
    if (!this.current(runtime)) throw new Error('Connection closed.');
    runtime.established = true;
    runtime.authenticationRequired = false;
    this.status = 'connected';
    this.error = undefined;
    runtime.log.write('info', 'acp.session.ready', { resumed: runtime.resume, messageCount: this.record.messages.length });
    this.notify();
  }

  send(value: string): Promise<void> {
    if (!value.trim() || value.length > 100_000) return Promise.reject(new Error('Messages must contain 1–100,000 characters.'));
    const runtime = this.runtime;
    if (!runtime || !this.current(runtime) || !runtime.sessionId || this.status !== 'connected')
      return Promise.reject(new Error('Connect to an agent session first.'));
    if (this.turn || this.connecting || this.authenticating || this.configuration)
      return Promise.reject(new Error('A request is already running in this session. Wait or stop this turn.'));
    const turn: Turn = { id: randomUUID(), updates: 0, runtime, record: this.record, promise: Promise.resolve(), cancelling: false, sent: false, input: value };
    this.turn = turn;
    turn.promise = this.runPrompt(turn, value);
    return turn.promise;
  }

  private async runPrompt(turn: Turn, value: string) {
    const runtime = turn.runtime;
    const wasInterrupted = this.record.interrupted;
    const span = runtime.log.start('acp.turn', { turn: turn.id, characters: value.length }, 'info');
    let outcome: DiagnosticOutcome = 'error';
    let completed = false;
    try {
      await this.options.validate();
      if (!this.current(runtime) || turn.cancelling) throw new Error('Send cancelled.');
      const context = runtime.systemPrompt ? '' : workspaceContextFallback(this.environment);
      const prompt: ContentBlock[] = [{ type: 'text', text: value }];
      if (context) prompt.push({ type: 'text', text: context });
      // Record exactly the text sent, including the visible fallback, so replay needs no hidden-message rewriting.
      turn.user = { id: randomUUID(), role: 'user', text: value + context, status: 'Sending', uncertain: true };
      this.record.messages.push(turn.user);
      this.record.interrupted = true;
      this.history.lastChunk = undefined;
      this.status = 'running';
      this.error = undefined;
      await this.persist();
      this.notify();
      await this.options.validate();
      if (!this.current(runtime) || turn.cancelling) {
        turn.user.uncertain = false;
        turn.user.status = 'Cancelled before sending';
        this.record.interrupted = false;
        completed = true;
        return;
      }
      turn.sent = true;
      const result = await this.request(runtime, 'session/prompt', () =>
        runtime.connection.agent.request('session/prompt', { sessionId: runtime.sessionId!, prompt }),
      );
      if (this.record !== turn.record) return;
      if (!object(result) || typeof result.stopReason !== 'string' || !STOP_REASONS.has(result.stopReason))
        throw new Error('The agent returned an invalid turn result. Completion could not be confirmed.');
      turn.user.uncertain = false;
      turn.user.status = result.stopReason === 'cancelled' ? 'Turn cancelled' : `Responded · ${result.stopReason}`;
      this.record.interrupted = false;
      completed = true;
      outcome = result.stopReason === 'cancelled' ? 'cancelled' : 'ok';
      runtime.log.write('debug', 'acp.turn.response', { turn: turn.id, stopReason: result.stopReason });
    } catch (error) {
      outcome = diagnosticOutcome(error);
      if (this.record === turn.record) {
        if (turn.sent) this.record.interrupted = true;
        else if (turn.user) {
          turn.user.uncertain = false;
          turn.user.status = 'Not sent';
          this.record.interrupted = wasInterrupted;
        }
      }
      if (this.current(runtime)) {
        this.reportFailure('session/prompt', error, runtime);
        runtime.authenticationRequired = authRequired(error);
        this.status = 'error';
        this.error = `The turn request did not finish: ${message(error)}. Inspect existing changes; Warden will not resend automatically.`;
        if (turn.sent && !turn.cancelling) this.options.connectionFailed?.(runtime.profile, this.error);
      }
      throw error;
    } finally {
      this.cancelPermissions(runtime);
      this.history.lastChunk = undefined;
      if (this.record === turn.record) markUnsettledTools(this.record.messages);
      try {
        if (this.record === turn.record)
          await this.persist().catch((error) => {
            outcome = 'error';
            if (this.current(runtime)) {
              this.status = 'error';
              this.error = `Unable to save the session: ${message(error)}. Check the session record before reconnecting.`;
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
        span.end(turn.cancelling || runtime.generation !== this.generation ? 'cancelled' : outcome, { sent: turn.sent, updates: turn.updates });
        if (this.turn === turn) this.turn = undefined;
        this.notify();
      }
    }
  }

  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.cancelling = true;
    turn.runtime.log.write('info', 'acp.cancel.requested', { turn: turn.id, sent: turn.sent });
    this.status = 'cancelling';
    this.cancelPermissions(turn.runtime);
    this.notify();
    try {
      if (turn.sent)
        await this.request(
          turn.runtime,
          'session/cancel',
          () => turn.runtime.connection.agent.notify('session/cancel', { sessionId: turn.runtime.sessionId! }),
          'The cancellation request could not be delivered. Disconnect the agent.',
        );
      await this.timeout(
        turn.promise.catch(() => undefined),
        'The agent has not ended this turn; its result is still uncertain. Disconnect the agent to end its process.',
      );
    } catch (error) {
      if (this.turn === turn) {
        this.reportFailure('session/cancel', error, turn.runtime);
        this.status = 'error';
        this.error = message(error);
        this.notify();
      }
      throw error;
    }
  }

  async authenticate(methodId: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !this.current(runtime) || !runtime.initialized) throw new Error('Connect to the agent to obtain authentication methods.');
    if (this.turn || this.connecting || this.authenticating || this.configuration) throw new Error('Wait for the current request before logging in.');
    const method = this.authMethods.find((item) => item.id === methodId);
    if (!method) throw new Error('The agent did not offer this authentication method.');
    if ('type' in method && method.type === 'terminal')
      throw new Error("This authentication method requires the agent's own terminal. Log in externally and reconnect.");
    this.authenticating = true;
    runtime.authenticationRequired = false;
    this.status = 'connecting';
    this.error = undefined;
    this.notify();
    try {
      await this.options.validate();
      await this.request(
        runtime,
        'authenticate',
        () => runtime.connection.agent.request('authenticate', { methodId }),
        'Agent authentication timed out. Check the external login state and reconnect.',
      );
      if (!this.current(runtime)) throw new Error('Connection closed.');
      if (!runtime.established) await this.openSession(runtime);
      else {
        this.status = 'connected';
        this.error = undefined;
        this.notify();
      }
    } catch (error) {
      if (this.current(runtime)) {
        this.reportFailure('authenticate', error, runtime);
        runtime.authenticationRequired = authRequired(error);
        this.status = 'error';
        this.error = `Agent authentication failed: ${message(error)}`;
        this.options.connectionFailed?.(runtime.profile, this.error);
        this.notify();
      }
      // A timeout does not cancel the old RPC. Retire this connection before another login or
      // load can accept delayed updates from the abandoned request into a newer replay buffer.
      if (!authRequired(error))
        await this.stopRuntime(runtime).catch((stopError) => {
          this.error = `Agent authentication failed: ${message(error)}; ${message(stopError)}`;
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
      return Promise.reject(new Error('Select a configuration value currently offered by the agent.'));
    return this.configure(
      'session/set_config_option',
      (runtime) => this.requestConfigOption(runtime, configId, value),
      isModelOption(option) ? configId : undefined,
    );
  }

  private requestConfigOption(runtime: Runtime, configId: string, value: string | boolean): Promise<() => void> {
    const current = this.controls.configOptions?.find((item) => item.id === configId);
    if (!current || (current.type === 'boolean' ? typeof value !== 'boolean' : !current.options.some((item) => item.value === value)))
      throw new Error("The agent's configuration options changed. Select again.");
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
  }

  private confirmedModel(configId: string) {
    const option = this.controls.configOptions?.find((item) => item.id === configId);
    if (option && isModelOption(option) && option.options.some((item) => item.value === option.currentValue)) return { configId, value: option.currentValue };
  }

  private async rememberModel(runtime: Runtime, configId: string) {
    await this.options.validate();
    if (!this.current(runtime)) throw new Error('Connection closed.');
    const selection = this.confirmedModel(configId);
    if (!selection) return;
    this.record.modelSelection = selection;
    await this.persist();
    if (!this.current(runtime)) return;
    await this.options.modelPreferences?.save(this.signature(runtime.profile), selection);
  }

  private async restoreModel(runtime: Runtime) {
    // Other tasks may have changed the profile default. A resumed conversation keeps its
    // own choice; records without a local choice retain the agent's loaded configuration.
    const selection = this.record.modelSelection ?? (!runtime.resume ? this.options.modelPreferences?.load(this.signature(runtime.profile)) : undefined);
    if (!selection) return;
    await this.options.validate();
    if (!this.current(runtime)) throw new Error('Connection closed.');
    const option = this.controls.configOptions?.find((item) => item.id === selection.configId);
    if (!option || !isModelOption(option) || !option.options.some((item) => item.value === selection.value)) return;
    if (option.currentValue !== selection.value) {
      try {
        const apply = await this.request(
          runtime,
          'session/set_config_option',
          () => this.requestConfigOption(runtime, selection.configId, selection.value),
          'Restoring the selected model timed out. Reconnect to confirm the agent configuration.',
        );
        if (!this.current(runtime)) throw new Error('Connection closed.');
        apply();
      } catch (error) {
        // A rejected preference can use the agent's default. A timed-out request may still
        // apply later, so connection setup must fail instead of accepting an uncertain model.
        if (!this.current(runtime) || runtime.exited || authRequired(error) || (error instanceof Error && error.name === 'TimeoutError')) throw error;
        this.reportFailure('session/restore_model', error, runtime);
        this.controls.notices.push({
          id: randomUUID(),
          title: 'Unable to Restore Selected Model',
          description: `The agent's current model remains selected. ${message(error)}`,
          severity: 'warning',
        });
        return;
      }
    }
    await this.options.validate();
    if (!this.current(runtime)) throw new Error('Connection closed.');
    const confirmed = this.confirmedModel(selection.configId);
    if (confirmed) this.record.modelSelection = confirmed;
  }

  setMode(modeId: string): Promise<void> {
    if (this.controls.configOptions !== undefined || !this.controls.modes?.availableModes.some((mode) => mode.id === modeId))
      return Promise.reject(new Error('Select a session mode currently offered by the agent.'));
    return this.configure('session/set_mode', (runtime) => {
      if (this.controls.configOptions !== undefined || !this.controls.modes?.availableModes.some((mode) => mode.id === modeId))
        throw new Error("The agent's session modes changed. Select again.");
      return runtime.connection.agent.request('session/set_mode', { sessionId: runtime.sessionId!, modeId }).then(() => {
        const revision = runtime.modeRevision;
        return () => {
          if (runtime.modeRevision === revision && this.controls.configOptions === undefined && this.controls.modes) this.controls.modes.currentModeId = modeId;
        };
      });
    });
  }

  private async configure(method: string, request: (runtime: Runtime) => Promise<() => void>, modelConfigId?: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !this.current(runtime) || !runtime.established || this.status !== 'connected')
      throw new Error('Connect to an agent session and wait for the current request to finish.');
    if (this.turn || this.connecting || this.authenticating || this.configuration)
      throw new Error('Wait for the current request before changing session configuration.');
    const operation = { runtime };
    this.configuration = operation;
    this.controls.configuring = true;
    this.notify();
    let sent = false;
    let timedOut = false;
    try {
      await this.options.validate();
      if (!this.current(runtime)) throw new Error('Connection closed.');
      sent = true;
      const apply = await this.request(
        runtime,
        method,
        () => request(runtime),
        "Session configuration timed out. Reconnect to confirm the agent's current configuration.",
      ).catch((error) => {
        timedOut = error instanceof Error && error.message.startsWith('Session configuration timed out.');
        throw error;
      });
      if (!this.current(runtime)) throw new Error('Connection closed.');
      apply();
      if (modelConfigId) await this.rememberModel(runtime, modelConfigId);
      if (!this.current(runtime)) throw new Error('Connection closed.');
      this.error = undefined;
    } catch (error) {
      if (this.current(runtime)) {
        this.reportFailure('session/configure', error, runtime);
        this.error = `Unable to change session configuration: ${message(error)}`;
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
    if (!this.current(runtime)) {
      runtime.log.write('trace', 'acp.update.ignored', { reason: 'stale_connection' });
      return;
    }
    if (!runtime.sessionId && runtime.pendingUpdates) {
      const bytes = Buffer.byteLength(JSON.stringify(notification), 'utf8');
      if (runtime.pendingUpdates.length < 100 && (runtime.pendingBytes ?? 0) + bytes <= 2 * 1024 * 1024) {
        runtime.pendingUpdates.push(notification);
        runtime.pendingBytes = (runtime.pendingBytes ?? 0) + bytes;
      } else runtime.log.write('warn', 'acp.update.dropped', { reason: 'startup_buffer_limit' });
      return;
    }
    if (notification.sessionId !== runtime.sessionId) {
      runtime.log.write('trace', 'acp.update.ignored', { reason: 'foreign_session' });
      return;
    }
    const update = notification.update;
    const turn = this.turn?.runtime === runtime ? this.turn : undefined;
    if (turn && ++turn.updates === 1) runtime.log.write('debug', 'acp.turn.first_update', { turn: turn.id, type: update.sessionUpdate });
    runtime.log.write('trace', 'acp.update', { turn: turn?.id, type: update.sessionUpdate, replay: !!runtime.replay });
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
      runtime.log.write('debug', 'acp.tool', { turn: turn?.id, type: update.sessionUpdate, status: update.status, kind: update.kind });
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
      const value = update.content.type === 'text' ? update.content.text : `[Only text is supported; ${update.content.type} content not shown]`;
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
      item = { id: randomUUID(), role: 'notice', compactionId, compaction: {}, text: 'Context Compaction', status: 'in_progress' };
      history.messages.push(item);
    }
    item.compaction ??= {};
    const display = item.compaction;
    const content = (block: ContentBlock) => (block.type === 'text' ? block.text : `[Only text is supported; ${block.type} content not shown]`);
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
    item.text = text(['Context Compaction', display.summary, display.error].filter(Boolean).join('\n'));
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
      item = { id: randomUUID(), role: 'tool', toolCallId, text: update.title ?? 'Agent Action' };
      history.messages.push(item);
    }
    // ACP replaces title and content independently. Keep their display state with the
    // message so replay adoption preserves it and history truncation can release it.
    let display = this.toolDisplays.get(item);
    if (!display) {
      display = { title: item.text, content: '', exitCode: item.exitCode, exitSignal: item.exitSignal };
      this.toolDisplays.set(item, display);
    }
    if (update.title != null) display.title = text(update.title);
    if (update.status) {
      item.status = update.status;
      delete item.uncertain;
    }
    if (update.content != null) {
      display.terminal = update.content.some((content) => content.type === 'terminal');
      const details = update.content.flatMap((content) => {
        if (content.type === 'terminal') return [];
        if (content.type === 'content' && content.content.type === 'text') return [content.content.text];
        if (content.type === 'diff') return [`File changes: ${content.path} (review in the task diff)`];
        return ['Non-text content not shown'];
      });
      display.content = text(details.join('\n'));
    }
    updateToolOutput(display, update, text);
    item.exitCode = display.exitCode;
    item.exitSignal = display.exitSignal;
    const fallback = display.terminal && !display.output ? 'Agent terminal activity (this terminal is not managed by Warden)' : undefined;
    item.text = text([display.title, display.content, fallback, display.exit, display.output].filter(Boolean).join('\n'));
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
    ) {
      runtime.log.write('debug', 'acp.permission.cancelled', { reason: 'inactive_or_full', pending: this.permissions.size });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const id = randomUUID();
    const turn = this.turn;
    const read = this.options.readRoots && repositoryReadRequest(request, this.options.binding.workspace);
    const span = runtime.log.start('acp.permission', { permission: id, turn: this.turn.id, options: request.options.length }, 'info');
    const raw = request.toolCall.rawInput;
    const input = object(raw) ? raw : undefined;
    const command = input?.command ?? input?.cmd;
    const readable = (value: unknown) => (typeof value === 'string' ? text(value, 12_000) : undefined);
    const view: AcpPermission = {
      id,
      title: text(request.toolCall.title ?? 'Agent Permission Request', 1_000),
      detail: text(typeof raw === 'string' ? raw : JSON.stringify(raw ?? request.toolCall.locations ?? request.toolCall.content ?? '', null, 2), 12_000),
      command:
        readable(command) ??
        (Array.isArray(command) && command.every((part) => typeof part === 'string') ? text(JSON.stringify(command, null, 2), 12_000) : undefined),
      cwd: readable(input?.cwd ?? input?.workdir),
      reason: readable(input?.justification ?? input?.description),
      options: request.options.map((option) => ({ id: option.optionId, label: option.name, kind: option.kind })),
    };
    return new Promise((resolve) => {
      const cancelled = () => finish({ outcome: { outcome: 'cancelled' } });
      const finish = (response: RequestPermissionResponse) => {
        if (!this.permissions.delete(id)) return;
        const answer = response.outcome;
        span.end(answer.outcome === 'cancelled' ? 'cancelled' : 'ok', {
          choice: answer.outcome === 'selected' ? view.options.find((option) => option.id === answer.optionId)?.kind : undefined,
        });
        signal.removeEventListener('abort', cancelled);
        if (this.current(runtime) && this.turn === turn && !turn.cancelling)
          this.status = [...this.permissions.values()].some((permission) => !permission.checking) ? 'waiting_permission' : 'running';
        resolve(response);
        this.notify();
      };
      const permission: Permission = { view, runtime, finish, checking: !!read };
      this.permissions.set(id, permission);
      signal.addEventListener('abort', cancelled, { once: true });
      const active = () => this.permissions.get(id) === permission && this.current(runtime) && this.turn === turn && !turn.cancelling && !signal.aborted;
      const reveal = () => {
        if (!active()) return cancelled();
        permission.checking = false;
        this.status = 'waiting_permission';
        this.notify();
      };
      if (!read) return reveal();
      // Register before checking so cancellation promptly answers even a stalled ownership read.
      void this.timeout(
        (async () => {
          await this.options.validate();
          if (!active()) return false;
          return approveRepositoryRead(
            read.paths,
            () => (active() ? this.options.readRoots!() : Promise.resolve([])),
            async () => {
              if (!active()) throw new Error('Read approval cancelled.');
              await this.options.validate();
            },
          );
        })(),
        'Automatic read approval timed out.',
      ).then(
        (approved) => {
          if (!active()) return cancelled();
          if (!approved) return reveal();
          runtime.log.write('debug', 'acp.permission.auto_read', { permission: id, turn: turn.id, files: read.paths.length });
          finish({ outcome: { outcome: 'selected', optionId: read.optionId } });
        },
        () => reveal(),
      );
    });
  }

  async respondPermission(requestId: string, optionId: string): Promise<void> {
    const permission = this.permissions.get(requestId);
    if (!permission || permission.checking || !this.current(permission.runtime) || this.turn?.cancelling)
      throw new Error('This permission request has ended. Check the current session.');
    if (!permission.view.options.some((option) => option.id === optionId)) throw new Error('Select a permission option actually offered by the agent.');
    return this.options.validate().then(
      () => {
        if (this.permissions.get(requestId) !== permission || !this.current(permission.runtime) || this.turn?.cancelling)
          throw new Error('This permission request has ended. Check the current session.');
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
    if (!runtime.exited) throw new Error('Agent process exit has not been confirmed. Session ownership has been retained.');
    runtime.released ??= (async () => {
      const turn = this.turn?.runtime === runtime ? this.turn : undefined;
      if (turn) await turn.promise.catch(() => undefined);
      await this.persist();
      await runtime.release();
      runtime.log.write('debug', 'acp.storage.released');
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
    const span = runtime.log.start('acp.process.stop', { pid: runtime.child.pid });
    try {
      runtime.stopping = true;
      this.cancelPermissions(runtime);
      runtime.connection.close();
      runtime.child.stdin.destroy();
      if (!runtime.exited) {
        runtime.log.write('debug', 'acp.process.signal', { signal: 'SIGTERM' });
        runtime.child.kill('SIGTERM');
        try {
          await this.timeout(runtime.exit, 'The agent has not exited.');
        } catch {
          if (!runtime.exited) {
            runtime.log.write('warn', 'acp.process.signal', { signal: 'SIGKILL' });
            runtime.child.kill('SIGKILL');
          }
          await this.timeout(
            runtime.exit,
            'Unable to confirm agent process exit. Ownership has been retained; inspect the process before disconnecting again.',
          );
        }
      }
      runtime.child.stdout.destroy();
      runtime.child.stderr.destroy();
      await this.releaseRuntime(runtime);
      span.end();
    } catch (error) {
      span.end(diagnosticOutcome(error), diagnosticError(error));
      throw error;
    }
  }

  disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    (this.runtime?.log ?? this.log).write('info', 'acp.disconnect.requested', { connected: !!this.runtime });
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
          'The agent disconnected, but local requests have not finished. Retry.',
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
    if (this.disposed) throw new Error('This task conversation is closed.');
    if (this.resetting || this.connecting) throw new Error('A session operation is still running. Please wait.');
    this.resetting = true;
    this.notify();
    try {
      await this.initialize();
      await this.disconnect();
      const release = await this.options.storage.claim();
      this.ownsClaim = true;
      try {
        await this.options.validate();
        const latest = await this.options.storage.load();
        if (latest && (latest.messages.length || latest.sessionId)) await this.options.storage.archive(latest);
        this.log.write('info', 'acp.conversation.reset', { archived: !!latest && !!(latest.messages.length || latest.sessionId) });
        this.record = this.emptyRecord();
        this.history = { messages: this.record.messages };
        await this.persist();
      } finally {
        await release();
        this.ownsClaim = false;
      }
    } finally {
      this.resetting = false;
      this.notify();
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    await this.disconnect();
    clearTimeout(this.flush);
    await this.saves;
  }
}
