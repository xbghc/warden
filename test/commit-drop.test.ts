import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Comment, ReanchorResponse } from '@warden/shared';
import { createApp, NvimService, resolveRepo, StateStore } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

// A comment is deleted with its code only when that code went into a commit. Everything else that
// moves HEAD must leave it orphaned: these are the ways a reviewer's comments used to vanish.

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;

const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const reanchor = async () => (await (await send('POST', '/api/targets/working/comments/reanchor', {})).json()) as ReanchorResponse;
const comment = async (line: number) =>
  (await (
    await send('POST', '/api/targets/working/comments', { filePath: 'src/a.ts', side: 'new', startLine: line, endLine: line, body: 'why?' })
  ).json()) as Comment;
const statusOf = (res: ReanchorResponse, id: string) => res.comments.find((c) => c.id === id)?.status;

const edited = ['export function a() {', '  return 42;', '}', ''].join('\n');

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-drop-');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-drop-data-'));
  const repo = await resolveRepo(fx.root);
  app = createApp({ repo, store: new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot), nvim: new NvimService([path.join(dataDir, 'none')]) });
});

afterEach(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('a moved HEAD deletes only comments whose code was committed', () => {
  it('deletes a comment once its lines are committed', async () => {
    await fx.write('src/a.ts', edited);
    const c = await comment(2);
    await reanchor();
    fx.git('commit', '-q', '-am', 'take the change');
    expect(statusOf(await reanchor(), c.id)).toBeUndefined();
  });

  it('keeps it through a branch switch with the work stashed', async () => {
    fx.git('branch', 'other', 'HEAD~1');
    await fx.write('src/a.ts', edited);
    const c = await comment(2);
    await reanchor();
    fx.git('stash', '-q');
    fx.git('checkout', '-q', 'other');
    expect(statusOf(await reanchor(), c.id)).toBe('orphaned');
    fx.git('checkout', '-q', 'main');
    fx.git('stash', 'pop', '-q');
    expect(statusOf(await reanchor(), c.id)).toBe('active');
  });

  it('keeps it when HEAD moves forward by a commit that does not carry its lines', async () => {
    await fx.write('src/a.ts', edited);
    const c = await comment(2);
    await reanchor();
    // The agent rewrote the commented line, then committed only another file.
    await fx.write('src/a.ts', edited.replace('42', '43'));
    await fx.write('src/b.ts', 'export const b = 3;\n');
    fx.git('commit', '-q', '-m', 'unrelated', '--', 'src/b.ts');
    expect(statusOf(await reanchor(), c.id)).toBe('orphaned');
  });

  it('keeps it when the commented line was rewritten before the commit', async () => {
    await fx.write('src/a.ts', edited);
    const c = await comment(2);
    await reanchor();
    await fx.write('src/a.ts', edited.replace('42', '43'));
    fx.git('commit', '-q', '-am', 'a different fix');
    expect(statusOf(await reanchor(), c.id)).toBe('orphaned');
  });
});
