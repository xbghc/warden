import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSockets, NvimService, socketDirs } from './nvim.js';

let dir: string;
const servers: net.Server[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'warden-nvim-'));
});
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers.length = 0;
  await rm(dir, { recursive: true, force: true });
});

async function listen(p: string): Promise<void> {
  const s = net.createServer();
  servers.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(p, () => resolve());
  });
}

describe('nvim discovery', () => {
  it('lists candidate socket directories', () => {
    const dirs = socketDirs({ XDG_RUNTIME_DIR: '/run/user/1000', USER: 'me', TMPDIR: '/tmp' });
    expect(dirs).toContain('/run/user/1000');
    expect(dirs).toContain('/tmp/nvim.me');
  });

  it('finds nvim.<pid>.<n> sockets one level deep and ignores plain files', async () => {
    await listen(path.join(dir, 'nvim.123.0'));
    await mkdir(path.join(dir, 'abc'));
    await listen(path.join(dir, 'abc', 'nvim.456.0'));
    await writeFile(path.join(dir, 'nvim.789.0'), 'not a socket');
    await writeFile(path.join(dir, 'other.sock'), '');
    const found = await findSockets([dir, path.join(dir, 'missing')]);
    expect(found.map((f) => [path.relative(dir, f.socket), f.pid]).sort()).toEqual([
      ['abc/nvim.456.0', 456],
      ['nvim.123.0', 123],
    ]);
  });

  it('matches instances by cwd under the root', () => {
    const list = [
      { socket: 'a', cwd: '/repo' },
      { socket: 'b', cwd: '/repo/src' },
      { socket: 'c', cwd: '/repo2' },
      { socket: 'd', cwd: '/other' },
    ];
    expect(NvimService.matching(list, '/repo/').map((i) => i.socket)).toEqual(['a', 'b']);
  });

  it('scan tolerates a missing nvim binary and caches results', async () => {
    await listen(path.join(dir, 'nvim.1.0'));
    const svc = new NvimService([dir]);
    const r1 = await svc.scan();
    expect(r1.instances).toEqual([]);
    const r2 = await svc.scan();
    expect(r2).toBe(r1);
    const r3 = await svc.scan(true);
    expect(r3).not.toBe(r1);
  });
});
