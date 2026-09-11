import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { TmuxService } from './tmux.js';
import { createApp } from './app.js';
import { StateStore } from './state.js';
import { resolveRepo } from './repo.js';
import { makeFixtureRepo } from '../../../test/fixtures/make-repo.js';

describe('tmux integration', () => {
  it('only opens windows for registered worktrees through the API', async () => {
    const fx = await makeFixtureRepo();
    try {
      const repo = await resolveRepo(fx.root);
      const run = vi.fn(async (args: string[]) => (args[0] === 'list-sessions' ? `$1\trepo\t${repo.commonRoot}\n` : '@2\n'));
      const app = createApp({ repo, store: new StateStore(path.join(fx.root, 'state.json'), repo.commonRoot), tmux: new TmuxService(run) });
      const post = (body: unknown) =>
        app.request('/api/tmux/windows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post(null)).status).toBe(400);
      expect((await post({ path: path.dirname(fx.root), sessionId: '$1' })).status).toBe(400);
      expect(run).not.toHaveBeenCalled();
      expect((await post({ path: repo.root, sessionId: '$1' })).status).toBe(201);
    } finally {
      await fx.cleanup();
    }
  });
  it('matches the main directory and uses a session ID with a separate working-directory argument', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'warden-tmux-'));
    try {
      const wt = path.join(root, 'topic #1');
      await mkdir(wt);
      const run = vi.fn(async (args: string[]) => (args[0] === 'list-sessions' ? `$1\trepo\t${root}\n$2\tother\t${wt}\n` : '@4\n'));
      const tmux = new TmuxService(run);
      expect(await tmux.sessions(root)).toEqual([{ id: '$1', name: 'repo', path: root }]);
      expect(await tmux.open(root, wt, '$1')).toEqual({ session: 'repo', window: '@4' });
      expect(run).toHaveBeenLastCalledWith(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', '$1:', '-c', (await realpath(wt)).replaceAll('#', '##')]);
      await expect(tmux.open(root, wt, '$2')).rejects.toMatchObject({ code: 'tmux_session_missing' });
      expect(run.mock.calls.filter(([args]) => args[0] === 'new-window')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports discovery failures without creating a window', async () => {
    const run = vi.fn(async () => {
      throw new Error('tmux unavailable');
    });
    await expect(new TmuxService(run).open(process.cwd(), process.cwd(), '$1')).rejects.toThrow('tmux unavailable');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
