import os from 'node:os';
import path from 'node:path';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFixtureRepo, type FixtureRepo } from '../../../test/fixtures/make-repo.js';
import { applyToIndex, runGit, runGitSnapshot, runGitWrite } from './git.js';

let selected: FixtureRepo;
let unrelated: FixtureRepo;
let storage: string;

beforeEach(async () => {
  [selected, unrelated] = await Promise.all([makeFixtureRepo('warden-env-selected-'), makeFixtureRepo('warden-env-unrelated-')]);
  storage = await mkdtemp(path.join(os.tmpdir(), 'warden-env-storage-'));
  await unrelated.write('README.md', '# unrelated repository\n');
  unrelated.git('add', 'README.md');
  unrelated.git('commit', '-q', '-m', 'Unrelated history');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([selected?.cleanup(), unrelated?.cleanup(), storage && rm(storage, { recursive: true, force: true })]);
});

function inheritUnrelatedRepository(): void {
  const gitDir = path.join(unrelated.root, '.git');
  for (const [key, value] of Object.entries({
    GIT_DIR: gitDir,
    GIT_WORK_TREE: unrelated.root,
    GIT_COMMON_DIR: gitDir,
    GIT_INDEX_FILE: path.join(gitDir, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, 'objects'),
    GIT_SHALLOW_FILE: path.join(storage, 'missing-shallow'),
    GIT_CONFIG: path.join(gitDir, 'config'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: unrelated.root,
    GIT_CONFIG_PARAMETERS: 'invalid inherited configuration',
    GIT_PREFIX: 'unrelated-prefix/',
    GIT_NAMESPACE: 'unrelated-namespace',
  })) {
    vi.stubEnv(key, value);
  }
}

describe('Git repository environment isolation', () => {
  it('reads the selected HEAD, index and working tree despite inherited repository variables', async () => {
    await selected.write('README.md', '# staged in selected repository\n');
    selected.git('add', 'README.md');
    await selected.write('README.md', '# working in selected repository\n');
    inheritUnrelatedRepository();

    expect((await runGit(['show', 'HEAD:README.md'], { cwd: selected.root })).stdout).toBe('# fixture\n');
    expect((await runGit(['show', ':README.md'], { cwd: selected.root })).stdout).toBe('# staged in selected repository\n');
    expect((await runGit(['diff', '--', 'README.md'], { cwd: selected.root })).stdout).toContain('+# working in selected repository');
    expect((await runGit(['config', '--get', 'user.name'], { cwd: selected.root })).stdout.trim()).toBe('Fixture');
  });

  it.each([false, true])('writes only to the selected repository with detached execution = %s', async (network) => {
    const unrelatedHead = unrelated.git('rev-parse', 'HEAD');
    const unrelatedIndex = await readFile(path.join(unrelated.root, '.git', 'index'));
    await selected.write('selected-only.txt', 'A change in the selected repository.\n');
    inheritUnrelatedRepository();

    await runGitWrite(['add', '--', 'selected-only.txt'], { cwd: selected.root, network });
    await runGitWrite(['commit', '-m', 'Commit only selected changes'], { cwd: selected.root, network });

    expect(selected.git('show', 'HEAD:selected-only.txt')).toBe('A change in the selected repository.\n');
    expect(unrelated.git('rev-parse', 'HEAD')).toBe(unrelatedHead);
    expect(await readFile(path.join(unrelated.root, '.git', 'index'))).toEqual(unrelatedIndex);
    expect(unrelated.git('status', '--porcelain')).toBe('');
  });

  it('applies a staging patch only to the selected index', async () => {
    const unrelatedIndex = await readFile(path.join(unrelated.root, '.git', 'index'));
    await selected.write('README.md', '# selected patch\n');
    const patch = selected.git('diff', '--', 'README.md');
    inheritUnrelatedRepository();

    await applyToIndex(selected.root, patch);

    expect(selected.git('show', ':README.md')).toBe('# selected patch\n');
    expect(await readFile(path.join(unrelated.root, '.git', 'index'))).toEqual(unrelatedIndex);
    expect(await readFile(path.join(selected.root, 'README.md'), 'utf8')).toBe('# selected patch\n');
  });

  it('uses explicit snapshot storage without touching either real index or inherited alternate objects', async () => {
    const objects = path.join(storage, 'objects');
    const index = path.join(storage, 'index');
    await mkdir(objects);
    await copyFile(path.join(selected.root, '.git', 'index'), index);
    const selectedIndex = await readFile(path.join(selected.root, '.git', 'index'));
    const unrelatedIndex = await readFile(path.join(unrelated.root, '.git', 'index'));
    const blob = unrelated.git('rev-parse', 'HEAD:README.md').trim();
    const alternateObject = path.join(unrelated.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    await utimes(alternateObject, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    const alternateMtime = (await stat(alternateObject)).mtimeMs;
    await selected.write('README.md', '# unrelated repository\n');
    inheritUnrelatedRepository();

    await runGitSnapshot(['add', '--all'], { cwd: selected.root, objects, index });
    const tree = (await runGitSnapshot(['write-tree', '--missing-ok'], { cwd: selected.root, objects, index })).stdout.trim();
    const snapshot = { objects, index, alternates: path.join(selected.root, '.git', 'objects') };

    expect((await runGit(['show', `${tree}:README.md`], { cwd: selected.root, snapshot })).stdout).toBe('# unrelated repository\n');
    expect((await runGit(['show', ':README.md'], { cwd: selected.root, snapshot })).stdout).toBe('# unrelated repository\n');
    expect((await stat(path.join(objects, blob.slice(0, 2), blob.slice(2)))).isFile()).toBe(true);
    expect((await stat(alternateObject)).mtimeMs).toBe(alternateMtime);
    expect(await readFile(path.join(selected.root, '.git', 'index'))).toEqual(selectedIndex);
    expect(await readFile(path.join(unrelated.root, '.git', 'index'))).toEqual(unrelatedIndex);
  });

  it('preserves normal user configuration, author identity, hooks and signing requirements', async () => {
    const globalConfig = path.join(storage, 'user.gitconfig');
    const hooks = path.join(storage, 'hooks');
    await mkdir(hooks);
    const hook = path.join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf "hook ran\\n" > hook-result.txt\n');
    await chmod(hook, 0o755);
    selected.git('config', '--unset', 'user.name');
    selected.git('config', '--unset', 'user.email');
    selected.git('config', '--file', globalConfig, 'user.name', 'Configured Committer');
    selected.git('config', '--file', globalConfig, 'user.email', 'committer@example.com');
    selected.git('config', '--file', globalConfig, 'core.hooksPath', hooks.replaceAll('\\', '/'));
    inheritUnrelatedRepository();
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_AUTHOR_NAME', 'Environment Author');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'author@example.com');

    await runGitWrite(['commit', '--allow-empty', '-m', 'Keep normal commit behavior'], { cwd: selected.root });

    expect(selected.git('log', '-1', '--format=%an <%ae>')).toBe('Environment Author <author@example.com>\n');
    expect(selected.git('log', '-1', '--format=%cn <%ce>')).toBe('Configured Committer <committer@example.com>\n');
    expect(await readFile(path.join(selected.root, 'hook-result.txt'), 'utf8')).toBe('hook ran\n');

    const head = selected.git('rev-parse', 'HEAD');
    selected.git('config', '--file', globalConfig, 'commit.gpgsign', 'true');
    selected.git('config', '--file', globalConfig, 'gpg.program', path.join(storage, 'missing-signing-program'));
    await expect(runGitWrite(['commit', '--allow-empty', '-m', 'Must be signed'], { cwd: selected.root })).rejects.toMatchObject({ code: 'git_failed' });
    expect(selected.git('rev-parse', 'HEAD')).toBe(head);
  });
});
