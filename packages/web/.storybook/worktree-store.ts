import { fn } from 'storybook/test';
import type { WorktreeDetail } from '@warden/shared';
import { setupDemoStore } from './demo-store';
import { api } from '../src/api';
const root = '/workspace/warden';
const topic = '/workspace/warden-review';
const worktrees: WorktreeDetail[] = [
  { path: root, branch: 'main', head: 'abc1234', isMain: true, detached: false, bare: false, prunable: false, dirty: 0 },
  {
    path: topic,
    branch: 'feature/review',
    head: 'def5678',
    isMain: false,
    detached: false,
    bare: false,
    prunable: false,
    dirty: 2,
    comparison: { base: 'main', ahead: 2, behind: 1, merged: false },
  },
  {
    path: '/workspace/warden-done',
    branch: 'fix/empty',
    head: 'fed1234',
    isMain: false,
    detached: false,
    bare: false,
    prunable: false,
    dirty: 0,
    comparison: { base: 'main', ahead: 0, behind: 3, merged: true },
  },
];

export function setupWorktreeStore() {
  setupDemoStore();
  const original = { ...api };
  api.worktrees = fn(async () => ({ worktrees, branches: [], pathPrefix: '/workspace/warden-' }));
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
  api.createWorktree = fn(async () => worktrees[1]!);
  api.removeWorktree = fn(async () => ({ ok: true as const, branchDeleted: false }));
  return () => Object.assign(api, original);
}
