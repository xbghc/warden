import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGitBuffer, runGitWrite } from './git.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

const file = fileURLToPath(import.meta.url);
const runners = {
  read: (cwd: string) => runGitBuffer(['status'], { cwd }),
  write: (cwd: string) => runGitWrite(['status'], { cwd }),
};

afterEach(() => vi.mocked(execFile).mockReset());

describe.each(Object.entries(runners))('%s Git spawn errors', (_name, run) => {
  it('recognizes Windows ENOENT for an existing file used as cwd', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      queueMicrotask(() => done(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })));
      return {} as ReturnType<typeof execFile>;
    });
    await expect(run(file)).rejects.toMatchObject({ status: 400, code: 'unknown_worktree' });
  });

  it('preserves missing-Git diagnostics when cwd is a directory', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      queueMicrotask(() => done(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })));
      return {} as ReturnType<typeof execFile>;
    });
    await expect(run(path.dirname(file))).rejects.toMatchObject({ status: 500, code: 'git_missing' });
  });

  it('classifies synchronous ENOTDIR failures as invalid workspaces', async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
    });
    await expect(run(file)).rejects.toMatchObject({ status: 400, code: 'unknown_worktree' });
  });
});
