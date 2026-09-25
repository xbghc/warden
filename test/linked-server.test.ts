import os from 'node:os';
import path from 'node:path';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Comment, ReanchorResponse, RepoInfo, ReviewState } from '@warden/shared';
import { createApp, NvimService, resolveRepo, StateStore } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

// Two servers on one repository — one started in the main worktree, one inside a linked worktree —
// share a state file. A key without a worktree must mean the same checkout to both of them.

let fx: FixtureRepo;
let dataDir: string;
let linked: string;
let main: Hono;
let inLinked: Hono;
let store: StateStore;

const send = (app: Hono, method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const k = (key: string) => encodeURIComponent(key);

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-linked-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-linked-data-'));
  linked = path.join(path.dirname(fx.root), `${path.basename(fx.root)}-wt`);
  fx.git('worktree', 'add', '-q', '-b', 'side', linked);
  linked = await realpath(linked);
  const stateFile = path.join(dataDir, 'state.json');
  const mainRepo = await resolveRepo(fx.root);
  store = new StateStore(stateFile, mainRepo.commonRoot);
  const nvim = new NvimService([path.join(dataDir, 'none')]);
  main = createApp({ repo: mainRepo, store, nvim });
  const linkedRepo = await resolveRepo(linked);
  inLinked = createApp({ repo: linkedRepo, store: new StateStore(stateFile, linkedRepo.commonRoot), nvim });
});

afterAll(async () => {
  fx.git('worktree', 'remove', '--force', linked);
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('a server started inside a linked worktree', () => {
  it('opens that worktree by its own key', async () => {
    const info = (await (await inLinked.request('/api/repo')).json()) as RepoInfo;
    expect(info.defaultTarget).toBe(`worktree:${linked}:working`);
  });

  it('neither sees nor deletes the main worktree’s comments', async () => {
    await fx.write('src/a.ts', 'export function a() {\n  return 2;\n}\n');
    const c = (await (
      await send(main, 'POST', '/api/targets/working/comments', { filePath: 'src/a.ts', side: 'new', startLine: 2, endLine: 2, body: 'why 2?' })
    ).json()) as Comment;
    await send(main, 'POST', '/api/targets/working/comments/reanchor', {});

    // The linked worktree moves its own HEAD, as an agent committing there does.
    await writeFile(path.join(linked, 'side.txt'), 'x\n');
    fx.git('-C', linked, 'add', 'side.txt');
    fx.git('-C', linked, 'commit', '-q', '-m', 'side work');

    // The linked server's page looks at its own worktree; a bare `working` from it is main's.
    await send(inLinked, 'POST', `/api/targets/${k(`worktree:${linked}:working`)}/comments/reanchor`, {});
    const viaBare = (await (await send(inLinked, 'POST', '/api/targets/working/comments/reanchor', {})).json()) as ReanchorResponse;
    expect(viaBare.comments.map((x) => [x.id, x.status])).toEqual([[c.id, 'active']]);

    const state = (await (await main.request('/api/state')).json()) as ReviewState;
    expect(state.targets.local!.comments.map((x) => x.id)).toEqual([c.id]);
  });
});
