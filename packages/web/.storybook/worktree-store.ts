import { fn } from 'storybook/test';
import type { WorktreeDetail } from '@warden/shared';
import { setupDemoStore } from './demo-store';
import { api } from '../src/api';
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
  const original = { ...api };
  api.worktrees = fn(async () => ({ worktrees, branches: [], newSlot: { slot: 3, path: '/workspace/warden-3' } }));
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
  api.tmuxSessions = fn(async () => ({ sessions: [{ id: '$1', name: 'warden', path: root }] }));
  api.openTmuxWindow = fn(async () => ({ session: 'warden', window: '@3' }));
  api.createWorktree = fn(async ({ slot }) => ({ worktree: worktrees[1]!, slot: slot ?? 2, reused: slot !== 3 }));
  api.releaseWorktree = fn(async () => ({ ok: true as const, branchDeleted: true }));
  api.removeWorktree = fn(async () => ({ ok: true as const, branchDeleted: false }));
  return () => Object.assign(api, original);
}
