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
  it('sends configured literal text and explicit keys only to a validated workspace pane', async () => {
    const fx = await makeFixtureRepo();
    const data = await mkdtemp(path.join(os.tmpdir(), 'warden-command-'));
    try {
      const repo = await resolveRepo(fx.root);
      const store = new StateStore(path.join(data, 'state.json'), repo.commonRoot);
      let panes = '%3\t1\t1\n%4\t1\t0\n';
      const run = vi.fn(async (args: string[]) => (args[0] === 'list-panes' ? panes : ''));
      const app = createApp({ repo, store, tmux: new TmuxService(run) });
      const request = (method: string, route: string, body: unknown) =>
        app.request(`/api/workspace/${route}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const text = 'review $(literal) and `literal`';
      const config = { commands: [{ id: 'prompt', label: 'Fill prompt', text }], hooks: {} };
      expect((await request('PUT', 'config', { ...config, commands: [{ ...config.commands[0], keys: ['-t %8'] }] })).status).toBe(400);
      expect((await request('PUT', 'config', { ...config, commands: [...config.commands, ...config.commands] })).status).toBe(400);
      expect((await request('PUT', 'config', config)).status).toBe(200);
      expect((await request('POST', 'commands/missing', { path: repo.root })).status).toBe(404);
      expect((await request('POST', 'commands/prompt', { path: data })).status).toBe(400);
      expect(run).not.toHaveBeenCalled();
      expect((await request('POST', 'commands/prompt', { path: repo.root })).status).toBe(200);
      expect(run.mock.calls.filter(([args]) => args[0] === 'send-keys')).toEqual([[['send-keys', '-t', '%3', '-l', '--', text]]]);
      await request('PUT', 'config', { commands: [{ id: 'submit', label: 'Submit', keys: ['Enter'] }], hooks: {} });
      await request('POST', 'commands/submit', { path: repo.root });
      expect(run).toHaveBeenLastCalledWith(['send-keys', '-t', '%3', '--', 'Enter']);
      panes = '';
      expect((await request('POST', 'commands/submit', { path: repo.root })).status).toBe(409);
    } finally {
      await fx.cleanup();
      await rm(data, { recursive: true, force: true });
    }
  });

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
