import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileDiff, FilesResponse } from '@warden/shared';
import { createApp, resolveRepo, StateStore } from './compat/index.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

// A merge stopped on a conflict: the file that needs looking at most must not vanish from the
// read-only diff.

let fx: FixtureRepo;
let app: ReturnType<typeof createApp>;
let dataDir: string;
let preparing: Promise<void> | undefined;

const files = async (key: string) => (await (await app.request(`/api/targets/${key}/files`)).json()) as FilesResponse;

async function prepareConflict() {
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
  app = createApp({ repo, store: new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot) });
}

beforeAll(() => {
  preparing = prepareConflict();
  return preparing;
});

afterAll(async () => {
  try {
    // A timed-out setup is still running: wait for its Git reads and writes before
    // deleting their cwd, including when a diagnostic shortens the setup timeout.
    await preparing;
  } finally {
    await app?.close();
    await fx?.cleanup();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}, 30000);

describe('a file in conflict', () => {
  it('is listed in the working view, marked, with its markers in a diff against HEAD', async () => {
    const entry = (await files('working')).files.find((f) => f.path === 'src/a.ts');
    expect(entry).toMatchObject({ conflicted: true });
    const diff = (await (await app.request('/api/targets/working/file?path=src%2Fa.ts')).json()) as FileDiff;
    expect(diff.conflicted).toBe(true);
    const added = diff.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content));
    expect(added.some((l) => l.startsWith('<<<<<<<'))).toBe(true);
  });
});
