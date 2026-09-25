import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { FileDiff, FilesResponse } from '@warden/shared';
import { createApp, NvimService, resolveRepo, StateStore } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

// A merge stopped on a conflict: the file that needs looking at most must not vanish from the
// working view, and must not be staged from it either.

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;

const files = async (key: string) => (await (await app.request(`/api/targets/${key}/files`)).json()) as FilesResponse;

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-conflict-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-conflict-data-'));
  fx.git('checkout', '-q', '-b', 'other');
  await fx.write('src/a.ts', 'export function a() {\n  return 100;\n}\n');
  fx.git('commit', '-q', '-am', 'other');
  fx.git('checkout', '-q', 'main');
  await fx.write('src/a.ts', 'export function a() {\n  return 200;\n}\n');
  fx.git('commit', '-q', '-am', 'main');
  try {
    fx.git('merge', '-q', 'other');
  } catch {
    /* stops on the conflict, as intended */
  }
  const repo = await resolveRepo(fx.root);
  app = createApp({ repo, store: new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot), nvim: new NvimService([path.join(dataDir, 'none')]) });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('a file in conflict', () => {
  it('is listed in the working view, marked, with its markers in a diff against HEAD', async () => {
    const entry = (await files('working')).files.find((f) => f.path === 'src/a.ts');
    expect(entry).toMatchObject({ conflicted: true });
    const diff = (await (await app.request('/api/targets/working/file?path=src%2Fa.ts')).json()) as FileDiff;
    expect(diff.conflicted).toBe(true);
    const added = diff.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content));
    expect(added.some((l) => l.startsWith('<<<<<<<'))).toBe(true);
  });

  it('is not staged from the page', async () => {
    const entry = (await files('working')).files.find((f) => f.path === 'src/a.ts')!;
    const res = await app.request('/api/targets/working/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/a.ts', contentHash: entry.contentHash }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('conflicted');
  });
});
