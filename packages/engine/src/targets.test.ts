import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

describe.each(['working', 'all', 'base'] as const)('%s live full file contents', (kind) => {
  it('reads symlink targets as Git content', async ({ skip }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'warden-file-symlinks-'));
    const checkout = path.join(root, 'checkout');
    const target = kind === 'base' ? { kind, ref: 'HEAD' } : { kind };
    const context: TargetContext = { cwd: checkout, key: kind === 'base' ? 'base:HEAD' : kind, target };
    try {
      await mkdir(path.join(checkout, 'src'), { recursive: true });
      await writeFile(path.join(checkout, 'src', 'file.ts'), 'export const value = 1;\n');
      await writeFile(path.join(root, 'private.txt'), 'outside secret\n');
      const links = [
        { file: 'file-link', target: path.join('src', 'file.ts'), type: 'file' },
        { file: 'dangling-link', target: path.join('src', 'missing.ts'), type: 'file' },
        { file: 'directory-link', target: 'src', type: 'dir' },
        { file: 'outside-link', target: path.join('..', 'private.txt'), type: 'file' },
      ] as const;
      for (const link of links) {
        try {
          await symlink(link.target, path.join(checkout, link.file), link.type);
        } catch (error) {
          // Windows requires Developer Mode or an elevated token for symbolic links.
          if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            skip('Symbolic link creation is not permitted.');
          }
          throw error;
        }
        expect(await getFullFile(context, link.file, 'new')).toBe(link.target);
      }
      expect(await getFullFile(context, 'src/file.ts', 'new')).toBe('export const value = 1;\n');
      await rm(path.join(checkout, 'src', 'file.ts'));
      expect(await getFullFile(context, 'src/file.ts', 'new')).toBeNull();
      expect(await getFullFile(context, 'file-link', 'new')).toBe(path.join('src', 'file.ts'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
