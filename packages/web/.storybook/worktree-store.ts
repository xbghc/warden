import { fn } from 'storybook/test';
import type { WorktreeDetail } from '@warden/shared';
import { setupDemoStore } from './demo-store';
import { api } from '../src/api';
import { useStore } from '../src/store';
const root = '/workspace/warden';
const topic = '/workspace/warden-1';
const worktrees: WorktreeDetail[] = [
  {
    path: root,
    branch: 'main',
    head: 'abc1234',
    isMain: true,
    detached: false,
    bare: false,
    prunable: false,
    dirty: 0,
    free: false,
    comparison: { kind: 'upstream', base: 'origin/main', ahead: 0, behind: 2 },
  },
  {
    path: topic,
    branch: 'feature/review',
    head: 'def5678',
    isMain: false,
    detached: false,
    bare: false,
    prunable: false,
    dirty: 2,
    slot: 1,
    free: false,
    comparison: { kind: 'upstream', base: 'origin/feature/review', ahead: 2, behind: 0 },
  },
  // Released: a detached, clean slot whose directory waits for the next branch.
  {
    path: '/workspace/warden-2',
    head: 'fed1234',
    isMain: false,
    detached: true,
    bare: false,
    prunable: false,
    dirty: 0,
    slot: 2,
    free: true,
  },
  // A clone slot: a repository of its own, counted against its remote's default branch.
  {
    path: '/workspace/warden-3',
    branch: 'agent/clone-work',
    head: 'bcd2345',
    isMain: false,
    detached: false,
    bare: false,
    prunable: false,
    clone: true,
    dirty: 0,
    slot: 3,
    free: false,
    trunk: 'origin/main',
    comparison: { kind: 'trunk', base: 'origin/main', ahead: 3, behind: 1 },
  },
  // Released clone: its own branches are what the form offers for it.
  {
    path: '/workspace/warden-4',
    head: 'cde3456',
    isMain: false,
    detached: true,
    bare: false,
    prunable: false,
    clone: true,
    dirty: 0,
    slot: 4,
    free: true,
    trunk: 'origin/main',
    branches: [{ name: 'agent/old-task', sha: 'cde3456' }],
  },
  // Made by hand, not a slot: it can only be removed.
  {
    path: '/workspace/warden-done',
    branch: 'fix/empty',
    head: 'fed1234',
    isMain: false,
    detached: false,
    bare: false,
    prunable: false,
    dirty: 0,
    free: false,
    comparison: { kind: 'base', base: 'main', ahead: 0, behind: 3 },
    upstreamGone: 'origin/fix/empty',
  },
];

export function setupWorktreeStore() {
  setupDemoStore();
  useStore.setState({ panel: 'orchestration' });
  const original = { ...api };
  api.worktrees = fn(async () => ({
    worktrees,
    branches: [],
    newSlot: { slot: 5, path: '/workspace/warden-5' },
    slotKind: 'clone' as const,
    trunk: 'origin/main',
  }));
  api.commits = fn(async () => ({
    commits: [
      {
        sha: 'def5678',
        shortSha: 'def5678',
        author: 'Lin',
        email: 'lin@example.com',
        date: '2026-09-11T10:00:00Z',
        subject: '补充评论导出',
        parents: [],
        refs: [],
        head: true,
      },
    ],
    hasMore: false,
  }));
  api.todos = fn(async (branch) => ({
    todos:
      branch === 'feature/review'
        ? [{ id: 't1', branch, title: '验证导出格式', body: '覆盖文件名和行号。', status: 'open' as const, createdAt: '', updatedAt: '' }]
        : [],
  }));
  api.remoteBranches = fn(async () => ({ remotes: [] }));
  api.createWorktree = fn(async ({ slot }) => ({ worktree: worktrees[1]!, slot: slot ?? 2, reused: slot !== 5 }));
  api.releaseWorktree = fn(async () => ({ ok: true as const, branchDeleted: true }));
  api.removeWorktree = fn(async () => ({ ok: true as const, branchDeleted: false }));
  return () => Object.assign(api, original);
}
