import { execFile } from 'node:child_process';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { TmuxSession, TmuxSessionResponse } from '@warden/shared';
import { HttpError } from './errors.js';

export type TmuxRunner = (args: string[]) => Promise<string>;

const runTmux: TmuxRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('tmux', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(
        new HttpError(503, missing ? 'tmux 不可用，请在安装了 tmux 的 Linux/macOS 或 WSL 中运行 warden' : stderr.trim() || '无法连接 tmux', 'tmux_unavailable'),
      );
    });
  });

/**
 * The session a worktree gets: its directory's name, as `<repo>-<n>` for a slot. A slot outlives its
 * branch and so does its session, which keeps the name it was given when the next branch comes in.
 * tmux does not allow `.` or `:` in a session name, and would rewrite them on its own. It also
 * expands `-s` as a format, so a `#` would let a directory name run a command through `#()`:
 * it is replaced too, rather than escaped, so the name looked up is the name tmux keeps.
 */
export function sessionNameFor(worktreePath: string): string {
  return path.basename(worktreePath).replace(/[.:#]/g, '_') || 'warden';
}

/** Optional tmux integration; commands never pass through a shell. */
export class TmuxService {
  constructor(private run: TmuxRunner = runTmux) {}

  private async list(): Promise<TmuxSession[]> {
    const output = await this.run(['list-sessions', '-F', '#{session_id}\t#{session_name}\t#{session_path}']).catch((e) => {
      // No server running is "no sessions yet", not a failure: new-session starts one.
      if (e instanceof HttpError && /no server running|error connecting/i.test(e.message)) return '';
      throw e;
    });
    const sessions: TmuxSession[] = [];
    for (const line of output.trimEnd().split('\n')) {
      const [id, name, ...parts] = line.split('\t');
      const dir = parts.join('\t');
      if (!id || !/^\$\d+$/.test(id) || !name || !dir) continue;
      sessions.push({ id, name, path: dir });
    }
    return sessions;
  }

  /**
   * A detached session in the worktree, named after its directory, with a shell and nothing run in
   * it. One already there for the same directory is handed back rather than doubled; one of that
   * name elsewhere is refused, not replaced — it is someone's work.
   */
  async openSession(worktreePath: string): Promise<TmuxSessionResponse> {
    const directory = await realpath(worktreePath);
    const name = sessionNameFor(directory);
    const existing = (await this.list()).find((x) => x.name === name);
    if (existing) {
      if ((await realpath(existing.path).catch(() => null)) === directory) return { session: name, created: false };
      throw new HttpError(409, `已有同名 tmux session ${name}，工作目录是 ${existing.path}`, 'tmux_name_taken');
    }
    await this.run(['new-session', '-d', '-s', name, '-c', directory.replaceAll('#', '##')]);
    return { session: name, created: true };
  }
}
