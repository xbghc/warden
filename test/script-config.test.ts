import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { Engine } from '@warden/engine';
import { makeFixtureRepo } from './fixtures/make-repo.js';

it('rejects a concurrent script save from another window without overwriting the saved configuration', async () => {
  const fixture = await makeFixtureRepo('warden-script-config-');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'warden-script-config-state-'));
  const file = path.join(directory, 'state.json');
  const first = await Engine.open(fixture.root, file);
  const second = await Engine.open(fixture.root, file);
  try {
    const expected = { hooks: {}, previewSetup: '' };
    const results = await Promise.allSettled([
      first.execute('config.save', { hooks: { create: 'echo first' }, expected }),
      second.execute('config.save', { hooks: {}, previewSetup: 'echo second', expected }),
    ]);
    const saved = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    expect(saved).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'config_changed', status: 409 });
    const current = (await first.execute('workflow.get', undefined)).workspaceConfig!;
    expect(current).toEqual(saved[0]!.value);
    const merged = { hooks: { create: 'echo first' }, previewSetup: 'echo second' };
    await second.execute('config.save', { ...merged, expected: current });
    expect((await first.execute('workflow.get', undefined)).workspaceConfig).toEqual(merged);
    await first.execute('config.save', { hooks: {} });
    expect((await second.execute('workflow.get', undefined)).workspaceConfig?.hooks).toEqual({});
  } finally {
    await Promise.all([first.close(), second.close()]);
    await fixture.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
