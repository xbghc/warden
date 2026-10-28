import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { snapshotObjects, snapshotStore, snapshotWorktree } from '../packages/engine/src/snapshots.js';
import { runGit } from '../packages/engine/src/git.js';
import { makeFixtureRepo } from './fixtures/make-repo.js';

const indexFormats = (['sha1', 'sha256'] as const).flatMap((objectFormat) => [2, 3, 4].map((version) => ({ objectFormat, version })));

it.each(indexFormats)('keeps $objectFormat v$version split-index files and timestamps untouched', async ({ objectFormat, version }) => {
  const fx = await makeFixtureRepo('warden-snapshot-split-', { objectFormat });
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-split-data-'));
  const linked = `${fx.root}-linked`;
  try {
    const cwd = version === 4 ? linked : fx.root;
    if (cwd === linked) fx.git('worktree', 'add', '--detach', linked);
    const gitAt = (...args: string[]) => fx.git('-C', cwd, ...args);
    const write = (name: string, content: string) => writeFile(path.join(cwd, name), content);
    await write('.gitignore', '*.local\n');
    await write('tracked.local', 'tracked despite ignore rule\n');
    gitAt('add', '.gitignore');
    gitAt('add', '-f', 'tracked.local');
    gitAt('commit', '-qm', 'Keep tracked local configuration');
    gitAt('config', 'core.splitIndex', 'true');
    gitAt('update-index', '--split-index');
    await write('src/a.ts', 'staged\n');
    const longName = `${'long'.repeat(40)}.txt`;
    await write(longName, 'long staged filename\n');
    gitAt('add', 'src/a.ts', longName);
    if (version === 3) gitAt('update-index', '--skip-worktree', 'src/b.ts');
    gitAt('update-index', `--index-version=${version}`);
    await write('src/a.ts', 'working\n');
    await write('tracked.local', 'updated tracked content\n');
    await write('ignored.local', 'do not capture\n');
    await write('new.txt', 'untracked\n');
    await write('new2.txt', 'another untracked\n');
    const git = gitAt('rev-parse', '--absolute-git-dir').trim();
    const names = (await readdir(git)).filter((name) => name === 'index' || name.startsWith('sharedindex.')).sort();
    for (const name of names) await utimes(path.join(git, name), new Date('2000-01-01'), new Date('2000-01-01'));
    const inventory = () => Promise.all(names.map(async (name) => [name, await readFile(path.join(git, name)), (await stat(path.join(git, name))).mtimeMs]));
    const before = await inventory();
    const store = snapshotStore(path.join(data, 'state.json'));
    const tree = await snapshotWorktree(cwd, store);
    const snapshot = await snapshotObjects(cwd, store);
    const read = (name: string) => runGit(['show', `${tree}:${name}`], { cwd, snapshot });
    expect((await read('src/a.ts')).stdout).toBe('working\n');
    expect((await read('new.txt')).stdout).toBe('untracked\n');
    expect((await read('tracked.local')).stdout).toBe('updated tracked content\n');
    expect((await read(longName)).stdout).toBe('long staged filename\n');
    await expect(read('ignored.local')).rejects.toMatchObject({ code: 'git_failed' });
    expect(await snapshotWorktree(cwd, store)).toBe(tree);
    expect(await inventory()).toEqual(before);
    expect((await readdir(git)).filter((name) => name === 'index' || name.startsWith('sharedindex.')).sort()).toEqual(names);
    expect(await readdir(path.join(store, 'tmp'))).toEqual([]);
  } finally {
    await rm(linked, { recursive: true, force: true });
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

it('does not invoke index hooks or create shared indexes while capturing ordinary indexes', async () => {
  const fx = await makeFixtureRepo('warden-snapshot-hooks-');
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-hook-data-'));
  try {
    const hooks = path.join(data, 'hooks');
    await mkdir(hooks);
    const hook = path.join(hooks, 'post-index-change');
    await writeFile(hook, '#!/bin/sh\nprintf "unexpected snapshot hook\\n" > snapshot-hook.txt\n');
    await chmod(hook, 0o755);
    fx.git('config', 'core.hooksPath', hooks.replaceAll('\\', '/'));
    fx.git('config', 'core.splitIndex', 'true');
    await fx.write('new.txt', 'saved content\n');
    const index = await readFile(path.join(fx.root, '.git', 'index'));
    const store = snapshotStore(path.join(data, 'state.json'));
    await snapshotWorktree(fx.root, store);
    await expect(readFile(path.join(fx.root, 'snapshot-hook.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(fx.root, '.git', 'index'))).toEqual(index);
    expect((await readdir(path.join(fx.root, '.git'))).filter((name) => name.startsWith('sharedindex.'))).toEqual([]);
    fx.git('add', 'new.txt');
    expect(await readFile(path.join(fx.root, 'snapshot-hook.txt'), 'utf8')).toContain('unexpected snapshot hook');
  } finally {
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

it('captures saved tracked and untracked content externally without changing the real index or refs', async () => {
  const fx = await makeFixtureRepo('warden-snapshot-');
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-data-'));
  try {
    await fx.write('src/a.ts', 'first\n');
    fx.git('add', 'src/a.ts');
    await fx.write('src/a.ts', 'other\n');
    await fx.write('new.txt', 'untracked\n');
    const index = await readFile(path.join(fx.root, '.git/index'));
    const refs = fx.git('show-ref');
    const store = snapshotStore(path.join(data, 'state.json'));
    const tree = await snapshotWorktree(fx.root, store);
    const snapshot = await snapshotObjects(fx.root, store);
    const read = (file: string) => runGit(['show', `${tree}:${file}`], { cwd: fx.root, snapshot });
    expect((await read('src/a.ts')).stdout).toBe('other\n');
    expect((await read('new.txt')).stdout).toBe('untracked\n');
    expect(await snapshotWorktree(fx.root, store)).toBe(tree);
    expect(await readFile(path.join(fx.root, '.git/index'))).toEqual(index);
    expect(fx.git('show-ref')).toBe(refs);
    expect(() => fx.git('cat-file', '-e', tree)).toThrow();
  } finally {
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});
