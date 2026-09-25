import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { sessionNameFor, TmuxService } from './tmux.js';
import { createApp } from './app.js';
import { HttpError } from './errors.js';
import { StateStore } from './state.js';
import { resolveRepo } from './repo.js';
import { makeFixtureRepo } from '../../../test/fixtures/make-repo.js';

describe('tmux integration', () => {
  it('only opens sessions for registered worktrees through the API', async () => {
    const fx = await makeFixtureRepo();
    try {
      const repo = await resolveRepo(fx.root);
      const run = vi.fn(async (args: string[]) => (args[0] === 'list-sessions' ? '' : ''));
      const app = createApp({ repo, store: new StateStore(path.join(fx.root, 'state.json'), repo.commonRoot), tmux: new TmuxService(run) });
      const post = (body: unknown) =>
        app.request('/api/tmux/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post(null)).status).toBe(400);
      expect((await post({ path: path.dirname(fx.root) })).status).toBe(400);
      expect(run).not.toHaveBeenCalled();
      expect((await post({ path: repo.root })).status).toBe(201);
    } finally {
      await fx.cleanup();
    }
  });

  it('names a session after the worktree directory, as tmux would accept it', () => {
    expect(sessionNameFor('/work/warden-2')).toBe('warden-2');
    expect(sessionNameFor('/work/my.app:1')).toBe('my_app_1');
    // tmux expands -s as a format: #(...) would run a command, #{...} would rename the session.
    expect(sessionNameFor('/work/x#(touch p)-1')).toBe('x_(touch p)-1');
    expect(sessionNameFor('/work/a#{pid}')).toBe('a_{pid}');
  });

  it('creates a detached session in the worktree, and hands back the one it already has', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'warden-tmux-'));
    try {
      const wt = path.join(root, 'repo-1 #1');
      await mkdir(wt);
      const dir = await realpath(wt);
      let listing = '';
      const run = vi.fn(async (args: string[]) => (args[0] === 'list-sessions' ? listing : ''));
      const tmux = new TmuxService(run);

      expect(await tmux.openSession(wt)).toEqual({ session: 'repo-1 _1', created: true });
      expect(run).toHaveBeenLastCalledWith(['new-session', '-d', '-s', 'repo-1 _1', '-c', dir.replaceAll('#', '##')]);

      listing = `$3\trepo-1 _1\t${dir}\n`;
      expect(await tmux.openSession(wt)).toEqual({ session: 'repo-1 _1', created: false });
      expect(run.mock.calls.filter(([args]) => args[0] === 'new-session')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a name another directory already has, rather than taking it over', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'warden-tmux-'));
    try {
      const wt = path.join(root, 'repo-1');
      await mkdir(wt);
      const run = vi.fn(async (args: string[]) => (args[0] === 'list-sessions' ? `$1\trepo-1\t${root}\n` : ''));
      await expect(new TmuxService(run).openSession(wt)).rejects.toMatchObject({ code: 'tmux_name_taken' });
      expect(run.mock.calls.filter(([args]) => args[0] === 'new-session')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('starts the first session when no tmux server runs yet, and reports a missing tmux', async () => {
    const noServer = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-sessions') throw new HttpError(503, 'no server running on /tmp/tmux-1000/default', 'tmux_unavailable');
      return '';
    });
    expect(await new TmuxService(noServer).openSession(process.cwd())).toMatchObject({ created: true });

    const missing = vi.fn(async () => {
      throw new HttpError(503, 'tmux 不可用', 'tmux_unavailable');
    });
    await expect(new TmuxService(missing).openSession(process.cwd())).rejects.toMatchObject({ code: 'tmux_unavailable' });
    expect(missing).toHaveBeenCalledTimes(1);
  });
});
