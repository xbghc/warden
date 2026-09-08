import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBE_ATTEMPTS, startServer, type RunningServer } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let dataDir: string;
let stateFile: string;
const running: RunningServer[] = [];

async function start(probeWindows?: (port: number, token: string) => Promise<boolean | undefined>): Promise<RunningServer> {
  const server = await startServer({ repoPath: fx.root, stateFile, probeWindows });
  running.push(server);
  return server;
}

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-start-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-start-data-'));
  stateFile = path.join(dataDir, 'state.json');
});

afterAll(async () => {
  await Promise.all(running.map((s) => s.close().catch(() => undefined)));
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('startServer port selection', () => {
  it('serves the token the probe checks for', async () => {
    const server = await start();
    const res = await fetch(`${server.url}api/ping`);
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
    expect(server.skippedPorts).toEqual([]);
    expect(server.windowsReachable).toBeUndefined();
  });

  it('moves on from ports the other side cannot reach, and keeps the one it can', async () => {
    const offered: number[] = [];
    const server = await start(async (port) => {
      offered.push(port);
      return offered.length >= 3;
    });
    expect(offered).toHaveLength(3);
    expect(server.skippedPorts).toEqual(offered.slice(0, 2));
    expect(server.port).toBe(offered[2]);
    expect(server.windowsReachable).toBe(true);
    // The port it settled on is the one actually listening.
    expect((await fetch(`${server.url}api/ping`)).status).toBe(200);
  });

  it('gives up after a bounded number of tries and still serves, saying it is unreachable', async () => {
    const offered: number[] = [];
    const server = await start(async (port) => {
      offered.push(port);
      return false;
    });
    expect(offered).toHaveLength(PROBE_ATTEMPTS);
    expect(server.skippedPorts).toHaveLength(PROBE_ATTEMPTS - 1);
    expect(server.windowsReachable).toBe(false);
    expect((await fetch(`${server.url}api/ping`)).status).toBe(200);
  });

  it('stops probing when the probe itself cannot run, rather than walking the port range', async () => {
    const offered: number[] = [];
    const server = await start(async (port) => {
      offered.push(port);
      return undefined;
    });
    expect(offered).toHaveLength(1);
    expect(server.skippedPorts).toEqual([]);
    expect(server.windowsReachable).toBeUndefined();
  });

  it('never swaps out a port the user named', async () => {
    const first = await start();
    const offered: number[] = [];
    const server = await startServer({
      repoPath: fx.root,
      stateFile,
      port: first.port + 500,
      probeWindows: async (port) => {
        offered.push(port);
        return false;
      },
    });
    running.push(server);
    expect(offered).toEqual([]);
    expect(server.port).toBe(first.port + 500);
    expect(server.skippedPorts).toEqual([]);
  });
});

describe('startServer().close()', () => {
  it('resolves while an /api/events stream is still open', async () => {
    const server = await startServer({ repoPath: fx.root, stateFile });

    // A browser tab keeps this stream open indefinitely; the server must not wait for it.
    const res = await fetch(`${server.url}api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const drained = res.body!.getReader().read().catch(() => undefined);

    const closed = server.close().then(() => 'closed' as const);
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2_000));
    expect(await Promise.race([closed, timeout])).toBe('closed');

    // The client sees the connection go away rather than hanging on a half-open socket.
    await drained;
  });
});
