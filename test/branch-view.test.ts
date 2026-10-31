import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import type { HistoryPreviewRequest, WorkflowResponse } from '@warden/shared';
import { BranchViews } from '../packages/vscode/src/branch-view.js';

function memory(): Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (structuredClone(values.get(key)) as T) : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    },
  } as Memento;
}
const data = (branch: string): WorkflowResponse => ({
  developmentHead: 'same-head',
  workflow: {
    developmentBranch: branch,
    changes: ['a', 'b'].flatMap((developmentBranch) =>
      [1, 2].map((index) => ({
        id: `${developmentBranch}${index}`,
        title: `${developmentBranch}${index}`,
        developmentBranch,
        status: 'planned' as const,
        createdAt: '2026-10-27T00:00:00Z',
      })),
    ),
  },
});
const draft = (message: string): HistoryPreviewRequest => ({ head: 'same-head', start: 'start', commits: [{ sha: 'same-head', message }] });

describe('branch view persistence', () => {
  it('restores each branch selection even when both branch tips are identical', async () => {
    const state = memory();
    const views = new BranchViews(state);
    expect((await views.load('/repo', data('a'))).selected).toBe('a1');
    await views.select('/repo', 'a', 'a2');
    expect(await views.load('/repo', data('b'))).toEqual({ selected: 'b1' });
    await views.select('/repo', 'b', 'b2');
    const reopened = new BranchViews(state);
    expect(await reopened.load('/repo', data('a'))).toEqual({ selected: 'a2' });
    expect(await reopened.load('/repo', data('b'))).toEqual({ selected: 'b2' });
    expect(await reopened.load('/other', data('a'))).toEqual({ selected: 'a1' });
  });

  it('migrates selection once while preserving inactive history drafts', async () => {
    const state = memory();
    await state.update('warden.selected:/repo', 'a2');
    await state.update('warden.history:/repo', draft('Legacy A'));
    await state.update('warden.branch-view:["/repo","a"]:history', draft('Branch A'));
    const views = new BranchViews(state);
    expect(await views.load('/repo', data('a'))).toEqual({ selected: 'a2' });
    expect(await new BranchViews(state).load('/repo', data('b'))).toEqual({ selected: 'b1' });
    await views.select('/repo', 'b', 'a2');
    expect((await views.load('/repo', data('b'))).selected).toBe('b1');
    expect(await views.load('/repo', data('a'))).toEqual({ selected: 'a2' });
    expect(state.get('warden.history:/repo')).toEqual(draft('Legacy A'));
    expect(state.get('warden.branch-view:["/repo","a"]:history')).toEqual(draft('Branch A'));
  });
});
