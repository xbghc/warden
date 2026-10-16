import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isPortFree, PROBE_ATTEMPTS, startServer, type RunningServer, type StartOptions } from '@warden/server';
import * as git from '../packages/server/src/git.js';
import { PreviewService } from '../packages/server/src/preview.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let dataDir: string;
let stateFile: string;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function usingServer(run: (server: RunningServer) => Promise<void>, options: Partial<StartOptions> = {}) {
  const server = await startServer({ repoPath: fx.root, stateFile, ...options });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-start-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-start-data-'));
  stateFile = path.join(dataDir, 'state.json');
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('startServer port selection', () => {
  it('serves the token the probe checks for', async () => {
    await usingServer(async (server) => {
      const res = await fetch(`${server.url}api/ping`);
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(0);
      expect(server.skippedPorts).toEqual([]);
      expect(server.windowsReachable).toBeUndefined();
    });
  });

  it('moves on from ports the other side cannot reach, and keeps the one it can', async () => {
    const offered: number[] = [];
    await usingServer(
      async (server) => {
        expect(offered).toHaveLength(3);
        expect(server.skippedPorts).toEqual(offered.slice(0, 2));
        expect(server.port).toBe(offered[2]);
        expect(server.windowsReachable).toBe(true);
        expect((await fetch(`${server.url}api/ping`)).status).toBe(200);
      },
      {
        probeWindows: async (port) => {
          offered.push(port);
          return offered.length >= 3;
        },
      },
    );
  });

  it('gives up after a bounded number of tries and still serves, saying it is unreachable', async () => {
    const offered: number[] = [];
    await usingServer(
      async (server) => {
        expect(offered).toHaveLength(PROBE_ATTEMPTS);
        expect(server.skippedPorts).toHaveLength(PROBE_ATTEMPTS - 1);
        expect(server.windowsReachable).toBe(false);
        expect((await fetch(`${server.url}api/ping`)).status).toBe(200);
      },
      {
        probeWindows: async (port) => {
          offered.push(port);
          return false;
        },
      },
    );
  });

  it('stops probing when the probe itself cannot run, rather than walking the port range', async () => {
    const offered: number[] = [];
    await usingServer(
      async (server) => {
        expect(offered).toHaveLength(1);
        expect(server.skippedPorts).toEqual([]);
        expect(server.windowsReachable).toBeUndefined();
      },
      {
        probeWindows: async (port) => {
          offered.push(port);
          return undefined;
        },
      },
    );
  });

  it('never swaps out a port the user named', async () => {
    await usingServer(async (first) => {
      const offered: number[] = [];
      await usingServer(
        async (server) => {
          expect(offered).toEqual([]);
          expect(server.port).toBe(first.port + 500);
          expect(server.skippedPorts).toEqual([]);
        },
        {
          port: first.port + 500,
          probeWindows: async (port) => {
            offered.push(port);
            return false;
          },
        },
      );
    });
  });

  it('releases the listening socket if the reachability probe throws', async () => {
    let port = 0;
    await expect(
      startServer({
        repoPath: fx.root,
        stateFile,
        probeWindows: async (offered) => {
          port = offered;
          throw new Error('Probe failed');
        },
      }),
    ).rejects.toThrow('Probe failed');
    expect(port).toBeGreaterThan(0);
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('startServer().close()', () => {
  it('closes an open event stream and drains its in-flight Git poll before resolving', async () => {
    const started = signal();
    const proceed = signal();
    const read = git.runGit;
    vi.spyOn(git, 'runGit').mockImplementation(async (args, options) => {
      const result = await read(args, options);
      if (args[0] === 'status' && args.includes('--untracked-files=all')) {
        started.resolve();
        await proceed.promise;
      }
      return result;
    });
    await usingServer(async (server) => {
      const controller = new AbortController();
      try {
        const res = await fetch(`${server.url}api/events`, { signal: controller.signal });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const reader = res.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
        const drained = reader.read().then(
          (result) => result.done,
          (error: unknown) => error instanceof Error,
        );
        await started.promise;
        let closed = false;
        const closing = server.close().then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        proceed.resolve();
        await closing;
        expect(await drained).toBe(true);
        reader.releaseLock();
        await server.close();
      } finally {
        proceed.resolve();
        controller.abort();
        await server.close();
      }
    });
  });

  it('waits for an active preview refresh before closing', async () => {
    const started = signal();
    const proceed = signal();
    const tick = vi.spyOn(PreviewService.prototype, 'tick').mockImplementation(async () => {
      started.resolve();
      await proceed.promise;
    });
    await usingServer(async (server) => {
      try {
        await started.promise;
        let closed = false;
        const closing = server.close().then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        proceed.resolve();
        await closing;
        expect(tick).toHaveBeenCalledOnce();
      } finally {
        proceed.resolve();
        await server.close();
      }
    });
  });
});
