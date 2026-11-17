import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { Engine } from '@warden/engine';
import { assertSetupIdle, setupOwner } from '../packages/engine/src/workspace.js';
import { makeFixtureRepo } from './fixtures/make-repo.js';

// The identifiers keep `preview`; every message the user reads names the work folder.
it('names the work folder in engine messages', async () => {
  const fx = await makeFixtureRepo();
  const data = await mkdtemp(path.join(os.tmpdir(), 'warden-copy-'));
  const engine = await Engine.open(fx.root, path.join(data, 'state.json'));
  try {
    await expect(engine.execute('config.save', { hooks: {}, previewSetup: 5 as unknown as string })).rejects.toThrow(
      'The work folder setup script must be a shell command string.',
    );
    await expect(engine.execute('preview.connect', { connectedIds: 'task' as unknown as string[] })).rejects.toThrow('Invalid work folder connection list.');
    expect(() => assertSetupIdle({ status: 'running', owner: setupOwner() }, 'preview')).toThrow(/^The work folder setup script is still running/);
    expect(() => assertSetupIdle({ status: 'running', owner: setupOwner() })).toThrow(/^The workspace setup script is still running/);
  } finally {
    await engine.close();
    await fx.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});
