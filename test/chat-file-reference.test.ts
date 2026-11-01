import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAcpAction, parseFileReference } from '@warden/shared';
import { readWorkspaceReference } from '../packages/vscode/src/acp/file-reference.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('task chat file references', () => {
  it.each([
    'command:workbench.action.closeWindow',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//server/file',
    '%00file',
    'src/a.ts:0',
    'src/a.ts#L999999999',
  ])('rejects executable or invalid references: %s', (reference) => {
    expect(parseFileReference(reference)).toBeUndefined();
    expect(() => parseAcpAction({ type: 'open-file', reference })).toThrow();
  });

  it('reads only bounded workspace text, including decoded names and line locations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'warden-chat-files-'));
    roots.push(root);
    const workspace = path.join(root, 'task');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'a b.ts'), 'first\nsecond\n');
    await writeFile(path.join(root, 'outside.txt'), 'outside');
    expect(await readWorkspaceReference(workspace, './a%20b.ts#L2C3')).toMatchObject({ path: 'a b.ts', line: 2, column: 3, content: 'first\nsecond\n' });
    expect(await readWorkspaceReference(workspace, `${path.join(workspace, 'a b.ts')}:2`)).toMatchObject({ line: 2 });
    expect(parseFileReference('README.md:12')).toEqual({ path: 'README.md', line: 12 });
    await expect(readWorkspaceReference(workspace, '../outside.txt')).rejects.toThrow('inside this task workspace');
    await expect(readWorkspaceReference(workspace, '%2e%2e/outside.txt')).rejects.toThrow('inside this task workspace');
    await writeFile(path.join(workspace, 'binary'), Buffer.from([0, 255]));
    await expect(readWorkspaceReference(workspace, 'binary')).rejects.toThrow('binary');
    await writeFile(path.join(workspace, 'large'), Buffer.alloc(2_000_001, 65));
    await expect(readWorkspaceReference(workspace, 'large')).rejects.toThrow('2 MB');
    await symlink(root, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readWorkspaceReference(workspace, 'escape/outside.txt')).rejects.toThrow('inside this task workspace');
  });
});
