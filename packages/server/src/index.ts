import net from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './app.js';
import { resolveRepo, type RepoContext } from './repo.js';
import { StateStore, stateFilePath } from './state.js';
import { NvimService } from './nvim.js';

export { createApp } from './app.js';
export { resolveRepo } from './repo.js';
export { StateStore, stateFilePath } from './state.js';
export { NvimService } from './nvim.js';
export { HttpError } from './errors.js';
export { runGit, GitError, assertAllowedGitArgs } from './git.js';
export { parseUnifiedDiff } from './diffparse.js';
export { buildAnchor, reanchorComment } from './anchor.js';
export { formatCommentsExport, formatIssueExport } from './export.js';

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

export interface StartOptions {
  repoPath: string;
  port?: number;
  webDir?: string;
  stateFile?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  repo: RepoContext;
  stateFile: string;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const repo = await resolveRepo(opts.repoPath);
  const stateFile = opts.stateFile ?? stateFilePath(repo.commonRoot);
  const store = new StateStore(stateFile, repo.commonRoot);
  const app = createApp({ repo, store, nvim: new NvimService(), webDir: opts.webDir });

  let port: number;
  if (opts.port !== undefined) {
    if (!(await isPortFree(opts.port))) throw new Error(`port ${opts.port} is already in use`);
    port = opts.port;
  } else {
    port = await findFreePort();
  }

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: HOST, port }, () => resolve(s));
    s.once('error', reject);
  });

  return {
    url: `http://${HOST}:${port}/`,
    port,
    repo,
    stateFile,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
