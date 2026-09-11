import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { TmuxSession, TmuxWindowResponse } from '@warden/shared';
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

/** Optional tmux integration; commands never pass through a shell. */
export class TmuxService {
  constructor(private run: TmuxRunner = runTmux) {}

  async sessions(mainRoot: string): Promise<TmuxSession[]> {
    const root = await realpath(mainRoot);
    const output = await this.run(['list-sessions', '-F', '#{session_id}\t#{session_name}\t#{session_path}']);
    const sessions: TmuxSession[] = [];
    for (const line of output.trimEnd().split('\n')) {
      const [id, name, ...parts] = line.split('\t');
      const path = parts.join('\t');
      if (!id || !/^\$\d+$/.test(id) || !name || !path) continue;
      if ((await realpath(path).catch(() => null)) === root) sessions.push({ id, name, path });
    }
    return sessions;
  }

  async open(mainRoot: string, worktreePath: string, sessionId: string): Promise<TmuxWindowResponse> {
    const session = (await this.sessions(mainRoot)).find((s) => s.id === sessionId);
    if (!session) throw new HttpError(409, '主仓库对应的 tmux session 已不存在，请刷新后重试', 'tmux_session_missing');
    const directory = await realpath(worktreePath);
    const window = (await this.run(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${session.id}:`, '-c', directory.replaceAll('#', '##')])).trim();
    return { session: session.name, window };
  }
}
