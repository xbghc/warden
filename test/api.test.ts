import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommitsResponse,
  CreateWorktreeResponse,
  FileDiff,
  FilesResponse,
  ForkPointResponse,
  ReleaseWorktreeRequest,
  ReleaseWorktreeResponse,
  RemoveWorktreeRequest,
  RemoveWorktreeResponse,
  RepoInfo,
  ReviewState,
  Todo,
  UpdateNotice,
  WorktreesResponse,
} from '@warden/shared';
import { createApp, resolveRepo, StateStore } from '@warden/server';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let app: ReturnType<typeof createApp>;
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

beforeEach(async () => {
  fx = await makeFixtureRepo();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'warden-data-'));
  stateFile = path.join(dataDir, 'state.json');
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(stateFile, repo.commonRoot);
  app = createApp({ repo, store });
});

afterEach(async () => {
  try {
    await app.close();
    // Check after the actual API operations, not in a test with a fresh index.
    expect(existsSync(path.join(fx.root, '.git', 'index.lock'))).toBe(false);
  } finally {
    // Slot directories are siblings of this test's unique repository, including
    // slots left behind when an assertion fails halfway through an operation.
    for (const suffix of ['-1', '-2', '-3', '-4', '-5', '-feature']) {
      await rm(`${fx.root}${suffix}`, { recursive: true, force: true });
    }
    await fx.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function prepareLocalChanges() {
  await fx.write('src/b.ts', 'export const b = 20;\n');
  await fx.write('src/new.ts', 'export const fresh = 1;\n');
  await fx.write('bin.dat', Buffer.from([0, 1, 2, 3, 255]));
  fx.git('add', 'src/b.ts');
  await fx.write('src/b.ts', 'export const b = 21;\n');
}

describe('repo & targets', () => {
  it('GET /api/repo describes the repository', async () => {
    const info = await json<RepoInfo>(await get('/api/repo'));
    expect(info.root).toBe(fx.root);
    expect(info.commonRoot).toBe(fx.root);
    expect(info.branch).toBe('main');
    expect(info.worktrees.map((w) => w.isMain)).toEqual([true]);
    expect(info.defaultTarget).toBe('all');
  });

  it('working target lists unstaged + untracked files; staged lists index', async () => {
    await prepareLocalChanges();

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
    await prepareLocalChanges();
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
    const next = await json<CommitsResponse>(await get(`/api/commits?limit=5&offset=1`));
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
    expect((await get(`/api/commits?ref=--output=x`)).status).toBe(400);
    expect((await get(`/api/targets/${k('working')}/file?path=${k('../etc/passwd')}`)).status).toBe(400);
    expect((await get(`/api/targets/${k('working')}/file?path=${k('src/b.ts')}&old=${k('../x')}`)).status).toBe(400);
    expect((await get(`/api/targets/${k('working')}/file?path=${k('src/b.ts')}&old=${k('/etc/hostname')}`)).status).toBe(400);
    const outside = `${fx.root}.private.txt`;
    await writeFile(outside, 'private sibling contents\n');
    try {
      const invalid = [`../${path.basename(outside)}`];
      if (process.platform === 'win32') invalid.push(`..\\${path.basename(outside)}`, 'C:\\outside.txt', '\\\\server\\share\\file', 'src/b.ts:secret');
      for (const file of invalid) {
        const result = await get(`/api/targets/${k('working')}/file/full?path=${k(file)}&side=new`);
        expect(result.status).toBe(400);
        expect(await json<{ code: string }>(result)).toMatchObject({ code: 'invalid_path' });
      }
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('a range whose ends share no history is a 400, like base', async () => {
    // An orphan root, made without touching the index or the working tree.
    const sha = fx.git('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'island').trim();
    fx.git('branch', 'island', sha);
    try {
      const res = await get(`/api/targets/${k('range:main..island')}/files`);
      expect(res.status).toBe(400);
      expect((await json<{ code: string }>(res)).code).toBe('no_merge_base');
    } finally {
      fx.git('branch', '-D', 'island');
    }
  });

  it('decodes a target key exactly once', async () => {
    fx.git('branch', 'feat/a%b');
    try {
      expect((await get(`/api/targets/${k('range:main..feat/a%b')}/files`)).status).toBe(200);
    } finally {
      fx.git('branch', '-D', 'feat/a%b');
    }
  });

  it('keeps supported special filenames intact end to end', async () => {
    // Windows forbids double quotes and colons in filenames. All platforms still
    // exercise literal pathspecs, URL escaping, spaces and Unicode end to end.
    const names = ['docs/my notes 文档.md', "sp 'q.ts", '[literal]%.ts'];
    if (process.platform !== 'win32') names.push('sp "q.ts', ':colon.ts');
    const untrackedName = process.platform === 'win32' ? '[untracked]%.ts' : ':untracked.ts';
    const spec = (p: string) => `:(literal)${p}`;
    for (const p of names) await fx.write(p, 'one\n');
    fx.git('add', '--', ...names.map(spec));
    for (const p of names) await fx.write(p, 'two\n');
    await fx.write(untrackedName, 'new\n');
    try {
      const staged = await json<FilesResponse>(await get(`/api/targets/${k('staged')}/files`));
      const added = staged.files.filter((f) => names.includes(f.path));
      expect(added.map((f) => f.path).sort()).toEqual([...names].sort());
      expect(added.every((f) => f.status === 'added')).toBe(true);
      const working = await json<FilesResponse>(await get(`/api/targets/${k('working')}/files`));
      expect(working.files.map((f) => f.path)).toEqual(expect.arrayContaining([...names, untrackedName]));
      for (const p of [...names, untrackedName]) {
        const diff = await json<FileDiff>(await get(`/api/targets/${k('working')}/file?path=${k(p)}`));
        expect(diff.path).toBe(p);
        expect(diff.hunks[0]!.lines.some((l) => l.type === 'add')).toBe(true);
      }
      for (const p of names) {
        const full = await json<{ content: string | null }>(await get(`/api/targets/${k('working')}/file/full?path=${k(p)}&side=old`));
        expect(full.content).toBe('one\n');
      }
    } finally {
      fx.git('rm', '-q', '-f', '--cached', '--', ...names.map(spec));
      for (const p of [...names, untrackedName]) await rm(path.join(fx.root, p), { force: true });
      await rm(path.join(fx.root, 'docs'), { recursive: true, force: true });
    }
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
      // The fork point that `base` diffs against, seen from inside the worktree: one commit each side since.
      const fork = await json<ForkPointResponse>(await get(`/api/fork-point?root=${k(wt.path)}&base=main`));
      expect(fork).toEqual({ base: 'main', sha: fx.git('rev-parse', 'HEAD~1').trim(), ahead: 1, behind: 1 });
    } finally {
      fx.git('worktree', 'remove', '--force', wtPath);
    }
  });

  it('forgets a remembered target whose worktree is gone', async () => {
    const wtPath = path.join(os.tmpdir(), `warden-wt-gone-${process.pid}-${Date.now()}`);
    fx.git('worktree', 'add', '-q', '--detach', wtPath);
    try {
      const wt = (await json<RepoInfo>(await get('/api/repo'))).worktrees.find((w) => !w.isMain)!;
      const key = `worktree:${wt.path}:all`;
      await send('PATCH', '/api/prefs', { lastTarget: key });
      expect((await json<RepoInfo>(await get('/api/repo'))).defaultTarget).toBe(key);

      // Deleted behind git's back: `git worktree list` still names it, as prunable.
      await rm(wtPath, { recursive: true, force: true });
      const info = await json<RepoInfo>(await get('/api/repo'));
      expect(info.worktrees.map((w) => w.isMain)).toEqual([true]);
      expect(info.defaultTarget).toBe('all');
      expect((await json<ReviewState>(await get('/api/state'))).prefs.lastTarget).toBe('all');
      const res = await get(`/api/targets/${k(key)}/files`);
      expect(res.status).toBe(400);
      expect((await json<{ code: string }>(res)).code).toBe('unknown_worktree');
      expect((await send('POST', '/api/todos', { title: 'nowhere', root: wt.path })).status).toBe(400);

      // A key that does not parse at all is not handed back either.
      await send('PATCH', '/api/prefs', { lastTarget: 'bogus' });
      expect((await json<RepoInfo>(await get('/api/repo'))).defaultTarget).toBe('all');
    } finally {
      await rm(wtPath, { recursive: true, force: true });
      fx.git('worktree', 'prune');
    }
  });
});

describe('read-only review and preferences', () => {
  it('lists current changes without review flags or state writes', async () => {
    await prepareLocalChanges();
    const state = await json<ReviewState>(await get('/api/state'));
    state.targets['base:main'] = { viewed: { 'src/b.ts': 'obsolete-hash' } };
    await writeFile(stateFile, JSON.stringify(state));
    const stored = await readFile(stateFile, 'utf8');
    const list = async () => json<FilesResponse>(await get(`/api/targets/${k('base:main')}/files`));
    const before = (await list()).files.find((f) => f.path === 'src/b.ts')!;
    expect(before).not.toHaveProperty('viewed');
    expect(before).not.toHaveProperty('changed');
    await fx.write('src/b.ts', 'export const b = 22;\n');
    const after = (await list()).files.find((f) => f.path === before.path)!;
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after).not.toHaveProperty('viewed');
    expect(after).not.toHaveProperty('changed');
    expect(await readFile(stateFile, 'utf8')).toBe(stored);
  });

  it('reviews current content regardless of staging and preserves the real index', async () => {
    await prepareLocalChanges();
    const list = async () => json<FilesResponse>(await get('/api/targets/all/files'));
    const before = (await list()).files.find((f) => f.path === 'src/b.ts')!;
    const indexPath = path.join(fx.root, '.git', 'index');
    const index = await readFile(indexPath);
    const head = fx.git('rev-parse', 'HEAD');
    const working = await readFile(path.join(fx.root, 'src/b.ts'));
    const full = await json<{ content: string }>(await get('/api/targets/all/file/full?path=src%2Fb.ts&side=new'));
    expect(full.content).toBe('export const b = 21;\n');
    expect(fx.git('show', ':src/b.ts')).toBe('export const b = 20;\n');
    expect(await readFile(indexPath)).toEqual(index);
    expect(await readFile(path.join(fx.root, 'src/b.ts'))).toEqual(working);
    expect(fx.git('rev-parse', 'HEAD')).toBe(head);

    // External staging changes neither the current content nor its review hash.
    fx.git('add', 'src/b.ts');
    expect((await list()).files.find((f) => f.path === before.path)).toMatchObject({ contentHash: before.contentHash });
    fx.git('restore', '--staged', '--', 'src/b.ts');
    expect((await list()).files.find((f) => f.path === before.path)).toMatchObject({ contentHash: before.contentHash });

    await fx.write('src/b.ts', 'export const b = 22;\n');
    expect((await list()).files.find((f) => f.path === before.path)?.contentHash).not.toBe(before.contentHash);
  });

  it('returns 404 for removed review-state routes without changing repository or state', async () => {
    await prepareLocalChanges();
    const state = await json<ReviewState>(await get('/api/state'));
    const head = fx.git('rev-parse', 'HEAD');
    const index = await readFile(path.join(fx.root, '.git', 'index'));
    const work = await readFile(path.join(fx.root, 'src/b.ts'));
    for (const [method, route] of [
      ['PUT', '/api/targets/all/viewed'],
      ['GET', '/api/targets/all/comments'],
      ['POST', '/api/targets/all/comments'],
      ['PATCH', '/api/targets/all/comments/old'],
      ['DELETE', '/api/targets/all/comments/old'],
      ['POST', '/api/targets/all/comments/old/replies'],
      ['POST', '/api/targets/all/comments/reanchor'],
      ['POST', '/api/comments/export'],
    ]) {
      const response = await send(method!, route!, method === 'GET' ? undefined : { body: 'obsolete', commentIds: ['old'] });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'not_found' });
    }
    expect(await json<ReviewState>(await get('/api/state'))).toEqual(state);
    expect(await readFile(path.join(fx.root, '.git', 'index'))).toEqual(index);
    expect(await readFile(path.join(fx.root, 'src/b.ts'))).toEqual(work);
    expect(fx.git('rev-parse', 'HEAD')).toBe(head);
    expect(await json<FilesResponse>(await get('/api/targets/all/files'))).not.toHaveProperty('comments');
  });

  it('copies task notes without modifying state or taking a checkpoint', async () => {
    const created = await json<Todo>(await send('POST', '/api/todos', { title: 'Totals', body: 'desc' }));
    const before = await json<ReviewState>(await get('/api/state'));
    const response = await send('POST', `/api/todos/${created.id}/export`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Totals\n\ndesc' });
    expect(await json<ReviewState>(await get('/api/state'))).toEqual(before);
  });

  it('prefs are persisted', async () => {
    await send('PATCH', '/api/prefs', { viewMode: 'split', lastTarget: 'staged' });
    const info = await json<RepoInfo>(await get('/api/repo'));
    expect(info.defaultTarget).toBe('all');
    const state = await json<ReviewState>(await get('/api/state'));
    expect(state.prefs.viewMode).toBe('split');
  });

  it('remembers content navigation without losing the review target and ignores unknown panels', async () => {
    await send('PATCH', '/api/prefs', { lastTarget: 'staged', lastPanel: 'diff' });
    await send('PATCH', '/api/prefs', { lastPanel: 'orchestration' });
    await send('PATCH', '/api/prefs', { lastPanel: 'unknown' });
    const state = await json<ReviewState>(await get('/api/state'));
    expect(state.prefs.lastPanel).toBe('orchestration');
    expect((await json<RepoInfo>(await get('/api/repo'))).defaultTarget).toBe('all');
    await send('PATCH', '/api/prefs', { lastPanel: 'commits' });
    expect((await json<ReviewState>(await get('/api/state'))).prefs.lastPanel).toBe('commits');
  });
});

describe('removed staging API', () => {
  it.each(['working', 'staged'])('rejects writes through the old %s endpoint without changing Git content', async (key) => {
    await prepareLocalChanges();
    const diff = await json<FileDiff>(await get(`/api/targets/${key}/file?path=src%2Fb.ts`));
    const indexPath = path.join(fx.root, '.git', 'index');
    const index = await readFile(indexPath);
    const working = await readFile(path.join(fx.root, 'src/b.ts'));
    const head = fx.git('rev-parse', 'HEAD');
    for (const hunks of [undefined, [{ index: 0 }], [{ index: 0, lines: [0] }]]) {
      const res = await send('POST', `/api/targets/${key}/stage`, { path: diff.path, contentHash: diff.contentHash, hunks });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not_found' });
    }
    expect(await readFile(indexPath)).toEqual(index);
    expect(await readFile(path.join(fx.root, 'src/b.ts'))).toEqual(working);
    expect(fx.git('rev-parse', 'HEAD')).toBe(head);
  });
});

describe('debug code', () => {
  const fileDiff = async (key: string, p: string) => json<FileDiff>(await get(`/api/targets/${k(key)}/file?path=${k(p)}`));
  const entry = async (key: string, p: string) => (await json<FilesResponse>(await get(`/api/targets/${k(key)}/files`))).files.find((f) => f.path === p);
  // Put together at run time so that this file does not read as debug code itself.
  const mark = (m: string) => `// ${m}`;
  const file = 'dbg/app.ts';
  const loose = 'dbg/scratch.ts';
  const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  base[4] = mark('debug:start');
  base[29] = mark('debug:end');

  beforeEach(async () => {
    // The block's markers are far from both edits: no hunk shows them.
    await fx.write(file, base.join('\n') + '\n');
    fx.git('add', file);
    const edited = [...base];
    edited[14] = 'line 15 in the block';
    edited[39] = 'line 40 outside';
    await fx.write(file, edited.join('\n') + '\n');
    await fx.write(loose, `keep()\nprobe() ${mark('nocommit')}\n`);
  });

  it('flags lines inside a block whose markers lie outside the hunk, on both sides', async () => {
    const diff = await fileDiff('working', file);
    const changed = diff.hunks.flatMap((h) => h.lines.filter((l) => l.type !== 'context'));
    expect(changed.map((l) => [l.type, l.content, !!l.debug])).toEqual([
      ['del', 'line 15', true],
      ['add', 'line 15 in the block', true],
      ['del', 'line 40', false],
      ['add', 'line 40 outside', false],
    ]);
    expect(await entry('working', file)).toMatchObject({ additions: 2, debugAdditions: 1, debugDeletions: 1 });
    expect(await entry('working', loose)).toMatchObject({ untracked: true, additions: 2, debugAdditions: 1 });
  });
});

describe('commit log', () => {
  const log = async (query: string) => json<CommitsResponse>(await get(`/api/commits?${query}`));
  const subjects = (r: CommitsResponse) => r.commits.map((c) => c.subject.slice(0, 2)).sort();

  beforeEach(async () => {
    // Build the same history independently for each test, with a tag, side branch
    // and merge commit: c5 (merge) → c4 (topic) + c3 (tag) → c2 → c1.
    await fx.write('settled.txt', 'settled\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'c3: settle the tree');
    fx.git('tag', 'v1.0');
    fx.git('checkout', '-q', '-b', 'topic');
    await fx.write('topic.txt', 'topic\n');
    fx.git('add', 'topic.txt');
    fx.git('commit', '-q', '-m', 'c4: topic work');
    fx.git('checkout', '-q', 'main');
    fx.git('merge', '-q', '--no-ff', '-m', 'c5: merge topic', 'topic');
  });

  it('decorates commits with HEAD, branches and tags', async () => {
    const { commits, hasMore } = await log('limit=10');
    expect(commits).toHaveLength(5);
    expect(hasMore).toBe(false);
    const by = (prefix: string) => commits.find((c) => c.subject.startsWith(prefix))!;
    expect(commits[0]!.sha).toBe(by('c5').sha);
    expect(by('c5')).toMatchObject({ head: true, refs: [{ name: 'main', kind: 'branch' }] });
    expect(by('c5').parents).toHaveLength(2);
    expect(by('c4')).toMatchObject({ head: false, refs: [{ name: 'topic', kind: 'branch' }] });
    expect(by('c3').refs).toEqual([{ name: 'v1.0', kind: 'tag' }]);
    expect(by('c1').refs).toEqual([]);
  });

  it('pages through a merged history without losing or repeating a commit', async () => {
    const seen: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await log(`limit=2&offset=${seen.length}`);
      pages++;
      seen.push(...page.commits.map((c) => c.sha));
      if (!page.hasMore) break;
      if (pages > 10) throw new Error('paging never ends');
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('searches message, author, sha and path on the server', async () => {
    expect(subjects(await log('q=TOPIC'))).toEqual(['c4', 'c5']);
    expect(subjects(await log('q=topic&firstParent=1'))).toEqual(['c5']);
    expect(subjects(await log('firstParent=1'))).toEqual(['c1', 'c2', 'c3', 'c5']);
    expect(subjects(await log('author=fixture'))).toHaveLength(5);
    expect(subjects(await log('author=nobody'))).toEqual([]);
    expect(subjects(await log(`q=topic&path=${k('topic.txt')}`))).toEqual(['c4']);

    const all = (await log('limit=10')).commits;
    const c1 = all.find((c) => c.subject.startsWith('c1'))!;
    const c5 = all[0]!;
    // A sha (or a prefix of one) finds the commit itself, ahead of any message matches.
    expect((await log(`q=${c1.sha.slice(0, 7)}`)).commits[0]!.sha).toBe(c1.sha);
    expect((await log(`q=${c1.sha}`)).commits.map((c) => c.sha)).toEqual([c1.sha]);
    // ...but only on the first page, or it would head every page of the same search.
    expect((await log(`q=${c1.sha}&offset=1`)).commits).toEqual([]);
    // Pages walk from the given ref, so the list is stable while HEAD moves on.
    expect((await log(`ref=${c5.parents[0]}&limit=10`)).commits.map((c) => c.sha)).not.toContain(c5.sha);
    // Search text is never an option to git.
    expect((await get('/api/commits?q=--output=x&author=--exec-path')).status).toBe(200);
  });

  it('reports where HEAD forked off a base', async () => {
    const fork = (query: string) => get(`/api/fork-point?${query}`);
    const all = (await log('limit=10')).commits;
    const by = (prefix: string) => all.find((c) => c.subject.startsWith(prefix))!;
    // topic is merged in, so the fork point is its tip and main is the merge commit ahead of it.
    expect(await json(await fork('base=topic'))).toEqual({ base: 'topic', sha: by('c4').sha, ahead: 1, behind: 0 });
    expect(await json(await fork('base=v1.0'))).toMatchObject({ sha: by('c3').sha, ahead: 2, behind: 0 });
    expect(await json(await fork('base=main'))).toMatchObject({ sha: by('c5').sha, ahead: 0, behind: 0 });
    expect(await json(await fork(`base=${by('c1').sha}`))).toMatchObject({ sha: by('c1').sha, ahead: 4, behind: 0 });
    expect(await json<{ code: string }>(await fork('base=nope'))).toMatchObject({ code: 'unknown_ref' });
    expect((await fork('')).status).toBe(400);
    expect((await fork('base=--output=x')).status).toBe(400);
    expect((await fork('base=main&root=/nowhere')).status).toBe(400);
    // An orphan root shares nothing with HEAD, like for a `base` target.
    const island = fx.git('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'island').trim();
    fx.git('branch', 'island', island);
    try {
      expect(await json<{ code: string }>(await fork('base=island'))).toMatchObject({ code: 'no_merge_base' });
    } finally {
      fx.git('branch', '-D', 'island');
    }
  });
});

describe('worktree management', () => {
  // Beside the fixture, where the server puts its slots: `<repo>-<n>`.
  const slotDir = (n: number) => path.join(path.dirname(fx.root), `${path.basename(fx.root)}-${n}`);
  const byHand = () => path.join(path.dirname(fx.root), `${path.basename(fx.root)}-feature`);
  const list = async () => json<WorktreesResponse>(await get('/api/worktrees'));
  const slot = async (n: number) => (await list()).worktrees.find((w) => w.slot === n);
  const create = (body: unknown) => send('POST', '/api/worktrees', body);
  const release = (body: ReleaseWorktreeRequest) => send('POST', '/api/worktrees/release', body);
  const remove = (body: RemoveWorktreeRequest) => send('POST', '/api/worktrees/remove', body);
  const code = async (res: Response) => (await json<{ code: string }>(res)).code;

  const freeSlot = (n: number, ref = 'main') => fx.git('worktree', 'add', '-q', '--detach', slotDir(n), ref);
  const topicSlot = () => {
    fx.git('branch', 'topic', 'HEAD~1');
    freeSlot(1, 'topic');
  };

  it('lists the checkouts, the local branches and the slot a checkout would make', async () => {
    fx.git('branch', 'topic');
    const res = await list();
    expect(res.worktrees.map((w) => [w.isMain, w.branch, w.prunable, w.slot, w.free])).toEqual([[true, 'main', false, undefined, false]]);
    expect(res.branches.find((b) => b.name === 'main')).toMatchObject({ worktree: fx.root });
    const topic = res.branches.find((b) => b.name === 'topic');
    expect(topic).toMatchObject({ name: 'topic' });
    expect(topic).not.toHaveProperty('worktree');
    expect(res.newSlot).toEqual({ slot: 1, path: slotDir(1) });
  });

  it('makes slot 1 for a new branch, counts its changes, and releases it only when forced, keeping the directory', async () => {
    const res = await create({ branch: 'agent/one', base: 'main' });
    expect(res.status).toBe(201);
    const made = await json<CreateWorktreeResponse>(res);
    expect(made).toMatchObject({ slot: 1, reused: false, worktree: { path: await realpath(slotDir(1)), branch: 'agent/one', isMain: false } });
    expect((await json<RepoInfo>(await get('/api/repo'))).worktrees.map((w) => w.branch)).toEqual(['main', 'agent/one']);
    expect(await slot(1)).toMatchObject({ slot: 1, free: false, dirty: 0 });
    // The branch is taken now: neither a second checkout of it nor a second `-b` goes through.
    expect(await code(await create({ branch: 'agent/one' }))).toBe('branch_in_use');
    expect(await code(await create({ branch: 'agent/one', base: 'main' }))).toBe('branch_exists');
    // Nor is the slot free for another branch; the next one is the number after it.
    expect(await code(await create({ branch: 'agent/two', slot: 1 }))).toBe('slot_in_use');
    expect((await list()).newSlot).toEqual({ slot: 2, path: slotDir(2) });

    // What an install leaves behind is ignored: neither counted as dirty nor cleaned away.
    await writeFile(path.join(fx.root, '.git', 'info', 'exclude'), 'node_modules/\n');
    await mkdir(path.join(slotDir(1), 'node_modules'), { recursive: true });
    await writeFile(path.join(slotDir(1), 'node_modules', 'keep'), 'installed\n');
    await writeFile(path.join(slotDir(1), 'scratch.txt'), 'wip\n');
    await writeFile(path.join(slotDir(1), 'src', 'a.ts'), 'edited\n');
    expect(await slot(1)).toMatchObject({ dirty: 2, free: false });
    const dirty = await release({ path: made.worktree.path });
    expect(dirty.status).toBe(409);
    expect(await code(dirty)).toBe('worktree_dirty');
    expect(fx.git('-C', slotDir(1), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('agent/one');
    // Forced: the changes go, the directory and what is ignored in it stay, and the branch is
    // deleted with them — nothing was committed on it, so `-d` agrees.
    expect(await json<ReleaseWorktreeResponse>(await release({ path: made.worktree.path, force: true, deleteBranch: true }))).toMatchObject({
      ok: true,
      branchDeleted: true,
      backup: { reason: 'release' },
    });
    expect((await list()).branches.map((b) => b.name)).not.toContain('agent/one');
    expect(await slot(1)).toMatchObject({ slot: 1, free: true, detached: true, dirty: 0 });
    expect(existsSync(path.join(slotDir(1), 'scratch.txt'))).toBe(false);
    expect(existsSync(path.join(slotDir(1), 'node_modules', 'keep'))).toBe(true);
    expect((await list()).newSlot).toEqual({ slot: 2, path: slotDir(2) });
  });

  it('reuses the free slot for an existing branch, and keeps the branch on release when it is not merged', async () => {
    topicSlot();
    await writeFile(path.join(fx.root, '.git', 'info', 'exclude'), 'node_modules/\n');
    await mkdir(path.join(slotDir(1), 'node_modules'), { recursive: true });
    await writeFile(path.join(slotDir(1), 'node_modules', 'keep'), 'installed\n');
    const made = await json<CreateWorktreeResponse>(await create({ branch: 'topic' }));
    expect(made).toMatchObject({ slot: 1, reused: true, worktree: { path: await realpath(slotDir(1)), branch: 'topic' } });
    // The install survived the switch.
    expect(existsSync(path.join(slotDir(1), 'node_modules', 'keep'))).toBe(true);
    await writeFile(path.join(slotDir(1), 'more.txt'), 'more\n');
    fx.git('-C', slotDir(1), 'add', 'more.txt');
    fx.git('-C', slotDir(1), 'commit', '-q', '-m', 'topic: more');
    const res = await json<ReleaseWorktreeResponse>(await release({ path: made.worktree.path, deleteBranch: true }));
    expect(res.ok).toBe(true);
    expect(res.branchDeleted).toBe(false);
    expect(res.branchError).toMatch(/not fully merged/);
    expect((await list()).branches.map((b) => b.name)).toContain('topic');
    // Released where it was: the branch's last commit stays checked out, with nothing to lose.
    expect(await slot(1)).toMatchObject({ free: true, detached: true, head: fx.git('rev-parse', 'topic').trim() });
    expect(existsSync(path.join(slotDir(1), 'more.txt'))).toBe(true);
  });

  it('takes the slot asked for: a free one is switched, a new number is made, and a base is read in the main worktree', async () => {
    topicSlot();
    // Slot 2 does not exist yet: made, and the free slot 1 stays free.
    const two = await json<CreateWorktreeResponse>(await create({ branch: 'agent/two', base: 'main', slot: 2 }));
    expect(two).toMatchObject({ slot: 2, reused: false, worktree: { path: await realpath(slotDir(2)), branch: 'agent/two' } });
    expect(await slot(1)).toMatchObject({ free: true });
    expect((await list()).newSlot).toEqual({ slot: 3, path: slotDir(3) });
    // Slot 1 sits at topic's tip; a branch from `HEAD` still starts where the main worktree is.
    const one = await json<CreateWorktreeResponse>(await create({ branch: 'agent/three', base: 'HEAD', slot: 1 }));
    expect(one).toMatchObject({ slot: 1, reused: true, worktree: { branch: 'agent/three', head: fx.git('rev-parse', 'main').trim() } });
    expect(await slot(1)).toMatchObject({ free: false, dirty: 0 });
    expect(await code(await create({ branch: 'agent/four', slot: 1 }))).toBe('slot_in_use');
    for (const bad of [0, -1, 1.5, '1']) expect(await code(await create({ branch: 'agent/four', slot: bad }))).toBe('invalid_slot');
    for (const made of [one, two]) {
      expect(await json<ReleaseWorktreeResponse>(await release({ path: made.worktree.path, deleteBranch: true }))).toMatchObject({
        ok: true,
        branchDeleted: true,
        backup: { reason: 'release' },
      });
    }
    // Unasked, the lowest free slot is taken.
    const five = await json<CreateWorktreeResponse>(await create({ branch: 'agent/five', base: 'main' }));
    expect(five).toMatchObject({ slot: 1, reused: true });
    expect(await json<ReleaseWorktreeResponse>(await release({ path: five.worktree.path, deleteBranch: true }))).toMatchObject({
      ok: true,
      branchDeleted: true,
      backup: { reason: 'release' },
    });
  });

  it('forgets the review state kept under a slot when a branch is checked out into it', async () => {
    freeSlot(1);
    const slotPath = (await slot(1))!.path;
    const state = await json<ReviewState>(await get('/api/state'));
    state.targets[`worktree:${slotPath}:base:main`] = { comments: [] };
    state.targets[`worktree:${slotPath}:local`] = { comments: [] };
    state.targets['base:main'] = { comments: [] };
    await writeFile(stateFile, JSON.stringify(state));
    const made = await json<CreateWorktreeResponse>(await create({ branch: 'agent/state', base: 'main', slot: 1 }));
    expect(made.reused).toBe(true);
    const keys = Object.keys((await json<ReviewState>(await get('/api/state'))).targets);
    expect(keys.filter((k) => k.startsWith(`worktree:${slotPath}:`))).toEqual([]);
    expect(keys).toContain('base:main');
    expect(await json<ReleaseWorktreeResponse>(await release({ path: made.worktree.path, deleteBranch: true }))).toMatchObject({
      ok: true,
      branchDeleted: true,
      backup: { reason: 'release' },
    });
  });

  it('starts a name no branch has from main when the request gives no base', async () => {
    const made = await json<CreateWorktreeResponse>(await create({ branch: 'agent/fresh' }));
    expect(made.worktree).toMatchObject({ branch: 'agent/fresh', head: fx.git('rev-parse', 'main').trim() });
    expect(await json<ReleaseWorktreeResponse>(await release({ path: made.worktree.path, deleteBranch: true }))).toMatchObject({
      ok: true,
      branchDeleted: true,
      backup: { reason: 'release' },
    });
  });

  it('checks out a branch only a remote has as a local branch tracking it, never from main', async () => {
    topicSlot();
    const tip = fx.git('rev-parse', 'topic').trim();
    fx.git('remote', 'add', 'origin', 'https://example.invalid/origin.git');
    fx.git('remote', 'add', 'upstream', 'https://example.invalid/upstream.git');
    for (const ref of ['origin/agent/remote', 'origin/agent/both', 'upstream/agent/both']) fx.git('update-ref', `refs/remotes/${ref}`, tip);
    // `refname:short` would list the branch as `heads/topic` once a tag has its name.
    fx.git('tag', 'topic', 'main');
    try {
      // The list stays local, however many branches the remotes carry; one name is looked up at a time.
      const branches = (await list()).branches;
      expect(branches.map((b) => b.name)).not.toContain('agent/remote');
      expect(branches.filter((b) => b.name.endsWith('topic')).map((b) => b.name)).toEqual(['topic']);
      const remotes = async (branch: string) => json<{ remotes: string[] }>(await get(`/api/worktrees/remotes?branch=${k(branch)}`));
      expect(await remotes('agent/remote')).toEqual({ remotes: ['origin/agent/remote'] });
      expect(await remotes('agent/both')).toEqual({ remotes: ['origin/agent/both', 'upstream/agent/both'] });
      expect(await remotes('agent/none')).toEqual({ remotes: [] });
      // A pattern would list every remote branch there is.
      expect(await code(await get(`/api/worktrees/remotes?branch=${k('agent/*')}`))).toBe('invalid_branch');

      // Either would put a second history under the name: a base of its own, or the remote's name as a new branch.
      expect(await code(await create({ branch: 'agent/remote', base: 'main' }))).toBe('branch_exists');
      expect(await code(await create({ branch: 'origin/agent/remote' }))).toBe('branch_exists');
      // Into a free slot the branch is made by `git branch --track`, before the switch.
      const made = await json<CreateWorktreeResponse>(await create({ branch: 'agent/remote' }));
      expect(made).toMatchObject({ slot: 1, reused: true, worktree: { branch: 'agent/remote', head: tip } });
      expect(fx.git('-C', made.worktree.path, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/agent/remote');

      // Two remotes have it: the base says which, and nothing else will do. Into a new slot, it is
      // `worktree add --track`.
      expect(await code(await create({ branch: 'agent/both', slot: 3 }))).toBe('ambiguous_branch');
      expect(await code(await create({ branch: 'agent/both', base: 'main', slot: 3 }))).toBe('ambiguous_branch');
      const both = await json<CreateWorktreeResponse>(await create({ branch: 'agent/both', base: 'upstream/agent/both', slot: 3 }));
      expect(both).toMatchObject({ slot: 3, reused: false, worktree: { branch: 'agent/both', head: tip } });
      expect(fx.git('-C', both.worktree.path, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('upstream/agent/both');
    } finally {
      for (const step of [
        () => fx.git('-C', slotDir(1), 'switch', '-q', '--detach'),
        () => fx.git('worktree', 'remove', '--force', slotDir(3)),
        () => fx.git('branch', '-D', 'agent/remote'),
        () => fx.git('branch', '-D', 'agent/both'),
      ]) {
        try {
          step();
        } catch {
          /* not made */
        }
      }
      fx.git('tag', '-d', 'topic');
      fx.git('remote', 'remove', 'origin');
      fx.git('remote', 'remove', 'upstream');
    }
  });

  it('refuses bad names and refs, and releases nothing but a slot', async () => {
    freeSlot(1);
    freeSlot(2);
    expect(await code(await create({ branch: 'x', base: 'nope' }))).toBe('unknown_ref');
    for (const branch of ['-b', 'bad..name', 'a b', 'x@{-1}', 'refs/heads/x', 'x.lock', '']) {
      expect(await code(await create({ branch, base: 'main' }))).toBe('invalid_branch');
    }
    expect(await code(await create({ branch: 'x', base: '--output=x' }))).toBe('invalid_ref');
    expect((await create({ base: 'main' })).status).toBe(400);
    expect(await code(await remove({ path: fx.root }))).toBe('main_worktree');
    expect(await code(await release({ path: fx.root }))).toBe('main_worktree');
    expect(await code(await remove({ path: '/nowhere' }))).toBe('unknown_worktree');
    expect(await code(await release({ path: '/nowhere' }))).toBe('unknown_worktree');
    // A checkout made by hand beside the repository is not a slot: detached and clean, it is still
    // not free, no number is skipped for it, and it goes by removal, never release.
    fx.git('worktree', 'add', '-q', '--detach', byHand());
    const hand = (await list()).worktrees.find((w) => path.basename(w.path) === path.basename(byHand()))!;
    expect(hand).toMatchObject({ free: false, detached: true, dirty: 0 });
    expect(hand.slot).toBeUndefined();
    expect((await list()).newSlot).toEqual({ slot: 3, path: slotDir(3) });
    expect(await code(await release({ path: hand.path }))).toBe('not_a_slot');
    expect(await json<RemoveWorktreeResponse>(await remove({ path: hand.path }))).toMatchObject({
      ok: true,
      branchDeleted: false,
      backup: { reason: 'remove' },
    });
    expect(existsSync(byHand())).toBe(false);
  });

  it('drops the entry of a slot whose directory is gone, branch included, and skips its number meanwhile', async () => {
    freeSlot(1);
    freeSlot(2);
    const made = await json<CreateWorktreeResponse>(await create({ branch: 'agent/gone', base: 'main', slot: 3 }));
    await rm(made.worktree.path, { recursive: true, force: true });
    // Not offered for review any more, but still listed here, and its branch is still taken.
    expect((await json<RepoInfo>(await get('/api/repo'))).worktrees.map((w) => w.path)).not.toContain(made.worktree.path);
    const res = await list();
    expect(res.worktrees.find((w) => w.path === made.worktree.path)).toMatchObject({ prunable: true, dirty: 0, slot: 3, free: false });
    expect(res.branches.find((b) => b.name === 'agent/gone')?.worktree).toBe(made.worktree.path);
    expect(res.newSlot).toEqual({ slot: 4, path: slotDir(4) });
    // Neither free nor makeable until the entry is cleared, and there is no directory to keep.
    expect(await code(await create({ branch: 'agent/again', slot: 3 }))).toBe('slot_gone');
    expect(await code(await release({ path: made.worktree.path }))).toBe('worktree_gone');
    expect(await json<RemoveWorktreeResponse>(await remove({ path: made.worktree.path, deleteBranch: true }))).toEqual({ ok: true, branchDeleted: true });
    const after = await list();
    expect(after.worktrees.map((w) => w.path)).not.toContain(made.worktree.path);
    expect(after.branches.map((b) => b.name)).not.toContain('agent/gone');
    expect(after.newSlot).toEqual({ slot: 3, path: slotDir(3) });
  });

  it('removes a free slot outright when asked, directory and all', async () => {
    freeSlot(1);
    freeSlot(2);
    const two = (await slot(2))!;
    expect(two).toMatchObject({ free: true });
    expect(await json<RemoveWorktreeResponse>(await remove({ path: two.path }))).toMatchObject({
      ok: true,
      branchDeleted: false,
      backup: { reason: 'remove' },
    });
    expect(existsSync(slotDir(2))).toBe(false);
    expect((await list()).newSlot).toEqual({ slot: 2, path: slotDir(2) });
  });

  it('refuses a mutating request the browser marks as cross-site', async () => {
    const headers = { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' };
    const res = await app.request('/api/worktrees/remove', { method: 'POST', headers, body: JSON.stringify({ path: fx.root }) });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('cross_site');
    expect((await app.request('/api/worktrees', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
    expect((await app.request('/api/worktrees', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  it('refuses a write whose Origin is another origin, for browsers that send no Sec-Fetch-Site', async () => {
    const headers = { 'content-type': 'application/json', origin: 'http://evil.example' };
    const res = await app.request('/api/worktrees/remove', { method: 'POST', headers, body: JSON.stringify({ path: fx.root }) });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('cross_site');
    expect(existsSync(fx.root)).toBe(true);
  });

  it('refuses any request, reads included, addressed to a name other than loopback', async () => {
    // DNS rebinding: the page is same-origin with the server, only Host gives it away.
    const res = await app.request('http://evil.example:4100/api/state', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('bad_host');
    expect((await app.request('http://evil.example:4100/')).status).toBe(403);
    expect((await app.request('http://127.0.0.1:4100/api/worktrees')).status).toBe(200);
    expect((await app.request('http://localhost:5173/api/worktrees')).status).toBe(200);
  });
});

describe('update notice', () => {
  it('answers null when no check was handed over', async () => {
    const res = await get('/api/update');
    expect(res.status).toBe(200);
    expect(await json<UpdateNotice | null>(res)).toBeNull();
  });

  it('relays what the check came back with', async () => {
    const repo = await resolveRepo(fx.root);
    const notice: UpdateNotice = { current: '0.11.1', latest: '0.12.0', command: 'npm i -g @xbghc/warden@latest' };
    const withUpdate = createApp({ repo, store: new StateStore(stateFile, repo.commonRoot), update: Promise.resolve(notice) });
    try {
      expect(await json<UpdateNotice | null>(await withUpdate.request('/api/update'))).toEqual(notice);
    } finally {
      await withUpdate.close();
    }
  });
});

describe('static + unknown routes', () => {
  it('unknown api routes return JSON 404', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: 'not_found' });
  });
});
