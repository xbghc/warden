import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitEnvironment, runGit, runGitBuffer } from '../packages/engine/src/git.js';
import { readWorktreeState } from '../packages/engine/src/worktree-state.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

const fixtures: FixtureRepo[] = [];

async function fixture() {
  const repo = await makeFixtureRepo('warden-worktree-state-');
  fixtures.push(repo);
  return repo;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((repo) => repo.cleanup()));
});

describe('worktree state', () => {
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

  it.skipIf(process.platform === 'win32')('preserves raw status fingerprints for non-UTF-8 filenames', async ({ skip }) => {
    const fx = await fixture();
    try {
      await writeFile(Buffer.concat([Buffer.from(fx.root + path.sep), Buffer.from([0xff, 0xfe]), Buffer.from('.txt')]), 'raw filename\n');
    } catch (error) {
      // APFS rejects invalid UTF-8 before Git can observe the path. Parser fixtures still
      // cover these raw bytes on every platform; only this filesystem exercise is inapplicable.
      if (process.platform === 'darwin' && (error as NodeJS.ErrnoException).code === 'EILSEQ') skip('The filesystem rejects non-UTF-8 filenames.');
      throw error;
    }
    const state = await readWorktreeState(fx.root);
    const raw = execFileSync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--no-ahead-behind', '-z'], {
      cwd: fx.root,
      env: gitEnvironment({ GIT_OPTIONAL_LOCKS: '0' }),
    });
    expect(state.statusFingerprint).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(state.statusFingerprint).not.toBe(createHash('sha256').update(raw.toString('utf8')).digest('hex'));
    expect(state.dirtyCount).toBe(1);
  });

  it('reads linked worktrees and independent clones in their own checkout', async () => {
    const fx = await fixture();
    const parent = await mkdtemp(path.join(os.tmpdir(), 'warden-state-linked-'));
    const linked = path.join(parent, 'linked');
    const cloned = path.join(parent, 'cloned');
    try {
      fx.git('worktree', 'add', '-q', '-b', 'linked', linked);
      execFileSync('git', ['clone', '-q', '--no-local', fx.root, cloned], { env: gitEnvironment() });
      await writeFile(path.join(linked, 'linked.txt'), 'linked edit\n');
      await writeFile(path.join(cloned, 'cloned.txt'), 'clone edit\n');
      expect(await readWorktreeState(linked)).toMatchObject({ branch: 'linked', dirtyCount: 1, paths: ['linked.txt'] });
      expect(await readWorktreeState(cloned)).toMatchObject({ branch: 'main', dirtyCount: 1, paths: ['cloned.txt'] });
      expect((await readWorktreeState(fx.root)).dirtyCount).toBe(0);
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
    // A global ignore supplied only by this worker must affect its Git child process too.
    const global = path.join(fx.root, '.git', 'test-global-config');
    const excludes = path.join(fx.root, '.git', 'test-global-ignore');
    await fx.write('.git/test-global-ignore', 'only-global.txt\n');
    await fx.write('only-global.txt', 'ignored by this worker only\n');
    execFileSync('git', ['config', '--file', global, 'core.excludesFile', excludes], { env: gitEnvironment() });
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    expect((await runGit(['config', '--get', 'core.excludesFile'], { cwd: fx.root })).stdout.trim()).toBe(excludes);
    expect((await readWorktreeState(fx.root)).dirtyCount).toBe(0);
  });

  it('uses the calling worker PATH without falling back to the parent process PATH', async () => {
    const fx = await fixture();
    const emptyPath = path.join(fx.root, '.git', 'empty-path');
    await mkdir(emptyPath);
    vi.stubEnv('PATH', emptyPath);
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', '1');
    await expect(readWorktreeState(fx.root)).rejects.toMatchObject({ code: 'git_missing' });
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
    expect(state).toMatchObject({ branch: 'main', dirtyCount: 1, paths: ['src/a.ts'] });
    expect(await readFile(path.join(fx.root, '.git', 'index'))).toEqual(index);
    expect(await readFile(path.join(fx.root, 'src/a.ts'))).toEqual(content);
  });

  it('supports unborn branches and reports a deleted checkout as an input error', async () => {
    const fx = await fixture();
    const unborn = path.join(fx.root, 'unborn');
    await mkdir(unborn);
    execFileSync('git', ['init', '-q', '-b', 'unborn'], { cwd: unborn, env: gitEnvironment() });
    const state = await readWorktreeState(unborn);
    expect(state).toMatchObject({ branch: 'unborn', dirtyCount: 0 });
    expect(state.head).toBeUndefined();
    await expect(readWorktreeState(path.join(fx.root, 'missing'))).rejects.toMatchObject({ status: 400, code: 'unknown_worktree' });
    await expect(readWorktreeState(path.join(fx.root, 'src/a.ts'))).rejects.toMatchObject({ status: 400, code: 'unknown_worktree' });
  });

  it('retains Git failure diagnostics and distinguishes output limits from timeouts', async () => {
    const fx = await fixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'warden-state-not-repo-'));
    try {
      await expect(readWorktreeState(directory)).rejects.toMatchObject({
        code: 'git_failed',
        exitCode: 128,
        stderr: expect.stringContaining('not a git repository'),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await expect(runGitBuffer(['status', '--porcelain=v2', '--branch', '-z'], { cwd: fx.root, maxBuffer: 10 })).rejects.toMatchObject({
      code: 'git_failed',
      status: 500,
      message: expect.stringContaining('maxBuffer'),
    });
  });

  it.skipIf(process.platform === 'win32')('kills and reaps a timed-out Git child even when it ignores SIGTERM', async () => {
    const fx = await fixture();
    const bin = path.join(fx.root, '.git', 'test-bin');
    const pidFile = path.join(fx.root, '.git', 'test-git-pid');
    await mkdir(bin);
    await writeFile(path.join(bin, 'git'), '#!/bin/sh\necho $$ > "$WARDEN_TEST_GIT_PID"\necho stalled >&2\ntrap "" TERM\nexec sleep 30\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv('WARDEN_TEST_GIT_PID', pidFile);
    try {
      await expect(runGitBuffer(['status'], { cwd: fx.root, timeoutMs: 250 })).rejects.toMatchObject({
        code: 'git_timeout',
        status: 504,
        stderr: 'stalled\n',
      });
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The expected timeout path has already reaped the fixture child.
        }
      }
    }
  });
});
