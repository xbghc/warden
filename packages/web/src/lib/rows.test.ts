import { describe, expect, it } from 'vitest';
import type { Comment, FileDiff, Hunk } from '@warden/shared';
import { buildRows, computeGaps, findRowIndex } from './rows';

function hunk(oldStart: number, newStart: number, spec: string[]): Hunk {
  let o = oldStart;
  let n = newStart;
  const lines = spec.map((s) => {
    const ch = s[0];
    const content = s.slice(1);
    if (ch === '+') return { type: 'add' as const, newLineNo: n++, content };
    if (ch === '-') return { type: 'del' as const, oldLineNo: o++, content };
    return { type: 'context' as const, oldLineNo: o++, newLineNo: n++, content };
  });
  return { hash: 'h', oldStart, oldLines: o - oldStart, newStart, newLines: n - newStart, header: '', lines };
}

const diff: FileDiff = {
  path: 'a.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  binary: false,
  contentHash: 'x',
  hunks: [hunk(10, 10, [' a', '-b', '+B', '+B2', ' c']), hunk(30, 31, [' x', '+y'])],
};

const comment: Comment = {
  id: 'c',
  targetKey: 'working',
  filePath: 'a.ts',
  side: 'new',
  startLine: 11,
  endLine: 12,
  codeSnippet: ['B', 'B2'],
  body: 'hi',
  status: 'active',
  anchor: { hunkHash: 'h', lineHashes: [], contextBefore: [], contextAfter: [], hunkLineOffset: 1 },
  createdAt: '',
  updatedAt: '',
};

describe('computeGaps', () => {
  it('describes the regions between hunks', () => {
    expect(computeGaps(diff, 50)).toEqual([
      { index: 0, newFrom: 1, newTo: 9, oldFrom: 1 },
      { index: 1, newFrom: 14, newTo: 30, oldFrom: 13 },
      { index: 2, newFrom: 33, newTo: 50, oldFrom: 31 },
    ]);
    expect(computeGaps(diff, null)[2]!.newTo).toBeNull();
  });
});

describe('buildRows', () => {
  it('unified: gap, hunk, lines and comment rows in order', () => {
    const rows = buildRows({ diff, viewMode: 'unified', comments: [comment], editor: null, expansions: {}, fullLines: null });
    expect(rows.map((r) => r.kind)).toEqual(['gap', 'hunk', 'line', 'line', 'line', 'line', 'comments', 'line', 'gap', 'hunk', 'line', 'line', 'gap']);
    const idx = findRowIndex(rows, 'new', 12);
    expect(rows[idx + 1]!.kind).toBe('comments');
  });

  it('split: pairs del/add runs and attaches comments after the pair row', () => {
    const rows = buildRows({ diff, viewMode: 'split', comments: [comment], editor: null, expansions: {}, fullLines: null });
    const pairs = rows.filter((r) => r.kind === 'pair');
    expect(pairs.map((p) => (p.kind === 'pair' ? [p.left?.content, p.right?.content] : null))).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      [undefined, 'B2'],
      ['c', 'c'],
      ['x', 'x'],
      [undefined, 'y'],
    ]);
    const idx = findRowIndex(rows, 'new', 12);
    expect(rows[idx + 1]!.kind).toBe('comments');
  });

  it('expands context from the full file and keeps old/new numbering consistent', () => {
    const fullLines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
    const rows = buildRows({ diff, viewMode: 'unified', comments: [], editor: null, expansions: { 1: { top: 2, bottom: 3, all: false } }, fullLines });
    const expanded = rows.filter((r) => r.kind === 'line' && r.expanded);
    expect(expanded.map((r) => (r.kind === 'line' ? [r.line.oldLineNo, r.line.newLineNo, r.line.content] : null))).toEqual([
      [13, 14, 'L14'],
      [14, 15, 'L15'],
      [27, 28, 'L28'],
      [28, 29, 'L29'],
      [29, 30, 'L30'],
    ]);
    const gap = rows.find((r) => r.kind === 'gap' && r.gap.index === 1);
    expect(gap && gap.kind === 'gap' ? gap.hidden : null).toBe(17 - 5);
    const all = buildRows({ diff, viewMode: 'unified', comments: [], editor: null, expansions: { 1: { top: 0, bottom: 0, all: true } }, fullLines });
    expect(all.some((r) => r.kind === 'gap' && r.gap.index === 1)).toBe(false);
    // trailing gap: 40 lines total, last hunk ends at 32 -> 8 hidden
    const tail = all.find((r) => r.kind === 'gap' && r.gap.index === 2);
    expect(tail && tail.kind === 'gap' ? tail.hidden : null).toBe(8);
  });

  it('places the editor row after the selection end', () => {
    const rows = buildRows({ diff, viewMode: 'unified', comments: [], editor: { side: 'old', startLine: 11, endLine: 11 }, expansions: {}, fullLines: null });
    const idx = findRowIndex(rows, 'old', 11);
    expect(rows[idx + 1]).toMatchObject({ kind: 'editor', side: 'old', startLine: 11, endLine: 11 });
  });

  it('skips orphaned comments and files without expandable gaps', () => {
    const rows = buildRows({ diff, viewMode: 'unified', comments: [{ ...comment, status: 'orphaned' }], editor: null, expansions: {}, fullLines: null });
    expect(rows.some((r) => r.kind === 'comments')).toBe(false);
    const added = buildRows({ diff: { ...diff, status: 'added' }, viewMode: 'unified', comments: [], editor: null, expansions: {}, fullLines: null });
    expect(added.some((r) => r.kind === 'gap')).toBe(false);
  });
});
