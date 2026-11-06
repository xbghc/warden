import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../packages/engine/src/engine.js';
import { WardenError } from '../packages/engine/src/errors.js';
import { PreviewService } from '../packages/engine/src/preview.js';
import * as workspace from '../packages/engine/src/workspace.js';
import { makeFixtureRepo, type FixtureRepo } from './fixtures/make-repo.js';

let fx: FixtureRepo;
let data: string;
let engine: Engine;
const timeout = process.platform === 'win32' ? 90_000 : 30_000;

beforeEach(async () => {
  fx = await makeFixtureRepo('warden-preview-setup-');
  data = await mkdtemp(path.join(os.tmpdir(), 'warden-preview-setup-data-'));
  engine = await Engine.open(fx.root, path.join(data, 'state.json'));
  await engine.execute('workflow.configure', { branch: 'main' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

describe('preview setup ownership', () => {
  it('blocks retries and publication after uncertain cleanup until the recorded owner has exited', { timeout }, async () => {
    await engine.execute('config.save', { hooks: {}, previewSetup: 'printf setup' });
    const runner = vi
      .spyOn(workspace, 'runSetupCommand')
      .mockRejectedValueOnce(new WardenError(409, 'The setup process tree could not be stopped.', 'setup_cleanup_failed'));
    await expect(engine.execute('preview.connect', { connectedIds: [] })).rejects.toMatchObject({ code: 'setup_cleanup_failed' });
    const saved = (await engine.store.load()).connectionPreview!;
    expect(saved.setup).toMatchObject({ status: 'running', owner: { pid: process.pid, hostname: os.hostname() } });
    const previewHead = fx.git('-C', saved.worktree!, 'rev-parse', 'HEAD');
    const previewIndex = await readFile(path.resolve(saved.worktree!, fx.git('-C', saved.worktree!, 'rev-parse', '--git-path', 'index').trim()));
    await fx.write('README.md', 'Next primary version\n');

    await expect(engine.execute('preview.setup', undefined)).rejects.toMatchObject({ code: 'setup_running' });
    await expect(engine.execute('preview.connect', { connectedIds: [] })).rejects.toMatchObject({ code: 'setup_running' });
    const tick = new PreviewService(engine.repo, engine.store, 0);
    await tick.tick();
    expect(await engine.execute('preview.get', undefined)).toMatchObject({ syncStatus: 'error', message: expect.stringContaining('preview setup') });
    // Removing or changing configuration cannot abandon a still-owned setup process.
    await engine.execute('config.save', { hooks: {} });
    expect(await engine.execute('preview.refresh', undefined)).toMatchObject({ syncStatus: 'error', setup: { status: 'running' } });
    await engine.execute('config.save', { hooks: {}, previewSetup: 'printf recovered' });
    await engine.store.update((state) => {
      state.connectionPreview!.setup!.owner = { pid: process.pid, hostname: `other-${os.hostname()}` };
    });
    await expect(engine.execute('preview.setup', undefined)).rejects.toMatchObject({ code: 'setup_running' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(saved.worktree!, 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(fx.git('-C', saved.worktree!, 'rev-parse', 'HEAD')).toBe(previewHead);
    expect(await readFile(path.resolve(saved.worktree!, fx.git('-C', saved.worktree!, 'rev-parse', '--git-path', 'index').trim()))).toEqual(previewIndex);

    const owner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(owner, 'exit');
    await engine.store.update((state) => {
      state.connectionPreview!.setup!.owner = { pid: owner.pid!, hostname: os.hostname() };
    });
    const recovered = await engine.execute('preview.refresh', undefined);
    expect(recovered).toMatchObject({ syncStatus: 'synced', setup: { command: 'printf recovered', status: 'succeeded', output: 'recovered' } });
    expect(recovered.setup!.owner).toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(saved.worktree!, 'README.md'), 'utf8')).toBe('Next primary version\n');
  });

  it('retains interrupted setup recovery for legacy preview records without ownership metadata', { timeout }, async () => {
    const preview = await engine.execute('preview.connect', { connectedIds: [] });
    await engine.execute('config.save', { hooks: {}, previewSetup: 'printf legacy-recovered' });
    await engine.store.update((state) => {
      state.connectionPreview!.setup = { command: 'printf legacy-recovered', status: 'running' };
    });
    await fx.write('README.md', 'Recovered legacy preview\n');
    const runner = vi.spyOn(workspace, 'runSetupCommand');
    const recovered = await engine.execute('preview.refresh', undefined);
    expect(recovered).toMatchObject({ syncStatus: 'synced', setup: { status: 'succeeded', output: 'legacy-recovered' } });
    expect(recovered.setup!.owner).toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(preview.worktree!, 'README.md'), 'utf8')).toBe('Recovered legacy preview\n');
  });

  it('marks uncertain cleanup from an explicit setup retry stale while retaining its owner', { timeout }, async () => {
    await engine.execute('preview.connect', { connectedIds: [] });
    await engine.execute('config.save', { hooks: {}, previewSetup: 'printf setup' });
    vi.spyOn(workspace, 'runSetupCommand').mockRejectedValueOnce(new WardenError(409, 'The setup process tree could not be stopped.', 'setup_cleanup_failed'));
    await expect(engine.execute('preview.setup', undefined)).rejects.toMatchObject({ code: 'setup_cleanup_failed' });
    expect(await engine.execute('preview.get', undefined)).toMatchObject({
      syncStatus: 'error',
      message: 'The setup process tree could not be stopped.',
      setup: { status: 'running', owner: { pid: process.pid, hostname: os.hostname() } },
    });
  });
});
