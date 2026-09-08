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

export type Row =
  | { key: string; kind: 'gap'; gap: Gap; hidden: number | null }
  | { key: string; kind: 'hunk'; hunkIndex: number; hunk: Hunk }
  | { key: string; kind: 'line'; line: DiffLine; hunkIndex: number; expanded: boolean }
  | { key: string; kind: 'pair'; left?: DiffLine; right?: DiffLine; hunkIndex: number; expanded: boolean };

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

/** Pair del/add runs for side-by-side display. */
function pairLines(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
  const out: { left?: DiffLine; right?: DiffLine }[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) out.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.type === 'del') dels.push(l);
    else if (l.type === 'add') adds.push(l);
    else {
      flush();
      out.push({ left: l, right: l });
    }
  }
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

  const emitLines = (lines: DiffLine[], hunkIndex: number, expanded: boolean) => {
    if (viewMode === 'unified') {
      for (const l of lines) {
        rows.push({ key: `l:${hunkIndex}:${l.oldLineNo ?? '-'}:${l.newLineNo ?? '-'}`, kind: 'line', line: l, hunkIndex, expanded });
      }
    } else {
      for (const p of pairLines(lines)) {
        rows.push({ key: `p:${hunkIndex}:${p.left?.oldLineNo ?? '-'}:${p.right?.newLineNo ?? '-'}`, kind: 'pair', left: p.left, right: p.right, hunkIndex, expanded });
      }
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
