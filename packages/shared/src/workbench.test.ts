import { describe, expect, it } from 'vitest';
import { parseWorkbenchAction } from './workbench.js';

describe('webview protocol boundary', () => {
  it('rejects arbitrary commands, adoption and oversized input', () => {
    for (const action of [
      { type: 'executeCommand', command: 'workbench.action.terminal.new' },
      { type: 'task.start', taskId: 'task', kind: 'shared', worktree: '/outside' },
      { type: 'task.start', taskId: 'task', kind: 'shared', agent: 'x'.repeat(101) },
      { type: 'settings.save', config: { hooks: { create: 42, reuse: '' }, previewSetup: '' } },
      { type: 'task.create', title: 'x'.repeat(201), body: '' },
      { type: 'history.preview', draft: { head: 'head', start: 'start', commits: [] } },
    ])
      expect(() => parseWorkbenchAction(action)).toThrow();
  });
  it('keeps exact versions and multiline messages across history and rebase actions', () => {
    const action = { type: 'history.preview', draft: { head: 'head', start: 'start', commits: [{ sha: 'a', message: 'Title\n\nReason' }] } };
    expect(parseWorkbenchAction(action)).toEqual(action);
    const rebase = { type: 'rebase.run', items: [{ changeId: 'task', sourceHead: 'a', developmentHead: 'b' }] };
    expect(parseWorkbenchAction(rebase)).toEqual(rebase);
  });
});
