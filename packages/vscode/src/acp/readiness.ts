import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from '@agentclientprotocol/sdk';
import type { AcpAuthMethod, AcpReadiness } from '@warden/shared';
import { DiagnosticLog, diagnosticError } from '@warden/shared';
import type { AcpProfile, AgentProcessInfo } from './contracts.js';
import type { PerformanceLog, PerformanceOutcome, PerformanceSpan, PerformanceStage } from '../performance.js';
import { AcpStderr, acpDiagnosticSecrets, acpErrorDiagnostic, redactAcpDiagnostic } from './diagnostics.js';

declare const __WARDEN_VERSION__: string;
const clientVersion = typeof __WARDEN_VERSION__ === 'undefined' ? 'development' : __WARDEN_VERSION__;

type Runtime = {
  child: ChildProcessWithoutNullStreams;
  startedAt: string;
  started: Promise<void>;
  connection: ClientConnection;
  ended: Promise<void>;
  dead: Promise<never>;
  exited: boolean;
  stopping: boolean;
  cwd: string;
  authMethods: AcpAuthMethod[];
  log: DiagnosticLog;
  stderr: AcpStderr;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const authRequired = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === -32000;
class ConnectionTimeout extends Error {
  override name = 'TimeoutError';
}

/** The workbench owns this live ACP connection; task conversations keep their own workspace-bound connections. */
export class AcpReadinessCheck {
  private state: AcpReadiness = { status: 'unchecked' };
  private profile?: AcpProfile;
  private runtime?: Runtime;
  private generation = 0;
  private cleanup: Promise<void> = Promise.resolve();
  /** Retired processes that ignored SIGTERM and SIGKILL within the stop timeout. */
  private readonly unstopped = new Set<Runtime>();

  constructor(
    private readonly changed: () => void,
    private readonly timeoutMs = 15_000,
    private readonly performance?: PerformanceLog,
    private readonly log = new DiagnosticLog(),
  ) {}

  snapshot(): AcpReadiness {
    return structuredClone(this.state);
  }

  /** The workbench connection's live process; a retiring process is already being ended. */
  process(): AgentProcessInfo | undefined {
    const runtime = this.runtime;
    if (!runtime || runtime.exited || runtime.stopping || !runtime.child.pid || !this.profile) return undefined;
    return { pid: runtime.child.pid, profile: this.profile, startedAt: runtime.startedAt };
  }

  private publish(state: AcpReadiness) {
    if (state.status !== this.state.status)
      (this.runtime?.log ?? this.log).write('info', 'acp.readiness', { previous: this.state.status, status: state.status });
    this.state = state;
    this.changed();
  }

  private outcome(error: unknown, generation: number): PerformanceOutcome {
    if (generation !== this.generation) return 'cancelled';
    if (error instanceof ConnectionTimeout) return 'timeout';
    return authRequired(error) ? 'authentication_required' : 'error';
  }

  private async timed<T>(
    trace: PerformanceSpan | undefined,
    stage: PerformanceStage,
    operation: () => Promise<T>,
    generation: number,
    log = this.log,
  ): Promise<T> {
    const diagnostic = log.start(stage);
    try {
      const result = await (trace
        ? trace.measure(
            stage,
            async (span) => {
              const result = await operation();
              if (generation !== this.generation) span.end('cancelled');
              return result;
            },
            (error) => this.outcome(error, generation),
          )
        : operation());
      diagnostic.end(generation !== this.generation ? 'cancelled' : 'ok');
      return result;
    } catch (error) {
      diagnostic.end(this.outcome(error, generation), diagnosticError(error));
      throw error;
    }
  }

  private async deadline<T>(operation: Promise<T>, runtime: Runtime, description: string, timeout = this.timeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ConnectionTimeout(description)), timeout);
    });
    try {
      return await Promise.race([operation, runtime.dead, expired]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private spawn(profile: AcpProfile, cwd: string, generation: number, log: DiagnosticLog): Runtime {
    const child = spawn(profile.command, profile.args, {
      cwd,
      env: { ...process.env, ...profile.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const connection = client({ name: 'Warden ACP connection' })
      .onNotification('session/update', ({ params }) =>
        log.write('trace', 'acp.update.ignored', { reason: 'workbench_connection', type: params.update.sessionUpdate }),
      )
      .onRequest('session/request_permission', () => {
        log.write('debug', 'acp.permission.cancelled', { reason: 'workbench_connection' });
        return { outcome: { outcome: 'cancelled' } };
      })
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 2 * 1024 * 1024 }));
    let ended!: () => void;
    let reject!: (error: Error) => void;
    const runtime: Runtime = {
      child,
      startedAt: new Date().toISOString(),
      started: once(child, 'spawn').then(() => undefined),
      connection,
      cwd,
      authMethods: [],
      log,
      stderr: new AcpStderr(),
      exited: false,
      stopping: false,
      ended: new Promise<void>((resolve) => {
        ended = resolve;
      }),
      dead: new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
    };
    // A process can exit while the user is choosing an authentication method.
    void runtime.dead.catch(() => {});
    const failed = (reason: string) => {
      reject(new Error(reason));
      if (!runtime.stopping && this.runtime === runtime && generation === this.generation) {
        log.write('error', 'acp.transport.failed', { diagnostic: `${reason}\n${redactAcpDiagnostic(runtime.stderr.text, acpDiagnosticSecrets(profile))}` });
        this.publish({ status: 'error', profile: this.state.profile, message: reason });
        this.retire(runtime);
      }
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Buffer before redaction so a credential split across stream chunks is still removed.
      runtime.stderr.append(chunk);
    });
    child.once('spawn', () => log.write('debug', 'acp.process.started', { pid: child.pid }));
    child.once('error', (error) => {
      if (!child.pid) {
        runtime.exited = true;
        ended();
      }
      failed(`Unable to start the agent: ${message(error)}. Check the executable on the workspace host.`);
    });
    child.once('exit', (code, signal) => {
      log.write(runtime.stopping ? 'debug' : 'warn', 'acp.process.exited', { pid: child.pid, exitCode: code, signal, expected: runtime.stopping });
      runtime.exited = true;
      ended();
      failed(`The agent process exited (${signal ?? code ?? 'unknown status'}). Check its executable and arguments.`);
    });
    void connection.closed.then(() => failed('The ACP connection closed.'));
    return runtime;
  }

  private retire(runtime: Runtime) {
    if (runtime.stopping) return this.cleanup;
    runtime.stopping = true;
    if (this.runtime === runtime) this.runtime = undefined;
    runtime.connection.close();
    runtime.child.stdin.end();
    this.cleanup = this.cleanup
      .catch(() => {})
      .then(() =>
        runtime.log.measure('acp.process.stop', async () => {
          const wait = async (ms: number) => {
            let timer: ReturnType<typeof setTimeout>;
            try {
              await Promise.race([
                runtime.ended,
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, ms);
                }),
              ]);
            } finally {
              clearTimeout(timer!);
            }
          };
          if (!runtime.exited) {
            runtime.log.write('debug', 'acp.process.signal', { pid: runtime.child.pid, signal: 'SIGTERM' });
            runtime.child.kill('SIGTERM');
            await wait(1000);
          }
          if (!runtime.exited) {
            runtime.log.write('warn', 'acp.process.signal', { pid: runtime.child.pid, signal: 'SIGKILL' });
            runtime.child.kill('SIGKILL');
            await wait(1000);
          }
          if (!runtime.exited) {
            this.unstopped.add(runtime);
            throw new Error('The ACP process could not be stopped.');
          }
        }),
      );
    return this.cleanup;
  }

  reset() {
    this.generation++;
    if (this.runtime) this.retire(this.runtime);
    this.profile = undefined;
    this.publish({ status: 'unchecked' });
    // A stop timeout blocks new connections only while that process is still running; once it
    // exits, even late, a later connection must not inherit the old failure.
    return this.cleanup.catch((error) => {
      for (const runtime of this.unstopped) if (runtime.exited) this.unstopped.delete(runtime);
      if (this.unstopped.size) throw error;
    });
  }

  unavailable(profile: AcpProfile, reason: string) {
    if (this.state.status !== 'ready' || JSON.stringify(profile) !== JSON.stringify(this.profile)) return;
    (this.runtime?.log ?? this.log).write('warn', 'acp.unavailable', { reason: 'task_connection_failed' });
    this.publish({ status: 'error', profile: this.state.profile, message: reason.slice(0, 2000) });
    if (this.runtime) void this.retire(this.runtime).catch(() => {});
  }

  async check(profile: AcpProfile, cwd: string) {
    const log = this.log.child({ connection: randomUUID(), profile: profile.id }, acpDiagnosticSecrets(profile));
    const diagnostic = log.start('acp.connect', {}, 'info');
    const span = this.performance?.start('acp.connect');
    let outcome: PerformanceOutcome = 'error';
    try {
      outcome = await this.connect(profile, cwd, log, span);
    } finally {
      span?.end(outcome);
      diagnostic.end(outcome);
    }
  }

  private async connect(profile: AcpProfile, cwd: string, log: DiagnosticLog, trace?: PerformanceSpan): Promise<PerformanceOutcome> {
    const cleanup = this.reset();
    const generation = this.generation;
    try {
      await this.timed(trace, 'acp.cleanup', () => cleanup, generation, log);
    } catch (error) {
      log.write('error', 'acp.cleanup.failed', { diagnostic: acpErrorDiagnostic(error) });
      if (generation === this.generation) this.publish({ status: 'error', message: message(error) });
      return this.outcome(error, generation);
    }
    if (generation !== this.generation) return 'cancelled';
    this.profile = structuredClone(profile);
    const summary = { id: profile.id, label: profile.label };
    this.publish({ status: 'checking', profile: summary, message: 'Connecting to ACP…' });
    let runtime: Runtime | undefined;
    try {
      await this.timed(
        trace,
        'acp.spawn',
        async () => {
          runtime = this.spawn(profile, cwd, generation, log);
          this.runtime = runtime;
          // Failed execs have pipes but no reader. Wait before writing the first ACP request.
          await this.deadline(runtime.started, runtime, 'Starting the agent timed out.');
        },
        generation,
        log,
      );
      if (generation !== this.generation || !runtime || this.runtime !== runtime) return generation !== this.generation ? 'cancelled' : 'error';
      const connected = runtime;
      const initialized = await this.timed(
        trace,
        'acp.initialize',
        async () => {
          const result = await this.deadline(
            connected.connection.agent.request('initialize', {
              protocolVersion: PROTOCOL_VERSION,
              clientInfo: { name: 'warden', title: 'Warden', version: clientVersion },
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
              },
            }),
            connected,
            'ACP initialization timed out. Check that this command supports ACP.',
          );
          if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error('The agent uses an incompatible ACP protocol version.');
          return result;
        },
        generation,
        log,
      );
      if (generation !== this.generation || this.runtime !== runtime) return generation !== this.generation ? 'cancelled' : 'error';
      runtime.authMethods = (initialized.authMethods ?? [])
        .filter(
          (method) =>
            !('type' in method && method.type === 'terminal') &&
            typeof method.id === 'string' &&
            !!method.id &&
            method.id.length <= 500 &&
            typeof method.name === 'string' &&
            method.name.length <= 1000,
        )
        .slice(0, 32)
        .map(({ id, name, description }) => ({ id, name, description: description?.slice(0, 2000) }));
      log.write('debug', 'acp.negotiated', {
        protocolVersion: initialized.protocolVersion,
        loadSession: initialized.agentCapabilities?.loadSession === true,
        authMethods: runtime.authMethods.length,
        agentVersion: initialized.agentInfo?.version,
      });
      await this.openSession(runtime, generation, trace);
      return generation !== this.generation ? 'cancelled' : this.state.status === 'ready' ? 'ok' : 'error';
    } catch (error) {
      await this.failure(error, runtime, generation);
      return this.outcome(error, generation);
    }
  }

  private openSession(runtime: Runtime, generation: number, trace?: PerformanceSpan) {
    return this.timed(
      trace,
      'acp.session.new',
      async () => {
        const session = await this.deadline(
          runtime.connection.agent.request('session/new', { cwd: runtime.cwd, mcpServers: [] }),
          runtime,
          'Opening the ACP session timed out.',
        );
        if (typeof session.sessionId !== 'string' || !session.sessionId.trim() || session.sessionId.length > 500)
          throw new Error('The agent returned an invalid session ID.');
        if (generation !== this.generation || this.runtime !== runtime) return;
        this.publish({ status: 'ready', profile: this.state.profile, message: 'ACP connected.' });
      },
      generation,
      runtime.log,
    );
  }

  private async failure(error: unknown, runtime: Runtime | undefined, generation: number) {
    if (generation !== this.generation) return;
    (runtime?.log ?? this.log).write(authRequired(error) ? 'warn' : 'error', 'acp.connection.failed', {
      ...diagnosticError(error),
      diagnostic: [acpErrorDiagnostic(error), runtime?.stderr.text ? `Agent stderr:\n${runtime.stderr.text}` : undefined].filter(Boolean).join('\n'),
    });
    if (authRequired(error) && runtime && !runtime.stopping) {
      this.publish({
        status: 'authentication_required',
        profile: this.state.profile,
        message: 'The agent requires authentication. Sign in to connect.',
        authMethods: runtime.authMethods,
      });
      return;
    }
    if (runtime) await this.retire(runtime).catch(() => {});
    if (generation === this.generation) this.publish({ status: 'error', profile: this.state.profile, message: message(error) });
  }

  async authenticate(methodId: string) {
    const runtime = this.runtime;
    const generation = this.generation;
    if (this.state.status !== 'authentication_required' || !runtime?.authMethods.some((method) => method.id === methodId))
      throw new Error('Choose an authentication method offered by the agent.');
    const span = this.performance?.start('acp.authenticate');
    const diagnostic = runtime.log.start('acp.authenticate', {}, 'info');
    let outcome: PerformanceOutcome = 'ok';
    this.publish({ status: 'checking', profile: this.state.profile, message: 'Waiting for agent authentication…' });
    try {
      await this.deadline(
        runtime.connection.agent.request('authenticate', { methodId }),
        runtime,
        'Authentication timed out. Sign in externally and retry.',
        120_000,
      );
      if (generation === this.generation && this.runtime === runtime) await this.openSession(runtime, generation, span);
    } catch (error) {
      await this.failure(error, runtime, generation);
      outcome = this.outcome(error, generation);
    } finally {
      span?.end(generation !== this.generation ? 'cancelled' : outcome);
      diagnostic.end(generation !== this.generation ? 'cancelled' : outcome);
    }
  }

  async close() {
    await this.reset();
  }
}
