import { describe, expect, it } from 'vitest';
import { assertAllowedGitArgs, GitError, runGit } from './git.js';

describe('git whitelist', () => {
  it('allows whitelisted sub-commands', () => {
    expect(() => assertAllowedGitArgs(['rev-parse', '--show-toplevel'])).not.toThrow();
    expect(() => assertAllowedGitArgs(['diff', '--cached'])).not.toThrow();
    expect(() => assertAllowedGitArgs(['worktree', 'list', '--porcelain'])).not.toThrow();
    expect(() => assertAllowedGitArgs(['ls-files', '--others'])).not.toThrow();
  });
  it('rejects anything else with a 400-class error', async () => {
    for (const args of [['commit', '-m', 'x'], ['checkout', 'main'], ['reset', '--hard'], ['stash'], ['worktree', 'add', '/tmp/x'], ['push'], []]) {
      let err: unknown;
      try {
        assertAllowedGitArgs(args);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).status).toBe(400);
    }
    await expect(runGit(['commit', '-m', 'x'], { cwd: process.cwd() })).rejects.toMatchObject({ status: 400 });
  });
  it('tells a working directory that is gone apart from a missing git', async () => {
    await expect(runGit(['rev-parse', 'HEAD'], { cwd: '/definitely/not/a/directory' })).rejects.toMatchObject({ status: 400, code: 'unknown_worktree' });
  });
  it('rejects options that could write to disk', () => {
    expect(() => assertAllowedGitArgs(['diff', '--output=/tmp/x'])).toThrow(GitError);
    expect(() => assertAllowedGitArgs(['log', '--output', '/tmp/x'])).toThrow(GitError);
    expect(() => assertAllowedGitArgs(['diff', '-c', 'core.pager=evil'])).toThrow(GitError);
  });
});
