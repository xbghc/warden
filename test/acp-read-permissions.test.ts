import os from 'node:os';
import path from 'node:path';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { approveRepositoryRead, repositoryReadRequest } from '../packages/vscode/src/acp/read-permissions.js';

let directory: string;
let root: string;
let file: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warden-read-permissions-')));
  root = path.join(directory, 'task');
  await mkdir(root);
  file = path.join(root, 'source.ts');
  await writeFile(file, 'source\n');
});
afterEach(() => rm(directory, { recursive: true, force: true }));

function request(): RequestPermissionRequest {
  return {
    sessionId: 'task',
    toolCall: { toolCallId: 'read', kind: 'read', locations: [{ path: file }], rawInput: { file_path: 'source.ts', limit: 100 } },
    options: [{ optionId: 'one', name: 'Read', kind: 'allow_once' }],
  };
}
const roots = () => Promise.resolve([{ path: root, identity: 'allocation' }]);
const approve = (paths: string[], validate = async () => {}) => approveRepositoryRead(paths, roots, validate);

describe('ACP automatic read permissions', () => {
  it('uses structured operation and exact option IDs instead of human-readable labels', () => {
    expect(repositoryReadRequest(request(), root)).toEqual({ paths: [file], optionId: 'one' });
    const changed = request();
    changed.toolCall.title = 'Run anything';
    changed.options[0]!.name = 'An agent-provided label';
    expect(repositoryReadRequest(changed, root)?.optionId).toBe('one');
  });

  it('keeps a request with terminal output manual even when its kind says read', () => {
    const changed = request();
    delete changed.toolCall.rawInput;
    expect(repositoryReadRequest(changed, root)?.optionId).toBe('one');
    changed.toolCall.content = [{ type: 'terminal', terminalId: 'shell' }];
    expect(repositoryReadRequest(changed, root)).toBeUndefined();
  });

  it.each(['.envrc', '.env', '.env.local', 'production.env'])('keeps the environment file %s manual', async (name) => {
    const secret = path.join(root, name);
    await writeFile(secret, 'TOKEN=1\n');
    expect(await approve([secret])).toBe(false);
    expect(await approve([file])).toBe(true);
  });

  it.each(['execute', 'edit', 'delete', 'search', 'other'] as const)('keeps %s requests manual even when labeled as reads', (kind) => {
    const changed = request();
    changed.toolCall.kind = kind;
    changed.toolCall.title = 'Read source';
    expect(repositoryReadRequest(changed, root)).toBeUndefined();
  });

  it('rejects missing, relative, conflicting and ambiguous request metadata', () => {
    const edits: ((value: RequestPermissionRequest) => void)[] = [
      (value) => {
        value.toolCall.locations = [];
      },
      (value) => {
        value.toolCall.locations = [{ path: 'source.ts' }];
      },
      (value) => {
        value.toolCall.rawInput = { path: path.join(root, 'other.ts') };
      },
      (value) => {
        value.toolCall.rawInput = { command: 'cat source.ts' };
      },
      (value) => {
        value.toolCall.rawInput = { path: file, recursive: true };
      },
      (value) => {
        value.toolCall.rawInput = JSON.stringify({ path: file });
      },
      (value) => {
        value.toolCall.content = [{ type: 'diff', path: file, newText: 'changed' }];
      },
      (value) => {
        value.options[0]!.kind = 'allow_always';
      },
      (value) => {
        value.options.push({ ...value.options[0]!, kind: 'reject_once' });
      },
      (value) => {
        value.options.push({ ...value.options[0]!, optionId: 'another' });
      },
    ];
    for (const edit of edits) {
      const changed = request();
      edit(changed);
      expect(repositoryReadRequest(changed, root)).toBeUndefined();
    }
  });

  it('requires every target to be an existing file inside a validated root', async () => {
    expect(await approve([file])).toBe(true);
    const outside = path.join(directory, 'outside.ts');
    await writeFile(outside, 'outside');
    for (const files of [[root], [outside], [file, outside], [path.join(root, 'missing')]]) expect(await approve(files).catch(() => false)).toBe(false);
  });

  it.each(['.env', '.env.local', '.git/config', '.aws/credentials', '.npmrc', 'secrets.json', 'private.key'])('keeps %s manual', async (name) => {
    const sensitive = path.join(root, name);
    await mkdir(path.dirname(sensitive), { recursive: true });
    await writeFile(sensitive, 'sensitive');
    expect(await approve([sensitive])).toBe(false);
  });

  it('rejects escaping directory symlinks and hardlinks to files outside the root', async () => {
    const outside = path.join(directory, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'source.ts'), 'outside');
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await approve([path.join(root, 'linked', 'source.ts')])).toBe(false);
    await link(path.join(outside, 'source.ts'), path.join(root, 'alias.ts'));
    expect(await approve([path.join(root, 'alias.ts')])).toBe(false);
  });

  it('rejects targets and allocations replaced during validation, including disabled settings', async () => {
    expect(
      await approve([file], async () => {
        await rename(file, path.join(root, 'old.ts'));
        await writeFile(file, 'replacement');
      }),
    ).toBe(false);
    const readRoots = vi
      .fn()
      .mockResolvedValueOnce(await roots())
      .mockResolvedValueOnce([]);
    expect(await approveRepositoryRead([file], readRoots, async () => {})).toBe(false);
    await expect(
      approve([file], async () => {
        throw new Error('Stale binding');
      }),
    ).rejects.toThrow('Stale binding');
  });
});
