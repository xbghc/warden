import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GIT_TIMEOUT_MS, type GitBufferResult, GitError, runGitBuffer } from './git.js';
import { readWorktreeState } from './worktree-state.js';

vi.mock('./git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git.js')>()),
  runGitBuffer: vi.fn(),
}));

const output: GitBufferResult = {
  stdout: Buffer.from(`# branch.oid ${'1'.repeat(40)}\0# branch.head main\0`),
  stderr: '',
  code: 0,
};
const children: { resolve: (result: GitBufferResult) => void; reject: (error: Error) => void }[] = [];
const requests: Promise<unknown>[] = [];

function read(cwd: string) {
  const request = readWorktreeState(cwd);
  requests.push(request.catch(() => undefined));
  return request;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.mocked(runGitBuffer).mockImplementation(() => new Promise((resolve, reject) => children.push({ resolve, reject })));
});

afterEach(async () => {
  // Drain any remaining calls even when an assertion fails, leaving no slots or timers behind.
  await vi.advanceTimersByTimeAsync(0);
  while (children.length) {
    for (const child of children.splice(0)) child.resolve(output);
    await vi.advanceTimersByTimeAsync(0);
  }
  await Promise.all(requests.splice(0));
  vi.mocked(runGitBuffer).mockReset();
  vi.useRealTimers();
});

describe('worktree status scheduling', () => {
  it('bounds concurrent Git children and releases queued reads in order after success or failure', async () => {
    const results = Array.from({ length: 11 }, (_, i) => read(`checkout-${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(runGitBuffer).toHaveBeenCalledTimes(8);

    children.shift()!.reject(new GitError('failed', 128, 'diagnostic', 500, 'git_failed'));
    await expect(results[0]).rejects.toMatchObject({ code: 'git_failed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(runGitBuffer).mock.calls.at(-1)![1].cwd).toBe('checkout-8');
    expect(children).toHaveLength(8);

    children.shift()!.resolve({ ...output, stdout: Buffer.from('invalid status') });
    await expect(results[1]).rejects.toThrow('porcelain v2');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(runGitBuffer).mock.calls.at(-1)![1].cwd).toBe('checkout-9');
    expect(children).toHaveLength(8);

    children.shift()!.resolve(output);
    await expect(results[2]).resolves.toMatchObject({ branch: 'main' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(runGitBuffer).mock.calls.at(-1)![1].cwd).toBe('checkout-10');
    expect(children).toHaveLength(8);
  });

  it('subtracts queue time from the Git execution deadline', async () => {
    for (let i = 0; i < 9; i++) read(`checkout-${i}`);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runGitBuffer).toHaveBeenCalledTimes(8);
    children.shift()!.resolve(output);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(runGitBuffer).mock.calls.at(-1)![1]).toMatchObject({ cwd: 'checkout-8', timeoutMs: DEFAULT_GIT_TIMEOUT_MS - 10_000 });
  });

  it('expires queued reads without starting Git or leaking capacity', async () => {
    for (let i = 0; i < 8; i++) read(`checkout-${i}`);
    const expired = read('expired');
    await vi.advanceTimersByTimeAsync(DEFAULT_GIT_TIMEOUT_MS);
    await expect(expired).rejects.toMatchObject({ code: 'git_timeout', status: 504 });
    expect(runGitBuffer).toHaveBeenCalledTimes(8);
    for (const child of children.splice(0)) child.resolve(output);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) read(`fresh-${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(runGitBuffer).toHaveBeenCalledTimes(16);
    expect(vi.mocked(runGitBuffer).mock.calls.some(([, options]) => options.cwd === 'expired')).toBe(false);
    expect(children).toHaveLength(8);
  });
});
