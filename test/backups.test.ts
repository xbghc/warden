import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type { RemoveWorktreeResponse, SafetyBackup } from '@warden/shared';
import { createApp, resolveRepo, StateStore, WorkflowService } from '@warden/server';
import { HistoryService } from '../packages/server/src/history.js';
import { assertSafetyBackupCurrent, createSafetyBackup, discardOperationBackup, listSafetyBackups } from '../packages/server/src/backups.js';
import * as backups from '../packages/server/src/backups.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

let fx: FixtureRepo;
let data: string;
let slot: string;
let store: StateStore;
let app: Hono;
const send = (action: string, body: unknown) =>
  app.request(`/api/worktrees${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-backup-');
  data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'warden-backup-data-')));
  slot = `${fx.root}-1`;
  store = new StateStore(path.join(data, 'state.json'), fx.root);
  app = createApp({ repo: await resolveRepo(fx.root), store });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.copyFile).mockReset();
  await fs.rm(slot, { recursive: true, force: true });
  await fx.cleanup();
  await fs.rm(data, { recursive: true, force: true });
});

async function checkout(kind: 'clone' | 'worktree' = 'clone') {
  const response = await send('', { branch: 'agent/backup', base: 'main', kind });
  expect(response.status, await response.clone().text()).toBe(201);
}

/** Exercise the documented recovery into a fresh repository, with no live checkout pointers. */
async function recover(backup: SafetyBackup) {
  const destination = path.join(data, 'recovered');
  await fs.cp(path.join(backup.path, 'worktree'), destination, { recursive: true });
  fx.git('-C', destination, 'init', '-q', '--template=', ...(backup.head.length === 64 ? ['--object-format=sha256'] : []));
  const common = path.join(backup.path, 'git-common');
  const privateGit = existsSync(path.join(backup.path, 'git-worktree')) ? path.join(backup.path, 'git-worktree') : common;
  for (const name of ['objects', 'refs', 'logs', 'packed-refs', 'shallow']) {
    if (existsSync(path.join(common, name))) await fs.cp(path.join(common, name), path.join(destination, '.git', name), { recursive: true });
  }
  for (const name of ['HEAD', 'index']) await fs.copyFile(path.join(privateGit, name), path.join(destination, '.git', name));
  for (const name of await fs.readdir(privateGit)) {
    if (name.startsWith('sharedindex.')) await fs.copyFile(path.join(privateGit, name), path.join(destination, '.git', name));
  }
  return destination;
}

describe('verified safety backups', () => {
  it('recovers a deleted clone, staged and unstaged bytes, ignored files and older stashes without the original objects', async () => {
    await checkout();
    const git = (...args: string[]) => fx.git('-C', slot, ...args);
    for (const message of ['older stash', 'newer stash']) {
      await fs.writeFile(path.join(slot, 'src/a.ts'), `${message}\n`);
      git('stash', 'push', '-qm', message);
    }
    await fs.writeFile(path.join(slot, '.gitignore'), 'secret.env\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'Ignore local secrets');
    git('branch', 'unpublished');
    git('switch', '--detach');
    const originalHead = git('rev-parse', 'HEAD').trim();
    await fs.writeFile(path.join(slot, 'src/a.ts'), Buffer.from([0, 255, 1, 13, 10]));
    git('add', 'src/a.ts');
    await fs.writeFile(path.join(slot, 'src/a.ts'), Buffer.from([0, 254, 2, 13, 10]));
    await fs.writeFile(path.join(slot, 'secret.env'), 'irreplaceable local configuration\n');
    await fs.writeFile(path.join(slot, '中文 空格.txt'), 'untracked\n');
    git('rm', '-q', 'src/b.ts');
    const index = await fs.readFile(path.join(slot, '.git/index'));
    const staged = git('diff', '--cached', '--binary');
    const status = git('status', '--porcelain=v1', '--untracked-files=all');
    const stashes = git('stash', 'list');
    const response = await send('/remove', { path: slot, force: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const backup = ((await response.json()) as RemoveWorktreeResponse).backup!;
    expect(backup).toMatchObject({ head: originalHead, reason: 'remove' });
    expect(existsSync(slot)).toBe(false);
    const recovered = await recover(backup);
    // Deleting the original object store proves this is not a snapshot or hard-linked copy.
    const object = path.join(backup.path, 'git-common/objects', originalHead.slice(0, 2), originalHead.slice(2));
    expect((await fs.stat(object)).nlink).toBe(1);
    await fx.cleanup();
    // The fixture's original cwd no longer exists; execute via an existing directory.
    const { execFileSync } = await import('node:child_process');
    const check = (...args: string[]) => execFileSync('git', args, { cwd: recovered, encoding: 'utf8' });
    expect(check('rev-parse', 'HEAD').trim()).toBe(originalHead);
    expect(check('status', '--porcelain=v1', '--untracked-files=all')).toBe(status);
    expect(check('diff', '--cached', '--binary')).toBe(staged);
    expect(check('stash', 'list')).toBe(stashes);
    expect(await fs.readFile(path.join(backup.path, 'git-common/index'))).toEqual(index);
    expect(await fs.readFile(path.join(recovered, 'src/a.ts'))).toEqual(Buffer.from([0, 254, 2, 13, 10]));
    expect(await fs.readFile(path.join(recovered, 'secret.env'), 'utf8')).toContain('irreplaceable');
    expect(check('fsck', '--full')).not.toContain('missing');
  });

  it('backs up a linked worktree before forced release and exposes completed backups after restart', async () => {
    await checkout('worktree');
    await fs.writeFile(path.join(slot, 'new.txt'), 'staged\n');
    fx.git('-C', slot, 'add', 'new.txt');
    await fs.writeFile(path.join(slot, 'new.txt'), 'unstaged\n');
    const response = await send('/release', { path: slot, force: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const backup = ((await response.json()) as RemoveWorktreeResponse).backup!;
    expect(existsSync(path.join(backup.path, 'git-worktree/index'))).toBe(true);
    expect(existsSync(path.join(slot, 'new.txt'))).toBe(false);
    const restored = await recover(backup);
    expect(fx.git('-C', restored, 'show', ':new.txt')).toBe('staged\n');
    expect(await fs.readFile(path.join(restored, 'new.txt'), 'utf8')).toBe('unstaged\n');
    await fs.mkdir(path.join(data, 'backups', '.pending-interrupted'));
    const restarted = createApp({ repo: await resolveRepo(fx.root), store: new StateStore(store.file, fx.root) });
    expect(((await (await restarted.request('/api/backups')).json()) as { backups: SafetyBackup[] }).backups).toEqual([backup]);
  });

  it.each(['/release', '/remove'])('stops %s when backup storage cannot be written and preserves HEAD, index and files', async (operation) => {
    await checkout();
    await fs.writeFile(path.join(slot, 'local.txt'), 'must survive\n');
    const head = fx.git('-C', slot, 'rev-parse', 'HEAD');
    const index = await fs.readFile(path.join(slot, '.git/index'));
    await fs.writeFile(path.join(data, 'backups'), 'not a directory');
    const response = await send(operation, { path: slot, force: true });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('backup_failed');
    expect(fx.git('-C', slot, 'rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(path.join(slot, '.git/index'))).toEqual(index);
    expect(await fs.readFile(path.join(slot, 'local.txt'), 'utf8')).toBe('must survive\n');
  });

  it('rejects concurrent changes during copying and never publishes a partial backup', async () => {
    await fx.write('precious.txt', 'before\n');
    const copy = (await vi.importActual<typeof fs>('node:fs/promises')).copyFile;
    let changed = false;
    vi.mocked(fs.copyFile).mockImplementation(async (source, destination, flags) => {
      await copy(source, destination, flags);
      if (!changed && String(source).endsWith('precious.txt')) {
        changed = true;
        await fx.write('precious.txt', 'edited during backup\n');
      }
    });
    await expect(createSafetyBackup(store, fx.root, 'release')).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await listSafetyBackups(store)).toEqual([]);
    expect(await fs.readdir(path.join(data, 'backups'))).toEqual([]);
    expect(await fs.readFile(path.join(fx.root, 'precious.txt'), 'utf8')).toBe('edited during backup\n');
  });

  it('refuses nested repositories and backup destinations inside the source', async () => {
    await fs.mkdir(path.join(fx.root, 'nested/.git'), { recursive: true });
    await expect(createSafetyBackup(store, fx.root, 'remove')).rejects.toMatchObject({ code: 'backup_failed' });
    const nested = new StateStore(path.join(fx.root, 'data/state.json'), fx.root);
    await expect(createSafetyBackup(nested, fx.root, 'remove')).rejects.toMatchObject({ code: 'backup_failed' });
    expect(await listSafetyBackups(store)).toEqual([]);
  });

  it.each(['/release', '/remove'])('stops %s if an ignored file is edited after backup publication', async (operation) => {
    await checkout();
    await fs.writeFile(path.join(slot, '.git/info/exclude'), 'local.env\n');
    await fs.writeFile(path.join(slot, 'local.env'), 'old contents\n');
    const create = backups.createSafetyBackup;
    vi.spyOn(backups, 'createSafetyBackup').mockImplementationOnce(async (...args) => {
      const backup = await create(...args);
      await fs.writeFile(path.join(slot, 'local.env'), 'new contents after backup\n');
      return backup;
    });
    const response = await send(operation, { path: slot, force: true });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('backup_stale');
    expect(await fs.readFile(path.join(slot, 'local.env'), 'utf8')).toBe('new contents after backup\n');
    expect(fx.git('-C', slot, 'branch', '--show-current').trim()).toBe('agent/backup');
    expect(await listSafetyBackups(store)).toHaveLength(1);
  });

  it('detects an index changed after backup without changing HEAD or working files', async () => {
    await fx.write('src/a.ts', 'new staged bytes\n');
    const backup = await createSafetyBackup(store, fx.root, 'release');
    fx.git('add', 'src/a.ts');
    await expect(assertSafetyBackupCurrent(backup)).rejects.toMatchObject({ code: 'backup_stale' });
  });

  it('rejects a changed linked-worktree Git pointer even when its old metadata still exists', async () => {
    await checkout('worktree');
    const backup = await createSafetyBackup(store, slot, 'release');
    // Git marks this file hidden on Windows; opening it for truncation with 'w' is refused.
    const pointer = await fs.open(path.join(slot, '.git'), 'r+');
    try {
      await pointer.truncate(0);
      await pointer.writeFile(`gitdir: ${path.join(fx.root, '.git')}\n`);
    } finally {
      await pointer.close();
    }
    await expect(assertSafetyBackupCurrent(backup)).rejects.toMatchObject({ code: 'backup_stale' });
  });

  it('recovers SHA-256 repositories using their original object format', async () => {
    const source = path.join(data, 'sha256');
    await fs.mkdir(source);
    fx.git('-C', source, 'init', '-q', '--object-format=sha256');
    await fs.writeFile(path.join(source, 'content.txt'), 'sha256 content\n');
    fx.git('-C', source, 'add', '.');
    fx.git('-C', source, 'commit', '-qm', 'SHA-256 commit');
    const backup = await createSafetyBackup(store, source, 'remove');
    expect(backup.head).toHaveLength(64);
    const restored = await recover(backup);
    expect(fx.git('-C', restored, 'rev-parse', 'HEAD').trim()).toBe(backup.head);
    expect(fx.git('-C', restored, 'show', 'HEAD:content.txt')).toBe('sha256 content\n');
  });

  it.each([false, true])('requires a completed backup before history publication (storage failure: %s)', async (failure) => {
    const repo = await resolveRepo(fx.root);
    await new WorkflowService(repo, store).configure('main');
    const history = new HistoryService(repo, store);
    const original = await history.get();
    const last = original.commits.at(-1)!;
    const draft = await history.preview({ head: original.head, start: last.sha, commits: [{ sha: last.sha, message: 'Clarified message' }] });
    expect(draft.canApply).toBe(true);
    const index = await fs.readFile(path.join(fx.root, '.git/index'));
    const tree = fx.git('rev-parse', 'HEAD^{tree}');
    if (failure) {
      await fs.writeFile(path.join(data, 'backups'), 'not a directory');
      await expect(history.apply({ id: draft.id!, head: original.head })).rejects.toMatchObject({ code: 'backup_failed' });
      expect(fx.git('rev-parse', 'HEAD').trim()).toBe(original.head);
    } else {
      const verify = backups.assertSafetyBackupCurrent;
      const verification = vi.spyOn(backups, 'assertSafetyBackupCurrent').mockImplementation(async (backup) => {
        await verify(backup);
        expect(backup).toMatchObject({ reason: 'history', head: original.head });
        const restored = await recover(backup);
        expect(fx.git('-C', restored, 'rev-parse', 'HEAD').trim()).toBe(original.head);
        expect(fx.git('-C', restored, 'log', '-1', '--format=%s').trim()).toBe(last.message);
      });
      const published = await history.apply({ id: draft.id!, head: original.head });
      expect(published.head).toBe(draft.newHead);
      expect(verification).toHaveBeenCalledOnce();
      expect(await listSafetyBackups(store)).toEqual([]);
    }
    expect(await fs.readFile(path.join(fx.root, '.git/index'))).toEqual(index);
    expect(fx.git('rev-parse', 'HEAD^{tree}')).toBe(tree);
  });

  it('retires only a journaled temporary backup and permits cleanup retries', async () => {
    const retained = await createSafetyBackup(store, fx.root, 'remove');
    const temporary = await createSafetyBackup(store, fx.root, 'rebase');
    await expect(discardOperationBackup(store, retained)).rejects.toMatchObject({ code: 'backup_invalid' });
    await expect(discardOperationBackup(store, { ...temporary, path: fx.root })).rejects.toMatchObject({ code: 'backup_invalid' });
    expect(existsSync(path.join(fx.root, '.git'))).toBe(true);
    await discardOperationBackup(store, temporary);
    await discardOperationBackup(store, temporary);
    expect(await listSafetyBackups(store)).toEqual([retained]);
  });

  it.each(['worktree', 'clone'] as const)('preserves ignored files when reusing a %s slot for another branch', async (kind) => {
    await checkout(kind);
    const git = (...args: string[]) => fx.git('-C', slot, ...args);
    const original = git('rev-parse', 'HEAD').trim();
    git('switch', '-qc', 'agent/target');
    await fs.writeFile(path.join(slot, 'local.env'), 'tracked on target\n');
    git('add', 'local.env');
    git('commit', '-qm', 'Track target configuration');
    git('switch', '-q', '--detach', original);
    await fs.writeFile(path.resolve(slot, git('rev-parse', '--git-path', 'info/exclude').trim()), 'local.env\n');
    await fs.writeFile(path.join(slot, 'local.env'), 'irreplaceable ignored configuration\n');
    expect(git('status', '--porcelain').trim()).toBe('');
    const response = await send('', { branch: 'agent/target', slot: 1 });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(git('rev-parse', 'HEAD').trim()).toBe(original);
    expect(await fs.readFile(path.join(slot, 'local.env'), 'utf8')).toBe('irreplaceable ignored configuration\n');
  });
});
