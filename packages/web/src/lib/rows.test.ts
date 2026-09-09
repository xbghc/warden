import { describe, expect, it } from 'vitest';
import type { FileDiff, Hunk } from '@warden/shared';
import { buildRows, computeGaps, findRowIndex, pickedLineIndices } from './rows';

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
  it('unified: gap, hunk and line rows in order; comments never interrupt the code', () => {
    const rows = buildRows({ diff, viewMode: 'unified', expansions: {}, fullLines: null });
    expect(rows.map((r) => r.kind)).toEqual(['gap', 'hunk', 'line', 'line', 'line', 'line', 'line', 'gap', 'hunk', 'line', 'line', 'gap']);
    const idx = findRowIndex(rows, 'new', 12);
    expect(rows[idx]).toMatchObject({ kind: 'line', line: { newLineNo: 12, content: 'B2' } });
    expect(findRowIndex(rows, 'old', 11)).toBe(3);
    expect(findRowIndex(rows, 'new', 999)).toBe(-1);
  });

  it('split: pairs del/add runs', () => {
    const rows = buildRows({ diff, viewMode: 'split', expansions: {}, fullLines: null });
    const pairs = rows.filter((r) => r.kind === 'pair');
    expect(pairs.map((p) => (p.kind === 'pair' ? [p.left?.content, p.right?.content] : null))).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      [undefined, 'B2'],
      ['c', 'c'],
      ['x', 'x'],
      [undefined, 'y'],
    ]);
    expect(rows[findRowIndex(rows, 'new', 12)]).toMatchObject({ kind: 'pair', right: { newLineNo: 12 } });
  });

  it('expands context from the full file and keeps old/new numbering consistent', () => {
    const fullLines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
    const rows = buildRows({ diff, viewMode: 'unified', expansions: { 1: { top: 2, bottom: 3, all: false } }, fullLines });
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
    const all = buildRows({ diff, viewMode: 'unified', expansions: { 1: { top: 0, bottom: 0, all: true } }, fullLines });
    expect(all.some((r) => r.kind === 'gap' && r.gap.index === 1)).toBe(false);
    // trailing gap: 40 lines total, last hunk ends at 32 -> 8 hidden
    const tail = all.find((r) => r.kind === 'gap' && r.gap.index === 2);
    expect(tail && tail.kind === 'gap' ? tail.hidden : null).toBe(8);
  });

  it('maps picked rows back to the changed lines of the hunk in either layout', () => {
    // Hunk 0 lines: 0 ctx a, 1 del b, 2 add B, 3 add B2, 4 ctx c.
    const unified = buildRows({ diff, viewMode: 'unified', expansions: {}, fullLines: null });
    expect(unified.filter((r) => r.kind === 'line' && r.hunkIndex === 0).map((r) => (r.kind === 'line' ? [r.pos, r.indices] : null))).toEqual([
      [0, []],
      [1, [1]],
      [2, [2]],
      [3, [3]],
      [4, []],
    ]);
    expect(pickedLineIndices(unified, 0, 3, 1)).toEqual([1, 2, 3]);
    expect(pickedLineIndices(unified, 0, 0, 0)).toEqual([]);
    // Split: the pair (b | B) is one row, so picking it picks both lines; the next row is B2 alone.
    const split = buildRows({ diff, viewMode: 'split', expansions: {}, fullLines: null });
    expect(split.filter((r) => r.kind === 'pair' && r.hunkIndex === 0).map((r) => (r.kind === 'pair' ? [r.pos, r.indices] : null))).toEqual([
      [0, []],
      [1, [1, 2]],
      [2, [3]],
      [3, []],
    ]);
    expect(pickedLineIndices(split, 0, 1, 1)).toEqual([1, 2]);
    expect(pickedLineIndices(split, 0, 2, 3)).toEqual([3]);
    // Expanded context has no position, so it can never be picked.
    const fullLines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
    const expanded = buildRows({ diff, viewMode: 'unified', expansions: { 1: { top: 2, bottom: 0, all: false } }, fullLines });
    expect(expanded.filter((r) => r.kind === 'line' && r.expanded).every((r) => r.kind === 'line' && r.pos === -1 && r.indices.length === 0)).toBe(true);
  });

  it('added/deleted files have no expandable gaps', () => {
    const added = buildRows({ diff: { ...diff, status: 'added' }, viewMode: 'unified', expansions: {}, fullLines: null });
    expect(added.some((r) => r.kind === 'gap')).toBe(false);
  });
});
