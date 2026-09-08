import { describe, expect, it } from 'vitest';
import { parseCommitLog, parseDecorations } from './commits.js';

describe('parseDecorations', () => {
  it('tells HEAD, branches and tags apart, and drops the remote HEAD alias', () => {
    expect(parseDecorations('HEAD -> main, tag: v1.2, origin/main, origin/HEAD')).toEqual({
      head: true,
      refs: [
        { name: 'main', kind: 'branch' },
        { name: 'v1.2', kind: 'tag' },
        { name: 'origin/main', kind: 'branch' },
      ],
    });
  });

  it('marks a detached HEAD without inventing a branch', () => {
    expect(parseDecorations('HEAD, tag: v2')).toEqual({ head: true, refs: [{ name: 'v2', kind: 'tag' }] });
  });

  it('puts the checked-out branch first wherever git printed it', () => {
    expect(parseDecorations('tag: v3, HEAD -> feature/x').refs.map((r) => r.name)).toEqual(['feature/x', 'v3']);
  });

  it('ignores an empty list and shallow-clone markers', () => {
    expect(parseDecorations('')).toEqual({ head: false, refs: [] });
    expect(parseDecorations('grafted')).toEqual({ head: false, refs: [] });
  });
});

describe('parseCommitLog', () => {
  it('reads one commit per line, merge parents included', () => {
    const line = ['a'.repeat(40), 'aaaaaaa', 'Ann', 'ann@example.com', '2026-09-08T10:00:00+08:00', `${'b'.repeat(40)} ${'c'.repeat(40)}`, 'HEAD -> main', 'Merge topic (#12)'].join(
      '\x1f',
    );
    expect(parseCommitLog(`${line}\n`)).toEqual([
      {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        author: 'Ann',
        email: 'ann@example.com',
        date: '2026-09-08T10:00:00+08:00',
        parents: ['b'.repeat(40), 'c'.repeat(40)],
        refs: [{ name: 'main', kind: 'branch' }],
        head: true,
        subject: 'Merge topic (#12)',
      },
    ]);
    expect(parseCommitLog('')).toEqual([]);
  });
});
