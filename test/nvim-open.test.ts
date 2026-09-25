import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { NvimInstance, NvimOpenResponse } from '@warden/shared';
import { createApp, type NvimService, resolveRepo, StateStore } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

/**
 * Stands in for the nvim instances on the machine. `cached` is what a scan inside the cache window
 * returns, `live` what a forced one finds; `refuses` answers a scan but fails to open a file.
 */
class FakeNvim {
  cached: NvimInstance[] = [];
  live: NvimInstance[] = [];
  refuses = new Set<string>();
  opened: string[] = [];
  async scan(force = false) {
    return { nvimAvailable: true, instances: force ? this.live : this.cached, scannedAt: '' };
  }
  async open(socket: string) {
    if (!this.live.some((i) => i.socket === socket)) throw new Error('connection refused');
    if (this.refuses.has(socket)) throw new Error('E37: No write since last change');
    this.opened.push(socket);
  }
}

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;
let nvim: FakeNvim;

const open = (socket?: string) =>
  app.request('/api/nvim/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: fx.root, socket, absPath: path.join(fx.root, 'src/a.ts'), line: 2 }),
  });
const at = (socket: string): NvimInstance => ({ socket, cwd: fx.root });

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-nvim-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-nvim-data-'));
  const repo = await resolveRepo(fx.root);
  nvim = new FakeNvim();
  app = createApp({ repo, store: new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot), nvim: nvim as unknown as NvimService });
});

beforeEach(() => {
  nvim.cached = [];
  nvim.live = [];
  nvim.refuses.clear();
  nvim.opened = [];
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('POST /api/nvim/open finds the instance when the click arrives', () => {
  it('reaches an nvim started after the page last looked', async () => {
    nvim.live = [at('/run/nvim.new.0')];
    const res = await open();
    expect(res.status).toBe(200);
    expect(((await res.json()) as NvimOpenResponse).socket).toBe('/run/nvim.new.0');
  });

  it('moves on to the restarted nvim when the selected one is gone', async () => {
    nvim.cached = [at('/run/nvim.old.0')];
    nvim.live = [at('/run/nvim.new.0')];
    const res = await open('/run/nvim.old.0');
    expect(res.status).toBe(200);
    expect(((await res.json()) as NvimOpenResponse).socket).toBe('/run/nvim.new.0');
    expect(nvim.opened).toEqual(['/run/nvim.new.0']);
  });

  it('reports an instance that is alive but refuses, rather than sending the file elsewhere', async () => {
    nvim.cached = nvim.live = [at('/run/nvim.a.0'), at('/run/nvim.b.0')];
    nvim.refuses.add('/run/nvim.a.0');
    const res = await open('/run/nvim.a.0');
    expect(res.status).toBe(502);
    expect(nvim.opened).toEqual([]);
  });

  it('asks instead of guessing between two, and says when there is none', async () => {
    nvim.cached = nvim.live = [at('/run/nvim.a.0'), at('/run/nvim.b.0')];
    expect((await open()).status).toBe(409);
    expect((await open('/run/nvim.b.0')).status).toBe(200);
    nvim.cached = nvim.live = [{ socket: '/run/nvim.c.0', cwd: '/elsewhere' }];
    expect((await open()).status).toBe(404);
  });
});
