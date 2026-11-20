import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { snapshotObjects, snapshotStore, snapshotWorktree } from '../packages/engine/src/snapshots.js';
import { runGit } from '../packages/engine/src/git.js';
import * as git from '../packages/engine/src/git.js';
import { makeFixtureRepo } from './fixtures/make-repo.js';

const lineEndingCases = (['input', 'true', 'attributes'] as const).flatMap((normalization) =>
  (['sha1', 'sha256'] as const).flatMap((objectFormat) => [false, true].map((packed) => ({ normalization, objectFormat, packed }))),
);

it.each(lineEndingCases)('preserves indexed CRLF with $normalization, $objectFormat and packed=$packed', async ({ normalization, objectFormat, packed }) => {
  const fx = await makeFixtureRepo('warden-snapshot-crlf-', { objectFormat });
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-crlf-data-'));
  try {
    fx.git('config', 'core.autocrlf', 'false');
    await fx.write('gradlew.bat', '@echo off\r\necho Original\r\n');
    fx.git('add', 'gradlew.bat');
    fx.git('commit', '-qm', 'Keep a CRLF wrapper');
    if (normalization === 'attributes') {
      await fx.write('.gitattributes', '* text=auto\n');
      fx.git('add', '.gitattributes');
      fx.git('commit', '-qm', 'Normalize new text');
    } else fx.git('config', 'core.autocrlf', normalization);
    if (packed) {
      fx.git('repack', '-ad');
      fx.git('prune-packed');
    }
    const index = path.join(fx.root, '.git', 'index');
    // Force content checks even when checkout and index timestamps share a filesystem tick.
    await utimes(index, new Date('2000-01-01'), new Date('2000-01-01'));
    const objects = path.join(fx.root, '.git', 'objects');
    const objectFiles = (await readdir(objects, { recursive: true })).sort();
    for (const file of objectFiles) {
      const location = path.join(objects, file);
      if ((await stat(location)).isFile()) await utimes(location, new Date('2000-01-01'), new Date('2000-01-01'));
    }
    const inventory = async () =>
      Promise.all(
        (await readdir(objects, { recursive: true })).sort().map(async (file) => {
          const location = path.join(objects, file);
          const info = await stat(location);
          return info.isFile() ? [file, await readFile(location), info.mtimeMs] : [file];
        }),
      );
    const before = await inventory();
    const originalIndex = await readFile(index);
    const store = snapshotStore(path.join(data, 'state.json'));
    const snapshot = await snapshotObjects(fx.root, store);
    expect(await snapshotWorktree(fx.root, store)).toBe(fx.git('rev-parse', 'HEAD^{tree}').trim());

    await fx.write('gradlew.bat', '@echo off\r\necho Edited\r\n');
    await fx.write('new.txt', 'New text\r\n');
    const tree = await snapshotWorktree(fx.root, store);
    expect((await runGit(['show', `${tree}:gradlew.bat`, '--'], { cwd: fx.root, snapshot })).stdout).toBe('@echo off\r\necho Edited\r\n');
    expect((await runGit(['show', `${tree}:new.txt`, '--'], { cwd: fx.root, snapshot })).stdout).toBe('New text\n');
    expect(await snapshotWorktree(fx.root, store)).toBe(tree);
    expect(await readFile(path.join(fx.root, 'gradlew.bat'), 'utf8')).toBe('@echo off\r\necho Edited\r\n');
    expect(await readFile(index)).toEqual(originalIndex);
    expect((await stat(index)).mtimeMs).toBe(new Date('2000-01-01').getTime());
    expect(await inventory()).toEqual(before);
  } finally {
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

const indexFormats = (['sha1', 'sha256'] as const).flatMap((objectFormat) => [2, 3, 4].map((version) => ({ objectFormat, version })));

it('uses staged CRLF blobs and indexed attributes when the attribute file is absent', async () => {
  const fx = await makeFixtureRepo('warden-snapshot-indexed-eol-');
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-indexed-eol-data-'));
  try {
    fx.git('config', 'core.autocrlf', 'false');
    await fx.write('gradlew.bat', 'Committed LF\n');
    await fx.write('.gitattributes', '*.txt -text\n');
    fx.git('add', '.');
    fx.git('commit', '-qm', 'Record attributes and an LF wrapper');
    await fx.write('gradlew.bat', 'Staged CRLF\r\n');
    fx.git('add', 'gradlew.bat');
    fx.git('config', 'core.autocrlf', 'input');
    await fx.write('gradlew.bat', 'Working CRLF\r\n');
    await fx.write('new.txt', 'Preserve CRLF through attributes\r\n');
    fx.git('update-index', '--skip-worktree', '.gitattributes');
    await rm(path.join(fx.root, '.gitattributes'));
    const index = await readFile(path.join(fx.root, '.git', 'index'));
    const store = snapshotStore(path.join(data, 'state.json'));
    const tree = await snapshotWorktree(fx.root, store);
    const snapshot = await snapshotObjects(fx.root, store);
    expect((await runGit(['show', `${tree}:gradlew.bat`, '--'], { cwd: fx.root, snapshot })).stdout).toBe('Working CRLF\r\n');
    expect((await runGit(['show', `${tree}:new.txt`, '--'], { cwd: fx.root, snapshot })).stdout).toBe('Preserve CRLF through attributes\r\n');
    expect(await readFile(path.join(fx.root, '.git', 'index'))).toEqual(index);
    fx.git('add', '--all');
    expect(tree).toBe(fx.git('write-tree').trim());
  } finally {
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

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
    const longName = `${'long'.repeat(process.platform === 'win32' ? 40 : 55)}.txt`;
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
    const read = (name: string) => runGit(['show', `${tree}:${name}`, '--'], { cwd, snapshot });
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
    const read = (file: string) => runGit(['show', `${tree}:${file}`, '--'], { cwd: fx.root, snapshot });
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

it('locates the objects and the index of a checkout in one Git read per snapshot', async () => {
  const fx = await makeFixtureRepo('warden-snapshot-reads-');
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-reads-data-'));
  const linked = `${fx.root}-linked`;
  try {
    fx.git('worktree', 'add', '-q', '-b', 'linked', linked);
    const store = snapshotStore(path.join(data, 'state.json'));
    // A linked worktree keeps its index privately and its objects in the main repository.
    for (const cwd of [fx.root, linked]) {
      await writeFile(path.join(cwd, 'saved.txt'), `Saved in ${path.basename(cwd)}\n`);
      const reads = vi.spyOn(git, 'runGit');
      const tree = await snapshotWorktree(cwd, store);
      const located = reads.mock.calls.filter(([args]) => args[0] === 'rev-parse');
      reads.mockRestore();
      expect(located.map(([args, options]) => [args.join(' '), options.cwd])).toEqual([
        ['rev-parse --git-path objects --git-path index --show-object-format', cwd],
      ]);
      const snapshot = await snapshotObjects(cwd, store);
      expect((await runGit(['show', `${tree}:saved.txt`, '--'], { cwd, snapshot })).stdout).toBe(`Saved in ${path.basename(cwd)}\n`);
      expect((await runGit(['show', `${tree}:README.md`, '--'], { cwd, snapshot })).stdout).toBe(fx.git('show', 'HEAD:README.md'));
      expect(fx.git('-C', cwd, 'status', '--porcelain').trim()).toBe('?? saved.txt');
    }
  } finally {
    vi.restoreAllMocks();
    await rm(linked, { recursive: true, force: true });
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

it('names a nested repository without commits instead of passing on a bare Git refusal', async () => {
  const fx = await makeFixtureRepo('warden-snapshot-nested-');
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-snapshot-nested-data-'));
  try {
    const store = snapshotStore(path.join(data, 'state.json'));
    await fx.write('vendor/lib/a.txt', 'a\n');
    fx.git('-C', path.join(fx.root, 'vendor/lib'), 'init', '-q');
    // Git cannot record a repository that has no commit, so no tree can stand for this folder.
    await expect(snapshotWorktree(fx.root, store)).rejects.toMatchObject({
      code: 'nested_repository_empty',
      message: expect.stringContaining(`${path.join(fx.root, 'vendor/lib')} is a Git repository without commits`),
    });
    // Once it has a commit Git records it as a link, as `git add` does.
    fx.git('-C', path.join(fx.root, 'vendor/lib'), 'add', '.');
    fx.git('-C', path.join(fx.root, 'vendor/lib'), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Start');
    const tree = await snapshotWorktree(fx.root, store);
    const snapshot = await snapshotObjects(fx.root, store);
    expect((await runGit(['ls-tree', tree, 'vendor/'], { cwd: fx.root, snapshot })).stdout).toMatch(/^160000 commit /);
  } finally {
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});
