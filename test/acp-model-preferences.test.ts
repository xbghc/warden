import type { Memento } from 'vscode';
import { describe, expect, it } from 'vitest';
import { AcpModelPreferences } from '../packages/vscode/src/acp/model-preferences.js';

function memory() {
  const values = new Map<string, unknown>();
  const state = {
    keys: () => [...values.keys()],
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as Memento;
  return { values, state };
}

describe('ACP model preferences', () => {
  it('restores defaults across instances and keeps concurrent profiles independent', async () => {
    const { values, state } = memory();
    const first = new AcpModelPreferences(state);
    const second = new AcpModelPreferences(state);
    await Promise.all([first.save('profile-a', { configId: 'model', value: 'deep' }), second.save('profile-b', { configId: 'provider/model', value: 'fast' })]);
    const reopened = new AcpModelPreferences(state);
    expect(reopened.load('profile-a')).toEqual({ configId: 'model', value: 'deep' });
    expect(reopened.load('profile-b')).toEqual({ configId: 'provider/model', value: 'fast' });
    expect(reopened.load('unknown')).toBeUndefined();
    const selection = reopened.load('profile-a')!;
    selection.value = 'mutated';
    expect(reopened.load('profile-a')?.value).toBe('deep');
    expect([...values.keys()]).toHaveLength(2);
  });

  it.each([
    null,
    [],
    {},
    { configId: '', value: 'deep' },
    { configId: 'model', value: false },
    { configId: 'x'.repeat(501), value: 'deep' },
    { configId: 'model', value: 'deep', command: 'untrusted' },
  ])('ignores malformed stored preferences (%j)', (value) => {
    const { values, state } = memory();
    values.set('warden.acpModel:profile', value);
    expect(new AcpModelPreferences(state).load('profile')).toBeUndefined();
  });
});
