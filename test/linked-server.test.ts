import os from 'node:os';
import path from 'node:path';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { FilesResponse, RepoInfo, ReviewState } from '@warden/shared';
import { createApp, resolveRepo, StateStore } from '@warden/server';
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
  main = createApp({ repo: mainRepo, store });
  const linkedRepo = await resolveRepo(linked);
  inLinked = createApp({ repo: linkedRepo, store: new StateStore(stateFile, linkedRepo.commonRoot) });
});

afterAll(async () => {
  fx.git('worktree', 'remove', '--force', linked);
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('a server started inside a linked worktree', () => {
  it('opens that worktree by its own key', async () => {
    const info = (await (await inLinked.request('/api/repo')).json()) as RepoInfo;
    expect(info.defaultTarget).toBe(`worktree:${linked}:all`);
  });

  it('resolves the same comparison and shares preferences across servers', async () => {
    await fx.write('src/a.ts', 'export function a() {\n  return 2;\n}\n');
    const files = (await (await main.request('/api/targets/all/files')).json()) as FilesResponse;
    const file = files.files.find((row) => row.path === 'src/a.ts')!;
    await send(main, 'PATCH', '/api/prefs', { viewMode: 'split' });

    // The linked worktree moves its own HEAD, as an agent committing there does.
    await writeFile(path.join(linked, 'side.txt'), 'x\n');
    fx.git('-C', linked, 'add', 'side.txt');
    fx.git('-C', linked, 'commit', '-q', '-m', 'side work');

    const own = (await (await inLinked.request(`/api/targets/${k(`worktree:${linked}:all`)}/files`)).json()) as FilesResponse;
    expect(own.files).toEqual([]);
    const viaBare = (await (await inLinked.request('/api/targets/all/files')).json()) as FilesResponse;
    expect(viaBare.files.find((row) => row.path === file.path)).toEqual(file);
    const state = (await (await inLinked.request('/api/state')).json()) as ReviewState;
    expect(state.prefs.viewMode).toBe('split');
  });
});
