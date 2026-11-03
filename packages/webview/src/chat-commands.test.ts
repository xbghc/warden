import { describe, expect, it } from 'vitest';
import { completeSlashCommand, slashCommandQuery } from './chat-commands';

describe('chat command completion', () => {
  it('matches the command prefix at the caret, including edits before existing arguments', () => {
    expect(slashCommandQuery('/', 1)).toEqual({ query: '', tokenEnd: 1 });
    expect(slashCommandQuery('/EX', 3)).toEqual({ query: 'ex', tokenEnd: 3 });
    expect(slashCommandQuery('/explain 保留的草稿', 3)).toEqual({ query: 'ex', tokenEnd: 8 });
    expect(slashCommandQuery('/ 保留的草稿', 1)).toEqual({ query: '', tokenEnd: 1 });
  });

  it.each([
    ['', 0, 0],
    ['/ex', 0, 0],
    ['/ex', 4, 4],
    ['/ex', 1, 3],
    ['/explain file.ts', 12, 12],
    ['Look at /src', 12, 12],
    ['first line\n/ex', 14, 14],
  ] as const)('does not complete paths, arguments or selections: %s', (text, start, end) => {
    expect(slashCommandQuery(text, start, end)).toBeUndefined();
  });

  it('prepares an editable command without duplicating its prefix or replacing the arguments', () => {
    expect(completeSlashCommand('/', 1, 'explain')).toEqual({ text: '/explain ', caret: 9 });
    expect(completeSlashCommand('/ex 保留的草稿\nsecond line', 3, 'explain')).toEqual({ text: '/explain 保留的草稿\nsecond line', caret: 9 });
    expect(completeSlashCommand('/review\nkeep this', 7, 'explain')).toEqual({ text: '/explain\nkeep this', caret: 8 });
  });

  it('preserves the message length limit when completing a command', () => {
    expect(completeSlashCommand(`/ ${'x'.repeat(99_998)}`, 1, 'explain')).toBeUndefined();
    expect(completeSlashCommand(`/ ${'x'.repeat(99_991)}`, 1, 'explain')?.text).toHaveLength(100_000);
  });
});
