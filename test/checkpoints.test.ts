import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, stat, unlink } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { CheckpointsResponse, Comment, CreateCheckpointResponse, FileDiff, FilesResponse, FullFileResponse, RepoInfo, ReviewState } from '@warden/shared';
import { createApp, resolveRepo, StateStore, NvimService } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;

const get = (p: string) => app.request(p);
const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const k = (key: string) => encodeURIComponent(key);
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** Every file under `.git` with its size and mtime: what "the repository was not written" means here. */
async function gitDirListing(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await stat(p);
        out.push(`${path.relative(root, p)} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  await walk(path.join(root, '.git'));
  return out.sort();
}

const listing = async (key: string) => json<FilesResponse>(await get(`/api/targets/${k(key)}/files`));
const summary = (res: FilesResponse) => res.files.map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} +${f.additions} -${f.deletions}`);

beforeAll(async () => {
  fx = await makeFixtureRepo();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-data-'));
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(path.join(dataDir, 'state.json'), repo.commonRoot);
  app = createApp({ repo, store, nvim: new NvimService([path.join(dataDir, 'no-sockets')]) });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('checkpoints', () => {
  let first: CreateCheckpointResponse;

  it('takes the working tree, untracked files included, without writing the repository', async () => {
    await fx.write('src/b.ts', 'export const b = 20;\n');
    fx.git('add', 'src/b.ts');
    await fx.write('src/a.ts', 'export function a() {\n  return 3;\n}\n');
    await fx.write('notes.txt', 'one\ntwo\n');
    await unlink(path.join(fx.root, 'README.md'));
    expect(fx.git('status', '--porcelain')).toBe(' D README.md\n M src/a.ts\nM  src/b.ts\n?? notes.txt\n');
    const before = await gitDirListing(fx.root);

    const res = await send('POST', `/api/targets/${k('working')}/checkpoints`);
    expect(res.status).toBe(201);
    first = await json<CreateCheckpointResponse>(res);
    expect(first).toMatchObject({ unchanged: false, targetKey: 'checkpoint:1', checkpoint: { id: 1, head: fx.git('rev-parse', 'HEAD').trim() } });
    expect(first.checkpoint.worktree).toBeUndefined();
    // Nothing the checkpoint wrote is in the repository: not its tree, not the index.
    expect(() => fx.git('cat-file', '-e', first.checkpoint.tree)).toThrow();

    expect(summary(await listing('checkpoint:1'))).toEqual([]);
    expect(await gitDirListing(fx.root)).toEqual(before);
  });

  it('answers with the newest checkpoint when nothing changed since', async () => {
    const res = await send('POST', `/api/targets/${k('staged')}/checkpoints`);
    expect(res.status).toBe(200);
    expect(await json<CreateCheckpointResponse>(res)).toMatchObject({ unchanged: true, targetKey: 'checkpoint:1' });
    expect((await json<CheckpointsResponse>(await get(`/api/targets/${k('working')}/checkpoints`))).checkpoints.map((c) => c.id)).toEqual([1]);
  });

  it('diffs only what changed since the checkpoint, whatever git makes of it', async () => {
    await fx.write('src/a.ts', 'export function a() {\n  return 4;\n}\n');
    await fx.write('notes.txt', 'one\ntwo\nthree\n');
    await fx.write('README.md', '# fixture\n');
    await fx.write('fresh.ts', 'export const fresh = 1;\n');
    // Staging or committing is not a change to the working tree, so it does not show.
    fx.git('add', 'src/a.ts');
    fx.git('commit', '-q', '-m', 'agent commits a and b');
    const before = await gitDirListing(fx.root);

    const res = await listing('checkpoint:1');
    expect(summary(res)).toEqual(['added README.md +1 -0', 'added fresh.ts +1 -0', 'modified notes.txt +1 -0', 'modified src/a.ts +1 -1']);
    // A read leaves `.git` as it found it too.
    expect(await gitDirListing(fx.root)).toEqual(before);

    const diff = await json<FileDiff>(await get(`/api/targets/${k('checkpoint:1')}/file?path=${k('src/a.ts')}`));
    expect(diff.hunks[0]!.lines.filter((l) => l.type !== 'context').map((l) => `${l.type} ${l.content}`)).toEqual(['del   return 3;', 'add   return 4;']);
    const old = await json<FullFileResponse>(await get(`/api/targets/${k('checkpoint:1')}/file/full?path=${k('notes.txt')}&side=old`));
    expect(old.content).toBe('one\ntwo\n');
  });

  it('sees a file rewritten in the second the index was, at the same size', async () => {
    // The index copy is what makes a checkpoint cheap, and its stat data is what could make it
    // wrong: an entry written in the same second as the index cannot be trusted by its stat alone.
    await fx.write('src/b.ts', 'export const b = 30;\n');
    fx.git('add', 'src/b.ts');
    await fx.write('src/b.ts', 'export const b = 31;\n');
    const taken = await json<CreateCheckpointResponse>(await send('POST', `/api/targets/${k('working')}/checkpoints`));
    expect(taken.targetKey).toBe('checkpoint:2');
    const b = await json<FullFileResponse>(await get(`/api/targets/${k('checkpoint:2')}/file/full?path=${k('src/b.ts')}&side=old`));
    expect(b.content).toBe('export const b = 31;\n');
  });

  it('keeps comments and 已读 marks of its own, and drops them with the checkpoint', async () => {
    const key = 'checkpoint:1';
    const created = await send('POST', `/api/targets/${k(key)}/comments`, { filePath: 'notes.txt', side: 'new', startLine: 3, endLine: 3, body: 'why three?' });
    expect(created.status).toBe(201);
    const comment = await json<Comment>(created);
    const files = await listing(key);
    const notes = files.files.find((f) => f.path === 'notes.txt')!;
    expect((await send('PUT', `/api/targets/${k(key)}/viewed`, { path: 'notes.txt', viewed: true, contentHash: notes.contentHash })).status).toBe(200);
    expect((await listing(key)).comments.map((c) => c.id)).toEqual([comment.id]);

    expect((await send('DELETE', `/api/targets/${k('working')}/checkpoints/1`)).status).toBe(200);
    const gone = await get(`/api/targets/${k(key)}/files`);
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe('unknown_checkpoint');
    const state = await json<ReviewState>(await get('/api/state'));
    expect(state.targets[key]).toBeUndefined();
    expect(state.checkpoints.map((c) => c.id)).toEqual([2]);
    expect((await send('DELETE', `/api/targets/${k('working')}/checkpoints/1`)).status).toBe(404);
  });

  it('does not reopen a remembered checkpoint that is gone', async () => {
    await send('PATCH', '/api/prefs', { lastTarget: 'checkpoint:1' });
    expect((await json<RepoInfo>(await get('/api/repo'))).defaultTarget).toBe('working');
    await send('PATCH', '/api/prefs', { lastTarget: 'checkpoint:2' });
    expect((await json<RepoInfo>(await get('/api/repo'))).defaultTarget).toBe('checkpoint:2');
  });

  it('takes a linked worktree on its own, numbered from 1', async () => {
    const wt = path.join(dataDir, 'wt');
    fx.git('worktree', 'add', '-q', '-b', 'side', wt);
    const wtRoot = (await resolveRepo(wt)).root;
    const base = `worktree:${wtRoot}:working`;
    await fx.write(path.relative(fx.root, path.join(wtRoot, 'side.txt')), 'a\n');
    const taken = await json<CreateCheckpointResponse>(await send('POST', `/api/targets/${k(base)}/checkpoints`));
    expect(taken.targetKey).toBe(`worktree:${wtRoot}:checkpoint:1`);
    await fx.write(path.relative(fx.root, path.join(wtRoot, 'side.txt')), 'a\nb\n');
    expect(summary(await listing(taken.targetKey))).toEqual(['modified side.txt +1 -0']);
    // The repository root's checkpoints are not this worktree's.
    expect((await json<CheckpointsResponse>(await get(`/api/targets/${k(base)}/checkpoints`))).checkpoints.map((c) => c.id)).toEqual([1]);
    expect((await get(`/api/targets/${k(`worktree:${wtRoot}:checkpoint:2`)}/files`)).status).toBe(404);
  });
});
