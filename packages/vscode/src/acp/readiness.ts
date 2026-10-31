import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from '@agentclientprotocol/sdk';
import type { AcpAuthMethod, AcpReadiness } from '@warden/shared';
import type { AcpProfile } from './contracts.js';

declare const __WARDEN_VERSION__: string;
const clientVersion = typeof __WARDEN_VERSION__ === 'undefined' ? 'development' : __WARDEN_VERSION__;

type Runtime = {
  child: ChildProcessWithoutNullStreams;
  started: Promise<void>;
  connection: ClientConnection;
  ended: Promise<void>;
  dead: Promise<never>;
  exited: boolean;
  stopping: boolean;
  cwd: string;
  authMethods: AcpAuthMethod[];
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const authRequired = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === -32000;

/** The workbench owns this live ACP connection; task conversations keep their own workspace-bound connections. */
export class AcpReadinessCheck {
  private state: AcpReadiness = { status: 'unchecked' };
  private profile?: AcpProfile;
  private runtime?: Runtime;
  private generation = 0;
  private cleanup: Promise<void> = Promise.resolve();

  constructor(
    private readonly changed: () => void,
    private readonly timeoutMs = 15_000,
  ) {}

  snapshot(): AcpReadiness {
    return structuredClone(this.state);
  }

  private publish(state: AcpReadiness) {
    this.state = state;
    this.changed();
  }

  private async deadline<T>(operation: Promise<T>, runtime: Runtime, description: string, timeout = this.timeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(description)), timeout);
    });
    try {
      return await Promise.race([operation, runtime.dead, expired]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private spawn(profile: AcpProfile, cwd: string, generation: number): Runtime {
    const child = spawn(profile.command, profile.args, {
      cwd,
      env: { ...process.env, ...profile.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const connection = client({ name: 'Warden ACP connection' })
      .onNotification('session/update', () => {})
      .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 2 * 1024 * 1024 }));
    let ended!: () => void;
    let reject!: (error: Error) => void;
    const runtime: Runtime = {
      child,
      started: once(child, 'spawn').then(() => undefined),
      connection,
      cwd,
      authMethods: [],
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
        this.publish({ status: 'error', profile: this.state.profile, message: reason });
        this.retire(runtime);
      }
    };
    child.stderr.resume();
    child.once('error', (error) => {
      if (!child.pid) {
        runtime.exited = true;
        ended();
      }
      failed(`Unable to start the agent: ${message(error)}. Check the executable on the workspace host.`);
    });
    child.once('exit', (code, signal) => {
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
      .then(async () => {
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
          runtime.child.kill('SIGTERM');
          await wait(1000);
        }
        if (!runtime.exited) {
          runtime.child.kill('SIGKILL');
          await wait(1000);
        }
        if (!runtime.exited) throw new Error('The ACP process could not be stopped.');
      });
    return this.cleanup;
  }

  reset() {
    this.generation++;
    if (this.runtime) this.retire(this.runtime);
    this.profile = undefined;
    this.publish({ status: 'unchecked' });
    return this.cleanup;
  }

  unavailable(profile: AcpProfile, reason: string) {
    if (this.state.status !== 'ready' || JSON.stringify(profile) !== JSON.stringify(this.profile)) return;
    this.publish({ status: 'error', profile: this.state.profile, message: reason.slice(0, 2000) });
    if (this.runtime) void this.retire(this.runtime).catch(() => {});
  }

  async check(profile: AcpProfile, cwd: string) {
    const cleanup = this.reset();
    const generation = this.generation;
    try {
      await cleanup;
    } catch (error) {
      if (generation === this.generation) this.publish({ status: 'error', message: message(error) });
      return;
    }
    if (generation !== this.generation) return;
    this.profile = structuredClone(profile);
    const summary = { id: profile.id, label: profile.label };
    this.publish({ status: 'checking', profile: summary, message: 'Connecting to ACP…' });
    let runtime: Runtime | undefined;
    try {
      runtime = this.spawn(profile, cwd, generation);
      this.runtime = runtime;
      // Failed execs have pipes but no reader. Wait before writing the first ACP request.
      await this.deadline(runtime.started, runtime, 'Starting the agent timed out.');
      if (generation !== this.generation || this.runtime !== runtime) return;
      const initialized = await this.deadline(
        runtime.connection.agent.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'warden', title: 'Warden', version: clientVersion },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
          },
        }),
        runtime,
        'ACP initialization timed out. Check that this command supports ACP.',
      );
      if (generation !== this.generation || this.runtime !== runtime) return;
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('The agent uses an incompatible ACP protocol version.');
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
      await this.openSession(runtime, generation);
    } catch (error) {
      await this.failure(error, runtime, generation);
    }
  }

  private async openSession(runtime: Runtime, generation: number) {
    const session = await this.deadline(
      runtime.connection.agent.request('session/new', { cwd: runtime.cwd, mcpServers: [] }),
      runtime,
      'Opening the ACP session timed out.',
    );
    if (typeof session.sessionId !== 'string' || !session.sessionId.trim() || session.sessionId.length > 500)
      throw new Error('The agent returned an invalid session ID.');
    if (generation !== this.generation || this.runtime !== runtime) return;
    this.publish({ status: 'ready', profile: this.state.profile, message: 'ACP connected.' });
  }

  private async failure(error: unknown, runtime: Runtime | undefined, generation: number) {
    if (generation !== this.generation) return;
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
    this.publish({ status: 'checking', profile: this.state.profile, message: 'Waiting for agent authentication…' });
    try {
      await this.deadline(
        runtime.connection.agent.request('authenticate', { methodId }),
        runtime,
        'Authentication timed out. Sign in externally and retry.',
        120_000,
      );
      if (generation === this.generation && this.runtime === runtime) await this.openSession(runtime, generation);
    } catch (error) {
      await this.failure(error, runtime, generation);
    }
  }

  async close() {
    await this.reset();
  }
}
