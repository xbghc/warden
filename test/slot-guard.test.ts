import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { WorktreesResponse } from '@warden/shared';
import { createApp, NvimService, resolveRepo, StateStore } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

// A slot is written — reset, clean, switch, removed — only while it is this repository's own
// checkout with nothing stopped halfway in it.

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;

const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => (await (await app.request('/api/worktrees')).json()) as WorktreesResponse;
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
const slotDir = () => path.join(path.dirname(fx.root), `${path.basename(fx.root)}-1`);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-guard-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-guard-data-'));
  const repo = await resolveRepo(fx.root);
  app = createApp({ repo, store: new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot), nvim: new NvimService([path.join(dataDir, 'none')]) });
  expect((await send('POST', '/api/worktrees', { branch: 'agent/one', base: 'main' })).status).toBe(201);
});

afterEach(async () => {
  await rm(slotDir(), { recursive: true, force: true });
  await rm(slotDir().replace(/-1$/, '-2'), { recursive: true, force: true });
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('writes to a slot', () => {
  it('refuses to release a directory that is another repository now, even when forced', async () => {
    // The slot is deleted behind git's back and something else is cloned or initialised there.
    await rm(slotDir(), { recursive: true, force: true });
    git(path.dirname(slotDir()), 'init', '-q', slotDir());
    await writeFile(path.join(slotDir(), 'precious.txt'), 'not warden’s\n');

    const row = (await list()).worktrees.find((w) => w.slot === 1)!;
    expect(row).toMatchObject({ foreign: true, free: false });
    const res = await send('POST', '/api/worktrees/release', { path: row.path, force: true });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_our_checkout');
    expect(await readFile(path.join(slotDir(), 'precious.txt'), 'utf8')).toBe('not warden’s\n');
    expect(await code(await send('POST', '/api/worktrees', { branch: 'agent/two', slot: 1 }))).toBe('not_our_checkout');
  });

  it('treats a slot with a rebase stopped in it as busy, not free, and asks before removing it', async () => {
    const row = (await list()).worktrees.find((w) => w.slot === 1)!;
    expect((await send('POST', '/api/worktrees/release', { path: row.path })).status).toBe(200);
    expect((await list()).worktrees.find((w) => w.slot === 1)).toMatchObject({ free: true });

    // What git leaves while a rebase waits on the reviewer.
    const rebaseDir = path.resolve(slotDir(), git(slotDir(), 'rev-parse', '--git-path', 'rebase-merge').trim());
    await mkdir(rebaseDir, { recursive: true });

    expect((await list()).worktrees.find((w) => w.slot === 1)).toMatchObject({ busy: 'rebase', free: false });
    expect(await code(await send('POST', '/api/worktrees', { branch: 'agent/two' }))).toBeUndefined();
    expect((await list()).worktrees.find((w) => w.branch === 'agent/two')?.slot).toBe(2);
    expect(await code(await send('POST', '/api/worktrees/release', { path: row.path }))).toBe('operation_in_progress');
    expect(await code(await send('POST', '/api/worktrees/remove', { path: row.path }))).toBe('needs_force');
    expect(existsSync(slotDir())).toBe(true);
  });
});
