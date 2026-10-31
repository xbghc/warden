import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import { TaskNoteDrafts } from '../packages/vscode/src/task-note-drafts.js';

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
const committed = { title: 'Task', body: 'Saved notes' };

describe('task-note drafts', () => {
  it('restores drafts after recreating the store without mixing tasks or repositories', async () => {
    const state = memory();
    const drafts = new TaskNoteDrafts(state);
    const first = { title: 'Draft title', body: 'First line\nSecond line' };
    const second = { title: 'Other', body: 'Other notes' };
    await drafts.save('/repo', 'first', first, committed);
    await drafts.save('/repo', 'second', second, committed);
    const restored = new TaskNoteDrafts(state);
    expect(restored.read('/repo', 'first')).toEqual(first);
    expect(restored.read('/repo', 'second')).toEqual(second);
    expect(restored.read('/other', 'first')).toBeUndefined();
    expect(restored.read('/repo', 'missing')).toBeUndefined();
  });

  it('serializes writes and keeps newer typing when an earlier task save completes', async () => {
    const state = memory();
    const update = state.update.bind(state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    state.update = async (key, value) => {
      if (first) {
        first = false;
        await held;
      }
      await update(key, value);
    };
    const drafts = new TaskNoteDrafts(state);
    const submitted = { ...committed, body: 'Submitted edit' };
    const newer = { ...committed, body: 'Typing after Save' };
    const pending = drafts.save('/repo', 'task', submitted, committed);
    const next = drafts.save('/repo', 'task', newer, committed);
    await drafts.saved('/repo', 'task', submitted);
    expect(drafts.read('/repo', 'task')).toEqual(newer);
    release();
    await Promise.all([pending, next, drafts.flush()]);
    expect(new TaskNoteDrafts(state).read('/repo', 'task')).toEqual(newer);
  });

  it('removes saved and discarded drafts so later task updates are not hidden', async () => {
    const state = memory();
    const drafts = new TaskNoteDrafts(state);
    const edit = { ...committed, body: 'Edited' };
    await drafts.save('/repo', 'task', edit, committed);
    await drafts.saved('/repo', 'task', edit);
    expect(new TaskNoteDrafts(state).read('/repo', 'task')).toBeUndefined();
    await drafts.save('/repo', 'task', edit, committed);
    await drafts.save('/repo', 'task', committed, committed);
    expect(new TaskNoteDrafts(state).read('/repo', 'task')).toBeUndefined();
    expect(state.keys()).toEqual([]);
  });

  it('ignores malformed persisted values without deleting unrelated state', async () => {
    const state = memory();
    const key = 'warden.task-note-draft:["/repo","task"]';
    for (const value of [null, 1, {}, { title: 'x'.repeat(201), body: '' }, { title: '', body: 'x'.repeat(10001) }]) {
      await state.update(key, value);
      expect(new TaskNoteDrafts(state).read('/repo', 'task')).toBeUndefined();
      expect(state.get(key)).toEqual(value);
    }
  });
});
