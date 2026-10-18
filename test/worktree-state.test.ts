import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitEnvironment, runGit } from '../packages/server/src/git.js';
import { loadNativeBinding } from '../packages/server/src/native.js';
import { readWorktreeState, readWorktreeStateWithGit } from '../packages/server/src/worktree-state.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

const fixtures: FixtureRepo[] = [];

async function fixture() {
  const repo = await makeFixtureRepo('warden-native-state-');
  fixtures.push(repo);
  return repo;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((repo) => repo.cleanup()));
});

describe('worktree state backends', () => {
  it('loads the native module when native execution is required', () => {
    if (process.env.WARDEN_NATIVE === 'required') expect(loadNativeBinding()).not.toBeNull();
  });

  it('matches Git for partial staging, renames, ignored files and literal filenames without changing the index', async () => {
    const fx = await fixture();
    await fx.write('src/a.ts', 'a staged edit\n');
    fx.git('add', 'src/a.ts');
    await fx.write('src/a.ts', 'another unstaged edit\n');
    const renamed = process.platform === 'win32' ? 'renamed 中文 file.ts' : 'renamed 中文\nfile.ts';
    fx.git('mv', 'src/b.ts', renamed);
    await fx.write('new directory/[literal] 中文.txt', 'untracked\n');
    await fx.write('.gitignore', 'ignored/\n');
    await fx.write('ignored/hidden.txt', 'ignored\n');
    const index = path.join(fx.root, '.git', 'index');
    const before = await readFile(index);
    const beforeStat = await stat(index);
    const actual = await readWorktreeState(fx.root);
    expect(actual).toEqual(await readWorktreeStateWithGit(fx.root));
    expect(actual).toMatchObject({ head: fx.git('rev-parse', 'HEAD').trim(), branch: 'main', dirtyCount: 4 });
    expect(actual.paths).toEqual(expect.arrayContaining(['src/a.ts', renamed, 'src/b.ts', 'new directory/[literal] 中文.txt', '.gitignore']));
    expect(actual.paths.some((name) => name.startsWith('ignored/'))).toBe(false);
    expect(await readFile(index)).toEqual(before);
    expect((await stat(index)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await stat(path.join(fx.root, '.git', 'index.lock')).catch(() => undefined)).toBeUndefined();
  });

  it('observes external edits, commits and branch switches on every call', async () => {
    const fx = await fixture();
    const clean = await readWorktreeState(fx.root);
    await fx.write('fresh.txt', 'not cached\n');
    expect((await readWorktreeState(fx.root)).dirtyCount).toBe(1);
    fx.git('add', '.');
    fx.git('commit', '-qm', 'External commit');
    fx.git('checkout', '-qb', 'external');
    const next = await readWorktreeState(fx.root);
    expect(next.dirtyCount).toBe(0);
    expect(next.head).not.toBe(clean.head);
    expect(next.branch).toBe('external');
    fx.git('checkout', '-q', '--detach');
    const detached = await readWorktreeState(fx.root);
    expect(detached.head).toBe(next.head);
    expect(detached.branch).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('preserves raw status fingerprints for non-UTF-8 filenames', async () => {
    const fx = await fixture();
    await writeFile(Buffer.concat([Buffer.from(fx.root + path.sep), Buffer.from([0xff, 0xfe]), Buffer.from('.txt')]), 'raw filename\n');
    expect(await readWorktreeState(fx.root)).toEqual(await readWorktreeStateWithGit(fx.root));
    expect((await readWorktreeState(fx.root)).dirtyCount).toBe(1);
  });

  it('reads linked worktrees and independent clones in their own checkout', async () => {
    const fx = await fixture();
    const parent = await mkdtemp(path.join(os.tmpdir(), 'warden-native-linked-'));
    const linked = path.join(parent, 'linked');
    const cloned = path.join(parent, 'cloned');
    try {
      fx.git('worktree', 'add', '-q', '-b', 'linked', linked);
      execFileSync('git', ['clone', '-q', '--no-local', fx.root, cloned], { env: gitEnvironment() });
      expect(await readWorktreeState(linked)).toEqual(await readWorktreeStateWithGit(linked));
      expect((await readWorktreeState(linked)).branch).toBe('linked');
      expect(await readWorktreeState(cloned)).toEqual(await readWorktreeStateWithGit(cloned));
      expect((await readWorktreeState(cloned)).branch).toBe('main');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('passes the calling Node worker environment and rejects inherited repository redirection', async () => {
    const fx = await fixture();
    const foreign = await fixture();
    await foreign.write('foreign.txt', 'must not observe this checkout\n');
    vi.stubEnv('GIT_DIR', path.join(foreign.root, '.git'));
    vi.stubEnv('GIT_WORK_TREE', foreign.root);
    vi.stubEnv('GIT_INDEX_FILE', path.join(foreign.root, '.git', 'index'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    expect((await readWorktreeState(fx.root)).dirtyCount).toBe(0);
    // A global ignore supplied only by this worker must affect the native Git process too.
    const global = path.join(fx.root, '.git', 'test-global-config');
    const excludes = path.join(fx.root, '.git', 'test-global-ignore');
    await fx.write('.git/test-global-ignore', 'only-global.txt\n');
    await fx.write('only-global.txt', 'ignored by this worker only\n');
    execFileSync('git', ['config', '--file', global, 'core.excludesFile', excludes], { env: gitEnvironment() });
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    expect((await runGit(['config', '--get', 'core.excludesFile'], { cwd: fx.root })).stdout.trim()).toBe(excludes);
    expect(await readWorktreeState(fx.root)).toEqual(await readWorktreeStateWithGit(fx.root));
    expect((await readWorktreeState(fx.root)).dirtyCount).toBe(0);
  });

  it('uses the calling worker PATH without falling back to the parent process PATH', async () => {
    const fx = await fixture();
    const emptyPath = path.join(fx.root, '.git', 'empty-path');
    await mkdir(emptyPath);
    vi.stubEnv('PATH', emptyPath);
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', '1');
    await expect(readWorktreeState(fx.root)).rejects.toMatchObject({ code: 'git_missing' });
    await expect(readWorktreeStateWithGit(fx.root)).rejects.toMatchObject({ code: 'git_missing' });
  });

  it('reports an unresolved merge without changing its index or conflict files', async () => {
    const fx = await fixture();
    fx.git('checkout', '-qb', 'other');
    await fx.write('src/a.ts', 'the other branch\n');
    fx.git('commit', '-qam', 'Other side');
    fx.git('checkout', '-q', 'main');
    await fx.write('src/a.ts', 'the main branch\n');
    fx.git('commit', '-qam', 'Main side');
    expect(() => fx.git('merge', '--no-edit', 'other')).toThrow();
    const index = await readFile(path.join(fx.root, '.git', 'index'));
    const content = await readFile(path.join(fx.root, 'src/a.ts'));
    const state = await readWorktreeState(fx.root);
    expect(state).toEqual(await readWorktreeStateWithGit(fx.root));
    expect(state).toMatchObject({ branch: 'main', dirtyCount: 1, paths: ['src/a.ts'] });
    expect(await readFile(path.join(fx.root, '.git', 'index'))).toEqual(index);
    expect(await readFile(path.join(fx.root, 'src/a.ts'))).toEqual(content);
  });

  it('supports unborn branches and reports a deleted checkout as an input error', async () => {
    const fx = await fixture();
    const unborn = path.join(fx.root, 'unborn');
    await mkdir(unborn);
    execFileSync('git', ['init', '-q', '-b', 'unborn'], { cwd: unborn, env: gitEnvironment() });
    expect(await readWorktreeState(unborn)).toEqual(await readWorktreeStateWithGit(unborn));
    expect(await readWorktreeState(unborn)).toMatchObject({ branch: 'unborn', dirtyCount: 0 });
    await expect(readWorktreeState(path.join(fx.root, 'missing'))).rejects.toMatchObject({ status: 400, code: 'unknown_worktree' });
  });
});
