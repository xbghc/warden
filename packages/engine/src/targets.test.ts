import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRepoPath, getFullFile, type TargetContext } from './targets.js';

describe('repository file paths', () => {
  it.each(['win32', 'linux', 'darwin'] as const)('rejects absolute paths, parent traversal and NUL on %s', (platform) => {
    for (const file of ['', '/etc/passwd', '../outside.txt', 'src/../../outside.txt', 'src/../outside.txt', 'src\0file']) {
      expect(() => assertRepoPath(file, platform), file).toThrow(expect.objectContaining({ code: 'invalid_path', status: 400 }));
    }
    for (const file of ['src/a.ts', '中文 文档.md', "sp 'q.ts", '[literal]%.ts', '.gitignore']) {
      expect(() => assertRepoPath(file, platform), file).not.toThrow();
    }
  });

  it.each([
    String.raw`..\outside.txt`,
    String.raw`src\..\..\outside.txt`,
    String.raw`src/..\outside.txt`,
    String.raw`C:\outside.txt`,
    'C:outside.txt',
    String.raw`\outside.txt`,
    String.raw`\\server\share\outside.txt`,
    String.raw`\\?\C:\outside.txt`,
    String.raw`\\.\NUL`,
    'file.txt:secret',
    'file.txt::$DATA',
    'NUL',
    'src/CON.txt',
    'src/LPT1.log',
    'COM¹.txt',
    'CONIN$',
    'NUL .txt',
    String.raw`.. \outside.txt`,
    'trailing-dot.',
  ])('rejects Windows traversal, device and stream alias %s', (file) => {
    expect(() => assertRepoPath(file, 'win32')).toThrow(expect.objectContaining({ code: 'invalid_path', status: 400 }));
  });

  it.each(['linux', 'darwin'] as const)('preserves literal backslashes, colons and device-like filenames on %s', (platform) => {
    for (const file of [String.raw`..\outside.txt`, String.raw`back\slash`, 'file:stream', ':colon.ts', 'NUL', 'trailing-dot.']) {
      expect(() => assertRepoPath(file, platform), file).not.toThrow();
    }
  });

  it('never reads a sibling file through the native path separator', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'warden-file-paths-'));
    const checkout = path.join(root, 'checkout');
    await mkdir(checkout);
    await writeFile(path.join(root, 'private.txt'), 'outside secret\n');
    const context: TargetContext = { cwd: checkout, key: 'working', target: { kind: 'working' } };
    try {
      await expect(getFullFile(context, path.join('..', 'private.txt'), 'new')).rejects.toMatchObject({ code: 'invalid_path' });
      if (process.platform !== 'win32') {
        await writeFile(path.join(checkout, String.raw`..\private.txt`), 'literal local file\n');
        expect(await getFullFile(context, String.raw`..\private.txt`, 'new')).toBe('literal local file\n');
      }
      expect(await readFile(path.join(root, 'private.txt'), 'utf8')).toBe('outside secret\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
