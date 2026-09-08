import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Comment, CommitsResponse, ExportResponse, FileDiff, FilesResponse, ReanchorResponse, RepoInfo, ReviewState } from '@warden/shared';
import { createApp, resolveRepo, StateStore, NvimService } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let app: Hono;
let dataDir: string;
let stateFile: string;

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}
const get = (p: string) => app.request(p);
const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const k = (key: string) => encodeURIComponent(key);

beforeAll(async () => {
  fx = await makeFixtureRepo();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-data-'));
  stateFile = path.join(dataDir, 'state.json');
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(stateFile, repo.commonRoot);
  app = createApp({ repo, store, nvim: new NvimService([path.join(dataDir, 'no-sockets')]) });
});

afterAll(async () => {
  await fx.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe('repo & targets', () => {
  it('GET /api/repo describes the repository', async () => {
    const info = await json<RepoInfo>(await get('/api/repo'));
    expect(info.root).toBe(fx.root);
    expect(info.commonRoot).toBe(fx.root);
    expect(info.branch).toBe('main');
    expect(info.worktrees.map((w) => w.isMain)).toEqual([true]);
    expect(info.defaultTarget).toBe('working');
  });

  it('working target lists unstaged + untracked files; staged lists index', async () => {
    await fx.write('src/b.ts', 'export const b = 20;\n');
    await fx.write('src/new.ts', 'export const fresh = 1;\n');
    await fx.write('bin.dat', Buffer.from([0, 1, 2, 3, 255]));
    fx.git('add', 'src/b.ts');
    await fx.write('src/b.ts', 'export const b = 21;\n');

    const working = await json<FilesResponse>(await get(`/api/targets/${k('working')}/files`));
    expect(working.root).toBe(fx.root);
    expect(working.files.map((f) => [f.path, f.status, f.untracked ?? false, f.binary])).toEqual([
      ['bin.dat', 'added', true, true],
      ['src/b.ts', 'modified', false, false],
      ['src/new.ts', 'added', true, false],
    ]);
    const staged = await json<FilesResponse>(await get(`/api/targets/${k('staged')}/files`));
    expect(staged.files.map((f) => f.path)).toEqual(['src/b.ts']);
    expect(staged.files[0]!.additions).toBe(1);
    const all = await json<FilesResponse>(await get(`/api/targets/${k('all')}/files`));
    expect(all.files.map((f) => f.path)).toEqual(['bin.dat', 'src/b.ts', 'src/new.ts']);
  });

  it('serves a single file diff and full contents', async () => {
    const diff = await json<FileDiff>(await get(`/api/targets/${k('working')}/file?path=${k('src/b.ts')}`));
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.lines.map((l) => l.type)).toEqual(['del', 'add']);
    const untracked = await json<FileDiff>(await get(`/api/targets/${k('working')}/file?path=${k('src/new.ts')}`));
    expect(untracked.status).toBe('added');
    expect(untracked.untracked).toBe(true);
    const full = await json<{ content: string | null }>(await get(`/api/targets/${k('working')}/file/full?path=${k('src/b.ts')}&side=new`));
    expect(full.content).toBe('export const b = 21;\n');
    const oldSide = await json<{ content: string | null }>(await get(`/api/targets/${k('working')}/file/full?path=${k('src/b.ts')}&side=old`));
    expect(oldSide.content).toBe('export const b = 20;\n');
    const missing = await json<{ content: string | null }>(await get(`/api/targets/${k('staged')}/file/full?path=${k('nope.ts')}&side=new`));
    expect(missing.content).toBeNull();
    const notFound = await get(`/api/targets/${k('working')}/file?path=${k('README.md')}`);
    expect(notFound.status).toBe(404);
  });

  it('commit and range targets', async () => {
    const log = await json<CommitsResponse>(await get('/api/commits?limit=10'));
    expect(log.commits).toHaveLength(2);
    expect(log.commits[0]!.subject).toBe('c2: change a, add c');
    expect(log.hasMore).toBe(false);
    const c2 = log.commits[0]!.sha;
    const c1 = log.commits[1]!.sha;
    const commit = await json<FilesResponse>(await get(`/api/targets/${k(`commit:${c2}`)}/files`));
    expect(commit.files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/util/c.ts', 'added'],
    ]);
    const root = await json<FilesResponse>(await get(`/api/targets/${k(`commit:${c1}`)}/files`));
    expect(root.files.map((f) => f.status)).toEqual(['added', 'added', 'added']);
    const range = await json<FilesResponse>(await get(`/api/targets/${k(`range:${c1}..${c2}`)}/files`));
    expect(range.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/util/c.ts']);
    const page = await json<CommitsResponse>(await get(`/api/commits?limit=1`));
    expect(page.hasMore).toBe(true);
    const next = await json<CommitsResponse>(await get(`/api/commits?limit=5&before=${c2}`));
    expect(next.commits.map((c) => c.sha)).toEqual([c1]);
    const byPath = await json<CommitsResponse>(await get(`/api/commits?path=${k('src/util/c.ts')}`));
    expect(byPath.commits.map((c) => c.sha)).toEqual([c2]);
  });

  it('rejects unknown refs and option-looking refs with 400', async () => {
    expect((await get(`/api/targets/${k('commit:doesnotexist')}/files`)).status).toBe(400);
    expect((await get(`/api/targets/${k('commit:--output=/tmp/pwned')}/files`)).status).toBe(400);
    expect((await get(`/api/targets/${k('range:-x..HEAD')}/files`)).status).toBe(400);
    expect((await get(`/api/targets/${k('bogus')}/files`)).status).toBe(400);
    expect((await get(`/api/targets/${k('worktree:/nope:working')}/files`)).status).toBe(400);
    expect((await get(`/api/commits?before=--output=x`)).status).toBe(400);
    expect((await get(`/api/targets/${k('working')}/file?path=${k('../etc/passwd')}`)).status).toBe(400);
  });

  it('worktree targets', async () => {
    const wtPath = path.join(os.tmpdir(), `warden-wt-${process.pid}-${Date.now()}`);
    // Forked one commit back, so main is already ahead of the branch: what a `base` target has to ignore.
    fx.git('worktree', 'add', '-q', '-b', 'feature', wtPath, 'HEAD~1');
    try {
      const info = await json<RepoInfo>(await get('/api/repo'));
      const wt = info.worktrees.find((w) => !w.isMain)!;
      expect(wt).toBeDefined();
      expect(wt.branch).toBe('feature');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(wt.path, 'src/a.ts'), 'changed in worktree\n');
      const files = await json<FilesResponse>(await get(`/api/targets/${k(`worktree:${wt.path}:working`)}/files`));
      expect(files.root).toBe(wt.path);
      expect(files.files.map((f) => f.path)).toEqual(['src/a.ts']);
      const rangeKey = `worktree:${wt.path}:range:main..feature`;
      const range = await json<FilesResponse>(await get(`/api/targets/${k(rangeKey)}/files`));
      expect(range.files).toEqual([]);

      // `base`: everything since the branch forked off main, committed or not. c2 landed on main
      // after the fork, so its files stay out — a plain `git diff main` would list them as reverted.
      fx.git('-C', wt.path, 'commit', '-q', '-a', '-m', 'feature: change a');
      await writeFile(path.join(wt.path, 'src/b.ts'), 'changed, not committed\n');
      await writeFile(path.join(wt.path, 'src/fresh.ts'), 'untracked\n');
      const baseKey = `worktree:${wt.path}:base:main`;
      const base = await json<FilesResponse>(await get(`/api/targets/${k(baseKey)}/files`));
      expect(base.root).toBe(wt.path);
      expect(base.files.map((f) => [f.path, f.status, f.untracked ?? false])).toEqual([
        ['src/a.ts', 'modified', false],
        ['src/b.ts', 'modified', false],
        ['src/fresh.ts', 'added', true],
      ]);
      const oldSide = await json<{ content: string | null }>(await get(`/api/targets/${k(baseKey)}/file/full?path=${k('src/a.ts')}&side=old`));
      expect(oldSide.content).toBe(['export function a() {', '  return 1;', '}', ''].join('\n'));
      const newSide = await json<{ content: string | null }>(await get(`/api/targets/${k(baseKey)}/file/full?path=${k('src/b.ts')}&side=new`));
      expect(newSide.content).toBe('changed, not committed\n');
      // The range only sees the commit and the local views only the rest.
      const committed = await json<FilesResponse>(await get(`/api/targets/${k(rangeKey)}/files`));
      expect(committed.files.map((f) => f.path)).toEqual(['src/a.ts']);
      const local = await json<FilesResponse>(await get(`/api/targets/${k(`worktree:${wt.path}:all`)}/files`));
      expect(local.files.map((f) => f.path)).toEqual(['src/b.ts', 'src/fresh.ts']);
      expect((await get(`/api/targets/${k(`worktree:${wt.path}:base:nope`)}/files`)).status).toBe(400);
    } finally {
      fx.git('worktree', 'remove', '--force', wtPath);
    }
  });
});

describe('viewed, comments, export, issues', () => {
  let comment: Comment;

  it('viewed state is bound to the content hash', async () => {
    const files = await json<FilesResponse>(await get(`/api/targets/${k('working')}/files`));
    const b = files.files.find((f) => f.path === 'src/b.ts')!;
    expect(b.viewed).toBe(false);
    await send('PUT', `/api/targets/${k('working')}/viewed`, { path: 'src/b.ts', viewed: true, contentHash: b.contentHash });
    let again = await json<FilesResponse>(await get(`/api/targets/${k('working')}/files`));
    expect(again.files.find((f) => f.path === 'src/b.ts')!.viewed).toBe(true);
    // change the file -> viewed dropped, changed notice shown
    await fx.write('src/b.ts', 'export const b = 22;\n');
    again = await json<FilesResponse>(await get(`/api/targets/${k('working')}/files`));
    const b2 = again.files.find((f) => f.path === 'src/b.ts')!;
    expect(b2.viewed).toBe(false);
    expect(b2.changed).toBe(true);
    const state = await json<ReviewState>(await get('/api/state'));
    expect(state.targets.working?.viewed['src/b.ts']).toBeUndefined();
    // re-view clears the notice
    await send('PUT', `/api/targets/${k('working')}/viewed`, { path: 'src/b.ts', viewed: true, contentHash: b2.contentHash });
    again = await json<FilesResponse>(await get(`/api/targets/${k('working')}/files`));
    expect(again.files.find((f) => f.path === 'src/b.ts')).toMatchObject({ viewed: true, changed: false });
  });

  it('creates a comment with anchor + snippet', async () => {
    await fx.write('src/a.ts', ['export function a() {', '  return 3;', '}', '', 'export const extra = true;', 'export const more = 1;', ''].join('\n'));
    const res = await send('POST', `/api/targets/${k('working')}/comments`, {
      filePath: 'src/a.ts',
      side: 'new',
      startLine: 2,
      endLine: 2,
      body: 'why 3?',
    });
    expect(res.status).toBe(201);
    comment = await json<Comment>(res);
    expect(comment.codeSnippet).toEqual(['  return 3;']);
    expect(comment.status).toBe('active');
    expect(comment.anchor.lineHashes).toHaveLength(1);
    const bad = await send('POST', `/api/targets/${k('working')}/comments`, { filePath: 'src/a.ts', side: 'new', startLine: 999, endLine: 999, body: 'x' });
    expect(bad.status).toBe(400);
    const files = await json<FilesResponse>(await get(`/api/targets/${k('working')}/files`));
    expect(files.comments.map((c) => c.id)).toEqual([comment.id]);
  });

  it('reanchors after unrelated edits and orphans after edits to the commented line', async () => {
    // unrelated edit at top of file (same hunk, shifted)
    await fx.write('src/a.ts', ['// header', 'export function a() {', '  return 3;', '}', '', 'export const extra = true;', 'export const more = 1;', ''].join('\n'));
    let re = await json<ReanchorResponse>(await send('POST', `/api/targets/${k('working')}/comments/reanchor`, {}));
    expect(re.comments[0]).toMatchObject({ status: 'active', startLine: 3, endLine: 3 });
    // now change the commented line itself
    await fx.write('src/a.ts', ['// header', 'export function a() {', '  return 4;', '}', '', 'export const extra = true;', 'export const more = 1;', ''].join('\n'));
    re = await json<ReanchorResponse>(await send('POST', `/api/targets/${k('working')}/comments/reanchor`, {}));
    expect(re.comments[0]!.status).toBe('orphaned');
    expect(re.comments[0]!.codeSnippet).toEqual(['  return 3;']);
    // manual re-attach to a new selection
    const patched = await json<Comment>(await send('PATCH', `/api/targets/${k('working')}/comments/${comment.id}`, { side: 'new', startLine: 3, endLine: 3 }));
    expect(patched.status).toBe('active');
    expect(patched.codeSnippet).toEqual(['  return 4;']);
    comment = patched;
  });

  it('exports comments and marks them exported', async () => {
    const res = await json<ExportResponse>(await send('POST', '/api/comments/export', { commentIds: [comment.id, 'missing'] }));
    expect(res.count).toBe(1);
    expect(res.text).toContain('# Review comments\nTarget: working\nRepo: ' + fx.root + '\nCount: 1\n\n## src/a.ts:3 (new)\n```ts\n3 |   return 4;\n```\n> why 3?');
    const state = await json<ReviewState>(await get('/api/state'));
    const c = state.targets.local!.comments[0]!;
    expect(c.status).toBe('exported');
    expect(c.exportedAt).toBeTruthy();
    // editing the body keeps it exported; re-anchoring an exported comment keeps exported status
    const edited = await json<Comment>(await send('PATCH', `/api/targets/${k('working')}/comments/${comment.id}`, { body: 'why 4?' }));
    expect(edited.status).toBe('exported');
    expect(edited.body).toBe('why 4?');
  });

  it('issues link comments and survive a store reload', async () => {
    const created = await json<{ id: string; status: string }>(await send('POST', '/api/issues', { title: 'Totals', body: 'desc', commentIds: [comment.id] }));
    expect(created.status).toBe('open');
    const closed = await json<{ status: string }>(await send('PATCH', `/api/issues/${created.id}`, { status: 'closed' }));
    expect(closed.status).toBe('closed');
    const exp = await json<ExportResponse>(await send('POST', `/api/issues/${created.id}/export`));
    expect(exp.text.startsWith('# Issue: Totals\nStatus: closed\n')).toBe(true);
    expect(exp.count).toBe(1);
    // fresh store instance == server restart
    const repo = await resolveRepo(fx.root);
    const fresh = new StateStore(stateFile, repo.commonRoot);
    const state = await fresh.load();
    expect(state.issues[0]).toMatchObject({ title: 'Totals', status: 'closed', commentIds: [comment.id] });
    expect(state.targets.local!.comments).toHaveLength(1);
    // deleting a comment unlinks it from issues
    await send('DELETE', `/api/targets/${k('working')}/comments/${comment.id}`);
    const after = await json<{ issues: { commentIds: string[] }[] }>(await get('/api/issues'));
    expect(after.issues[0]!.commentIds).toEqual([]);
    expect((await send('DELETE', `/api/issues/${created.id}`)).status).toBe(200);
    expect((await send('DELETE', `/api/issues/${created.id}`)).status).toBe(404);
  });

  it('prefs are persisted', async () => {
    await send('PATCH', '/api/prefs', { viewMode: 'split', lastTarget: 'staged' });
    const info = await json<RepoInfo>(await get('/api/repo'));
    expect(info.defaultTarget).toBe('staged');
    const state = await json<ReviewState>(await get('/api/state'));
    expect(state.prefs.viewMode).toBe('split');
  });

  it('nvim endpoints degrade gracefully without instances', async () => {
    const res = await json<{ instances: unknown[]; selected?: string }>(await get(`/api/nvim/instances?root=${k(fx.root)}`));
    expect(res.instances).toEqual([]);
    expect(res.selected).toBeUndefined();
    const open = await send('POST', '/api/nvim/open', { socket: '/nope.sock', absPath: '/x', line: 1 });
    expect(open.status).toBe(400);
  });
});

describe('static + unknown routes', () => {
  it('unknown api routes return JSON 404', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: 'not_found' });
  });
  it('cleans up nothing in the repo (no writes)', async () => {
    // The fixture's .git must not contain a lock file left by us.
    await expect(unlink(path.join(fx.root, '.git', 'index.lock'))).rejects.toThrow();
  });
});
