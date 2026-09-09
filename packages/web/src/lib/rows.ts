import type { CommentSide, DiffLine, FileDiff, Hunk, ViewMode } from '@warden/shared';

export interface Gap {
  /** 0 = before the first hunk, i = between hunk i-1 and hunk i, hunks.length = after the last hunk */
  index: number;
  /** first new-side line number of the gap */
  newFrom: number;
  /** last new-side line number of the gap; null when unknown (trailing gap before the file is loaded) */
  newTo: number | null;
  /** old-side line number corresponding to newFrom */
  oldFrom: number;
}

export interface Expansion {
  top: number;
  bottom: number;
  all: boolean;
}

/**
 * A code row also knows where it sits in its hunk: `pos` is its ordinal among the rows of that
 * hunk in the current layout (a line in unified view, a pair in split view) and `indices` are the
 * changed lines of `hunk.lines` it shows — none for context, one for a unified row, up to two for
 * a pair. Staging picks rows, and a pick is turned into line indices through these.
 */
export type Row =
  | { key: string; kind: 'gap'; gap: Gap; hidden: number | null }
  | { key: string; kind: 'hunk'; hunkIndex: number; hunk: Hunk }
  | { key: string; kind: 'line'; line: DiffLine; hunkIndex: number; expanded: boolean; pos: number; indices: number[] }
  | { key: string; kind: 'pair'; left?: DiffLine; right?: DiffLine; hunkIndex: number; expanded: boolean; pos: number; indices: number[] };

export function computeGaps(diff: FileDiff, totalNewLines: number | null): Gap[] {
  const gaps: Gap[] = [];
  const hunks = diff.hunks;
  if (hunks.length === 0) return gaps;
  const first = hunks[0]!;
  gaps.push({ index: 0, newFrom: 1, newTo: first.newStart - 1, oldFrom: 1 });
  for (let i = 1; i < hunks.length; i++) {
    const prev = hunks[i - 1]!;
    const cur = hunks[i]!;
    gaps.push({
      index: i,
      newFrom: prev.newStart + prev.newLines,
      newTo: cur.newStart - 1,
      oldFrom: prev.oldStart + prev.oldLines,
    });
  }
  const last = hunks[hunks.length - 1]!;
  gaps.push({
    index: hunks.length,
    newFrom: last.newStart + last.newLines,
    newTo: totalNewLines,
    oldFrom: last.oldStart + last.oldLines,
  });
  return gaps;
}

function expandedLines(gap: Gap, exp: Expansion | undefined, fullLines: string[] | null): { top: DiffLine[]; bottom: DiffLine[]; hidden: number | null } {
  const empty = { top: [], bottom: [], hidden: gap.newTo === null ? null : Math.max(0, gap.newTo - gap.newFrom + 1) };
  if (!fullLines || !exp) return empty;
  const newTo = gap.newTo ?? fullLines.length;
  const size = Math.max(0, newTo - gap.newFrom + 1);
  if (size === 0) return { top: [], bottom: [], hidden: 0 };
  let top = exp.all ? size : Math.min(size, exp.top);
  let bottom = exp.all ? 0 : Math.min(size - top, exp.bottom);
  if (top + bottom >= size) {
    top = size;
    bottom = 0;
  }
  const offset = gap.oldFrom - gap.newFrom;
  const mk = (n: number): DiffLine => ({ type: 'context', newLineNo: n, oldLineNo: n + offset, content: fullLines[n - 1] ?? '' });
  const topLines: DiffLine[] = [];
  for (let n = gap.newFrom; n < gap.newFrom + top; n++) topLines.push(mk(n));
  const bottomLines: DiffLine[] = [];
  for (let n = newTo - bottom + 1; n <= newTo; n++) bottomLines.push(mk(n));
  return { top: topLines, bottom: bottomLines, hidden: size - top - bottom };
}

/** Pair del/add runs for side-by-side display; `indices` are the positions of the paired lines. */
function pairLines(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine; indices: number[] }[] {
  const out: { left?: DiffLine; right?: DiffLine; indices: number[] }[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const l = dels[i];
      const r = adds[i];
      out.push({
        left: l === undefined ? undefined : lines[l],
        right: r === undefined ? undefined : lines[r],
        indices: [l, r].filter((x): x is number => x !== undefined),
      });
    }
    dels = [];
    adds = [];
  };
  lines.forEach((l, i) => {
    if (l.type === 'del') dels.push(i);
    else if (l.type === 'add') adds.push(i);
    else {
      flush();
      out.push({ left: l, right: l, indices: [] });
    }
  });
  flush();
  return out;
}

export interface BuildRowsInput {
  diff: FileDiff;
  viewMode: ViewMode;
  expansions: Record<number, Expansion>;
  fullLines: string[] | null;
}

/** Rows of the diff column. Comments never interrupt the code: they live in the comment rail. */
export function buildRows({ diff, viewMode, expansions, fullLines }: BuildRowsInput): Row[] {
  const rows: Row[] = [];
  const canExpand = diff.status !== 'deleted' && diff.status !== 'added' && !diff.binary;
  const gaps = canExpand ? computeGaps(diff, fullLines ? fullLines.length : null) : [];

  // Expanded context is borrowed from the full file, not part of any hunk: no position, no lines.
  const emitLines = (lines: DiffLine[], hunkIndex: number, expanded: boolean) => {
    if (viewMode === 'unified') {
      lines.forEach((l, i) => {
        rows.push({
          key: `l:${hunkIndex}:${l.oldLineNo ?? '-'}:${l.newLineNo ?? '-'}`,
          kind: 'line',
          line: l,
          hunkIndex,
          expanded,
          pos: expanded ? -1 : i,
          indices: expanded || l.type === 'context' ? [] : [i],
        });
      });
    } else {
      pairLines(lines).forEach((p, i) => {
        rows.push({
          key: `p:${hunkIndex}:${p.left?.oldLineNo ?? '-'}:${p.right?.newLineNo ?? '-'}`,
          kind: 'pair',
          left: p.left,
          right: p.right,
          hunkIndex,
          expanded,
          pos: expanded ? -1 : i,
          indices: expanded ? [] : p.indices,
        });
      });
    }
  };

  diff.hunks.forEach((hunk, hunkIndex) => {
    const gap = gaps[hunkIndex];
    if (gap) {
      const { top, bottom, hidden } = expandedLines(gap, expansions[gap.index], fullLines);
      if (top.length) emitLines(top, hunkIndex - 1, true);
      if (hidden === null || hidden > 0) rows.push({ key: `g:${gap.index}`, kind: 'gap', gap, hidden });
      if (bottom.length) emitLines(bottom, hunkIndex, true);
    }
    rows.push({ key: `h:${hunkIndex}`, kind: 'hunk', hunkIndex, hunk });
    emitLines(hunk.lines, hunkIndex, false);
  });
  const tail = gaps[diff.hunks.length];
  if (tail) {
    const { top, hidden } = expandedLines(tail, expansions[tail.index], fullLines);
    if (top.length) emitLines(top, diff.hunks.length - 1, true);
    if (hidden === null || hidden > 0) rows.push({ key: `g:${tail.index}`, kind: 'gap', gap: tail, hidden });
  }
  return rows;
}

/** Index of the row that shows `line` on `side`, or -1. */
export function findRowIndex(rows: Row[], side: CommentSide, line: number): number {
  return rows.findIndex((r) => {
    if (r.kind === 'line') return side === 'new' ? r.line.newLineNo === line : r.line.oldLineNo === line;
    if (r.kind === 'pair') return side === 'new' ? r.right?.newLineNo === line : r.left?.oldLineNo === line;
    return false;
  });
}

/** Changed lines (indices into the hunk) shown by the rows of `hunkIndex` whose position lies in [a, b]. */
export function pickedLineIndices(rows: Row[], hunkIndex: number, a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (const r of rows) {
    if ((r.kind !== 'line' && r.kind !== 'pair') || r.hunkIndex !== hunkIndex || r.pos < lo || r.pos > hi) continue;
    out.push(...r.indices);
  }
  return out.sort((x, y) => x - y);
}

export function hunkRowIndices(rows: Row[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === 'hunk') out.push(i);
  });
  return out;
}

export function totalDiffLines(diff: FileDiff): number {
  let n = 0;
  for (const h of diff.hunks) n += h.lines.length;
  return n;
}
