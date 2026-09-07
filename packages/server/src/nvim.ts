import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import type { NvimInstance } from '@warden/shared';

const QUERY_TIMEOUT_MS = 500;
const CACHE_TTL_MS = 10_000;

function execNvim(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile('nvim', args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const err = error as NodeJS.ErrnoException;
        resolve({ ok: false, stdout, stderr, missing: err.code === 'ENOENT' });
        return;
      }
      resolve({ ok: true, stdout, stderr, missing: false });
    });
  });
}

/** Candidate directories where nvim puts its server sockets. */
export function socketDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  if (env.XDG_RUNTIME_DIR) dirs.push(env.XDG_RUNTIME_DIR);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined) dirs.push(`/run/user/${uid}`);
  let user = env.USER || env.LOGNAME;
  if (!user) {
    try {
      user = os.userInfo().username;
    } catch {
      user = undefined;
    }
  }
  const tmp = env.TMPDIR || '/tmp';
  if (user) dirs.push(path.join(tmp, `nvim.${user}`));
  if (env.NVIM_LISTEN_ADDRESS) dirs.push(path.dirname(env.NVIM_LISTEN_ADDRESS));
  return [...new Set(dirs)];
}

const SOCKET_NAME = /^nvim\.(\d+)\.\d+$/;

async function isSocket(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isSocket();
  } catch {
    return false;
  }
}

export async function findSockets(dirs = socketDirs()): Promise<{ socket: string; pid?: number }[]> {
  const found = new Map<string, number | undefined>();
  const visit = async (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const m = SOCKET_NAME.exec(ent.name);
      if (m && (ent.isSocket() || (await isSocket(full)))) {
        found.set(full, Number(m[1]));
      } else if (ent.isDirectory() && depth < 1) {
        // /tmp/nvim.<user>/<random>/nvim.<pid>.0
        await visit(full, depth + 1);
      }
    }
  };
  for (const d of dirs) await visit(d, 0);
  return [...found.entries()].map(([socket, pid]) => ({ socket, pid }));
}

export interface NvimScanResult {
  nvimAvailable: boolean;
  instances: NvimInstance[];
  scannedAt: string;
}

export class NvimService {
  private cache: { at: number; result: NvimScanResult } | null = null;
  private pending: Promise<NvimScanResult> | null = null;

  constructor(private readonly dirs?: string[]) {}

  async scan(force = false): Promise<NvimScanResult> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.result;
    if (this.pending) return this.pending;
    this.pending = this.doScan().finally(() => {
      this.pending = null;
    });
    const result = await this.pending;
    this.cache = { at: Date.now(), result };
    return result;
  }

  private async doScan(): Promise<NvimScanResult> {
    const sockets = await findSockets(this.dirs);
    let nvimAvailable = true;
    const instances: NvimInstance[] = [];
    await Promise.all(
      sockets.map(async ({ socket, pid }) => {
        const r = await execNvim(['--server', socket, '--remote-expr', 'getcwd()'], QUERY_TIMEOUT_MS);
        if (r.missing) {
          nvimAvailable = false;
          return;
        }
        if (!r.ok) return; // stale socket or unresponsive instance
        const cwd = r.stdout.trim();
        if (cwd) instances.push({ socket, cwd, pid });
      }),
    );
    instances.sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0));
    return { nvimAvailable, instances, scannedAt: new Date().toISOString() };
  }

  /** Instances whose cwd is inside `root`. */
  static matching(instances: NvimInstance[], root: string): NvimInstance[] {
    const norm = root.replace(/\/+$/, '');
    return instances.filter((i) => i.cwd === norm || i.cwd.startsWith(norm + '/'));
  }

  async open(socket: string, absPath: string, line: number): Promise<void> {
    const safeLine = Math.max(1, Math.floor(line) || 1);
    const vimStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
    // Evaluate an expression instead of sending keystrokes: no mode/escaping issues in the target instance.
    const expr = `execute(['edit +${safeLine} ' . fnameescape(${vimStr(absPath)}), 'normal! zz'])`;
    const r = await execNvim(['--server', socket, '--remote-expr', expr], 3000);
    if (r.missing) throw new Error('nvim executable not found in PATH');
    if (!r.ok) throw new Error(r.stderr.trim() || 'failed to talk to nvim instance');
    this.cache = null;
  }
}
