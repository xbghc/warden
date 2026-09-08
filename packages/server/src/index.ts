import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './app.js';
import { resolveRepo, type RepoContext } from './repo.js';
import { StateStore, stateFilePath } from './state.js';
import { NvimService } from './nvim.js';
import { isWsl, reachableFromWindows } from './wsl.js';

export { createApp } from './app.js';
export { isWsl, reachableFromWindows } from './wsl.js';
export { resolveRepo } from './repo.js';
export { StateStore, stateFilePath } from './state.js';
export { NvimService } from './nvim.js';
export { RepoWatcher, statusPaths, DEFAULT_POLL_INTERVAL_MS } from './watcher.js';
export { HttpError } from './errors.js';
export { runGit, GitError, assertAllowedGitArgs } from './git.js';
export { parseUnifiedDiff } from './diffparse.js';
export { buildAnchor, reanchorComment } from './anchor.js';
export { formatCommentsExport, formatIssueExport, formatTodosExport } from './export.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT_START = 4100;

export function isPortFree(port: number, host = HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

export async function findFreePort(start = DEFAULT_PORT_START, host = HOST): Promise<number> {
  for (let p = start; p < start + 1000; p++) {
    if (await isPortFree(p, host)) return p;
  }
  throw new Error(`no free port found starting at ${start}`);
}

/** How many ports the reachability probe may burn before we keep the last one and say so. */
export const PROBE_ATTEMPTS = 5;

export interface StartOptions {
  repoPath: string;
  port?: number;
  webDir?: string;
  stateFile?: string;
  /** Overrides the Windows-side reachability probe; tests inject one instead of shelling out. */
  probeWindows?: (port: number, token: string) => Promise<boolean | undefined>;
}

export interface RunningServer {
  url: string;
  port: number;
  repo: RepoContext;
  stateFile: string;
  /** Ports that bound here but the Windows side could not reach, in the order they were dropped. */
  skippedPorts: number[];
  /** Windows-side reachability of `port`; undefined when nothing asked (not WSL, or a fixed --port). */
  windowsReachable?: boolean;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const repo = await resolveRepo(opts.repoPath);
  const stateFile = opts.stateFile ?? stateFilePath(repo.commonRoot);
  const store = new StateStore(stateFile, repo.commonRoot);
  const instanceToken = randomUUID();
  const app = createApp({ repo, store, nvim: new NvimService(), webDir: opts.webDir, instanceToken });

  const listen = (p: number): Promise<ServerType> =>
    new Promise((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: HOST, port: p }, () => resolve(s));
      s.once('error', reject);
    });
  const stop = (s: ServerType): Promise<void> =>
    new Promise((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
      // close() only stops accepting and then waits for every connection to drain. The
      // /api/events SSE streams never drain while a page is open, so shutdown would hang
      // until the last tab was closed. Destroying them fires their abort handlers, which
      // release the watcher subscriptions.
      if ('closeAllConnections' in s) s.closeAllConnections();
    });

  let port: number;
  let server: ServerType;
  const skippedPorts: number[] = [];
  let windowsReachable: boolean | undefined;

  if (opts.port !== undefined) {
    if (!(await isPortFree(opts.port))) throw new Error(`port ${opts.port} is already in use`);
    port = opts.port;
    server = await listen(port);
  } else {
    // A port we picked ourselves may be swapped out; one the user named is theirs to keep.
    const probe = opts.probeWindows ?? ((await isWsl()) ? reachableFromWindows : undefined);
    let start = DEFAULT_PORT_START;
    for (let attempt = 1; ; attempt++) {
      port = await findFreePort(start);
      server = await listen(port);
      if (!probe) break;
      windowsReachable = await probe(port, instanceToken);
      // undefined is "could not ask", not "no": stop probing rather than walk the port range blind.
      if (windowsReachable !== false || attempt >= PROBE_ATTEMPTS) break;
      await stop(server);
      skippedPorts.push(port);
      start = port + 1;
    }
  }

  return {
    url: `http://${HOST}:${port}/`,
    port,
    repo,
    stateFile,
    skippedPorts,
    windowsReachable,
    close: () => stop(server),
  };
}
