import { describe, expect, it } from 'vitest';
import { AcpDraft } from '../packages/vscode/src/acp/draft.js';

describe('ACP draft synchronization', () => {
  it('acknowledges edited text together with an appended selection', () => {
    const draft = new AcpDraft('Task brief');
    draft.update({ text: 'Edited brief', revision: 1, version: 0 });
    draft.append('Selected source');
    expect(draft.snapshot()).toMatchObject({ draft: 'Edited brief\n\nSelected source', draftRevision: 1, draftVersion: 1 });
    expect(draft.begin({ text: draft.text, revision: 1, version: 1 }).text).toBe('Edited brief\n\nSelected source');
  });

  it('rebases an in-flight edit over every unseen selection without duplicating acknowledged selections', () => {
    const draft = new AcpDraft('Original');
    draft.append('First excerpt');
    draft.append('Second excerpt');
    draft.update({ text: 'New local text', revision: 1, version: 0 });
    expect(draft.text).toBe('New local text\n\nFirst excerpt\n\nSecond excerpt');
    draft.update({ text: draft.text, revision: 1, version: 2 });
    draft.update({ text: 'New local text', revision: 1, version: 0 });
    expect(draft.text).toBe('New local text\n\nFirst excerpt\n\nSecond excerpt');
    expect(draft.snapshot().draftChanges).toEqual([]);
  });

  it('rejects sending before the panel has applied a new selection', () => {
    const draft = new AcpDraft('Task');
    draft.append('Review this source');
    expect(() => draft.begin({ text: 'Task', revision: 0, version: 0 })).toThrow('草稿已更新');
    expect(draft.text).toBe('Task\n\nReview this source');
    expect(draft.begin({ text: draft.text, revision: 0, version: 1 }).text).toContain('Review this source');
  });

  it('keeps completion authoritative when a panel reopens during a turn', () => {
    const draft = new AcpDraft('First');
    const sent = draft.begin({ text: 'Submitted task', revision: 1, version: 0 });
    draft.resetPanel();
    expect(draft.complete(sent.mutation)).toBe(true);
    expect(draft.snapshot()).toEqual({ draft: '', draftRevision: 0, draftVersion: 1, draftChanges: [{ type: 'clear', revision: 0, version: 1 }] });
  });

  it('does not resurrect a completed prompt when its delayed draft save arrives', () => {
    const draft = new AcpDraft('Task');
    const submitted = { text: 'Task', revision: 1, version: 0 };
    const sent = draft.begin(submitted);
    draft.complete(sent.mutation);
    draft.update(submitted);
    expect(draft.text).toBe('');
    draft.update({ text: 'Next task', revision: 2, version: 0 });
    expect(draft.text).toBe('Next task');
  });

  it.each(['Next task', 'Task'])('accepts a newer follow-up %j before its completion clear is acknowledged', (text) => {
    const draft = new AcpDraft('Task');
    const submitted = { text: 'Task', revision: 1, version: 0 };
    const first = draft.begin(submitted);
    expect(draft.complete(first.mutation)).toBe(true);
    expect(() => draft.begin(submitted)).toThrow('草稿已更新');
    expect(draft.text).toBe('');

    // A flushed draft and its following send can both arrive before the panel receives the clear.
    const followup = { text, revision: 2, version: 0 };
    draft.update(followup);
    const next = draft.begin(followup);
    expect(next.text).toBe(text);
    expect(draft.complete(next.mutation)).toBe(true);
    expect(draft.text).toBe('');
    expect(() => draft.begin(followup)).toThrow('草稿已更新');
    expect(draft.begin({ text: 'Third task', revision: 3, version: 0 }).text).toBe('Third task');
  });

  it('requires acknowledging a selection appended after a completed draft', () => {
    const draft = new AcpDraft('Task');
    const first = draft.begin({ text: 'Task', revision: 1, version: 0 });
    draft.complete(first.mutation);
    draft.append('Review this source');
    const followup = { text: 'Next task', revision: 2, version: 0 };
    draft.update(followup);
    const before = draft.snapshot();
    expect(() => draft.begin(followup)).toThrow('草稿已更新');
    expect(draft.snapshot()).toEqual(before);
    expect(draft.begin({ text: draft.text, revision: 2, version: 2 }).text).toBe('Next task\n\nReview this source');
  });

  it('accepts a newer send before its separate draft save arrives', () => {
    const draft = new AcpDraft('Task');
    const first = draft.begin({ text: 'Task', revision: 1, version: 0 });
    draft.complete(first.mutation);
    const next = draft.begin({ text: 'Next task', revision: 2, version: 0 });
    expect(next.text).toBe('Next task');
    draft.update({ text: 'Task', revision: 1, version: 0 });
    expect(draft.text).toBe('Next task');
    expect(draft.complete(next.mutation)).toBe(true);
  });

  it('rejects invalid versions and revisions while a completion clear is unacknowledged', () => {
    const draft = new AcpDraft('Task');
    const first = draft.begin({ text: 'Task', revision: 1, version: 0 });
    draft.complete(first.mutation);
    const before = draft.snapshot();
    for (const edit of [
      { version: -1, revision: 2 },
      { version: 2, revision: 2 },
      { version: 0.5, revision: 2 },
      { version: 0, revision: -1 },
      { version: 0, revision: 2.5 },
      { version: Number.NaN, revision: 2 },
      { version: 0, revision: Number.NaN },
    ]) {
      expect(() => draft.begin({ text: 'Next task', ...edit })).toThrow();
      expect(draft.snapshot()).toEqual(before);
    }
  });

  it.each(['acknowledge', 'reopen'])('rejects a stale send after completion history is removed by %s', (operation) => {
    const draft = new AcpDraft('Task');
    const first = draft.begin({ text: 'Task', revision: 1, version: 0 });
    draft.complete(first.mutation);
    if (operation === 'acknowledge') draft.update({ text: '', revision: 1, version: 1 });
    else draft.resetPanel();
    const second = draft.begin({ text: 'Second task', revision: 2, version: 1 });
    draft.complete(second.mutation);
    const before = draft.snapshot();
    expect(() => draft.begin({ text: 'Unobserved history', revision: 3, version: 0 })).toThrow('草稿已更新');
    expect(draft.snapshot()).toEqual(before);
    expect(draft.begin({ text: 'Next task', revision: 3, version: 1 }).text).toBe('Next task');
  });

  it('preserves a newer edit even when its text equals the submitted prompt', () => {
    const draft = new AcpDraft('Task');
    const sent = draft.begin({ text: 'Same text', revision: 1, version: 0 });
    draft.update({ text: 'Same text', revision: 2, version: 0 });
    expect(draft.complete(sent.mutation)).toBe(false);
    expect(draft.text).toBe('Same text');
  });

  it('ignores out-of-order edits and preserves a newer panel edit after reopening', () => {
    const draft = new AcpDraft('Task');
    const sent = draft.begin({ text: 'Submitted', revision: 3, version: 0 });
    draft.update({ text: 'Old input', revision: 2, version: 0 });
    expect(draft.text).toBe('Submitted');
    draft.resetPanel();
    draft.update({ text: 'New panel edit', revision: 1, version: 0 });
    expect(draft.complete(sent.mutation)).toBe(false);
    expect(draft.text).toBe('New panel edit');
  });

  it('reports oversized reconciled drafts without destroying either saved text or pending selections', () => {
    const draft = new AcpDraft('Saved');
    draft.append('Selected context');
    const before = draft.snapshot();
    expect(() => draft.update({ text: 'x'.repeat(100_000), revision: 1, version: 0 })).toThrow('消息过长');
    expect(draft.snapshot()).toEqual(before);
    expect(() => draft.append('x'.repeat(100_000))).toThrow('消息过长');
    expect(draft.snapshot()).toEqual(before);
  });
});
