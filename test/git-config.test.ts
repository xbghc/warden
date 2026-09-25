import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { CommitsResponse, FilesResponse } from '@warden/shared';
import { createApp, NvimService, resolveRepo, StateStore } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

// The repository's own git config reaches every command warden parses. Each setting here once
// changed that output: converted text staged into the index, broken paths, debug code staged as
// code, fake rows in the history. The listing and staging must not notice any of them.

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;

const files = async (key: string) => (await (await app.request(`/api/targets/${key}/files`)).json()) as FilesResponse;
const stage = (body: unknown) =>
  app.request('/api/targets/working/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  fx = await makeFixtureRepo('warden-config-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-config-data-'));
  for (const [k, v] of [
    ['diff.mnemonicPrefix', 'true'],
    ['color.ui', 'always'],
    ['submodule.recurse', 'true'],
    ['log.showSignature', 'true'],
    ['diff.up.textconv', 'tr a-z A-Z'],
  ]) {
    fx.git('config', k!, v!);
  }
  await fx.write('.gitattributes', '*.up diff=up\n');
  fx.git('add', '.gitattributes');
  fx.git('commit', '-q', '-m', 'attributes');
  const repo = await resolveRepo(fx.root);
  app = createApp({ repo, store: new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot), nvim: new NvimService([path.join(dataDir, 'none')]) });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('diffs under a hostile git config', () => {
  it('lists plain paths, whatever the prefix settings', async () => {
    await fx.write('src/a.ts', 'export function a() {\n  return 2;\n}\n');
    const listed = (await files('working')).files.map((f) => f.path);
    expect(listed).toContain('src/a.ts');
    expect(listed.some((p) => /^[wicoab]\//.test(p))).toBe(false);
  });

  it('stages the bytes on disk, not the textconv output', async () => {
    await fx.write('new.up', 'hello\nworld\n');
    const entry = (await files('working')).files.find((f) => f.path === 'new.up')!;
    expect(entry.untracked).toBe(true);
    const res = await stage({ path: 'new.up', contentHash: entry.contentHash });
    expect(res.status).toBe(200);
    expect(fx.git('show', ':new.up')).toBe('hello\nworld\n');
  });

  it('still finds debug markers with color.ui=always and submodule.recurse', async () => {
    await fx.write('src/b.ts', 'export const b = 2;\nconsole.log(b); // nocommit\n');
    const entry = (await files('working')).files.find((f) => f.path === 'src/b.ts')!;
    expect(entry.debugAdditions).toBe(1);
  });

  it('lists only commits in the history', async () => {
    const res = (await (await app.request('/api/commits?limit=10')).json()) as CommitsResponse;
    expect(res.commits.length).toBeGreaterThan(0);
    expect(res.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
  });

  it('reads a file named like a revision as a file', async () => {
    await fx.write('HEAD', 'not a ref\n');
    const listed = (await files('all')).files.map((f) => f.path);
    expect(listed).toContain('HEAD');
  });
});
