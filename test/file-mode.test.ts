import { expect, it } from 'vitest';
import { fileModeChange } from '../packages/vscode/src/file-mode.js';

it('describes a mode change only for a file that exists on both sides', () => {
  expect(fileModeChange({ oldMode: '100644', newMode: '100755' })).toBe('File mode 100644 → 100755');
  expect(fileModeChange({ oldMode: '100644', newMode: '120000' })).toBe('File mode 100644 → 120000');
  expect(fileModeChange({ oldMode: '100644', newMode: '100644' })).toBeUndefined();
  expect(fileModeChange({})).toBeUndefined();
  // Git reports one mode for an added or a deleted file. That is not a change of mode.
  expect(fileModeChange({ newMode: '100644' })).toBeUndefined();
  expect(fileModeChange({ oldMode: '100755' })).toBeUndefined();
});
