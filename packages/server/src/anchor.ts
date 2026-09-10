import type { Comment, CommentAnchor, CommentSide, FileDiff } from '@warden/shared';
import { lineHash } from './hash.js';

export interface SideLine {
  line: number;
  hash: string;
  content: string;
  hunkIndex: number;
  /** index among the side-lines of the same hunk */
  hunkOffset: number;
}

/** Lines of the diff that exist on the given side, in order. */
export function sideLines(diff: FileDiff, side: CommentSide): SideLine[] {
  const out: SideLine[] = [];
  diff.hunks.forEach((h, hunkIndex) => {
    let hunkOffset = 0;
    for (const l of h.lines) {
      if (side === 'new' && l.type !== 'del' && l.newLineNo !== undefined) {
        out.push({ line: l.newLineNo, hash: lineHash(l.content), content: l.content, hunkIndex, hunkOffset: hunkOffset++ });
      } else if (side === 'old' && l.type !== 'add' && l.oldLineNo !== undefined) {
        out.push({ line: l.oldLineNo, hash: lineHash(l.content), content: l.content, hunkIndex, hunkOffset: hunkOffset++ });
      }
    }
  });
  return out;
}

export interface AnchorResult {
  anchor: CommentAnchor;
  snippet: string[];
  startLine: number;
  endLine: number;
}

const CONTEXT = 3;

function anchorAt(lines: SideLine[], diff: FileDiff, start: number, count: number): AnchorResult {
  const covered = lines.slice(start, start + count);
  const first = covered[0]!;
  const last = covered[covered.length - 1]!;
  return {
    anchor: {
      hunkHash: diff.hunks[first.hunkIndex]!.hash,
      lineHashes: covered.map((l) => l.hash),
      contextBefore: lines.slice(Math.max(0, start - CONTEXT), start).map((l) => l.hash),
      contextAfter: lines.slice(start + count, start + count + CONTEXT).map((l) => l.hash),
      hunkLineOffset: first.hunkOffset,
    },
    snippet: covered.map((l) => l.content),
    startLine: first.line,
    endLine: last.line,
  };
}

/**
 * Build an anchor for the selection [startLine, endLine] on `side`.
 * Returns undefined when the selection isn't fully present on that side or spans multiple hunks.
 */
export function buildAnchor(diff: FileDiff, side: CommentSide, startLine: number, endLine: number): AnchorResult | undefined {
  if (endLine < startLine) [startLine, endLine] = [endLine, startLine];
  const lines = sideLines(diff, side);
  const start = lines.findIndex((l) => l.line === startLine);
  if (start < 0) return undefined;
  const count = endLine - startLine + 1;
  const covered = lines.slice(start, start + count);
  if (covered.length !== count) return undefined;
  for (let i = 0; i < count; i++) {
    const l = covered[i]!;
    if (l.line !== startLine + i) return undefined;
    if (l.hunkIndex !== covered[0]!.hunkIndex) return undefined;
  }
  return anchorAt(lines, diff, start, count);
}

function matchesAt(lines: SideLine[], start: number, hashes: string[]): boolean {
  if (start < 0 || start + hashes.length > lines.length) return false;
  for (let i = 0; i < hashes.length; i++) {
    if (lines[start + i]!.hash !== hashes[i]) return false;
  }
  return true;
}

function contextScore(lines: SideLine[], start: number, count: number, anchor: CommentAnchor): number {
  let score = 0;
  const before = anchor.contextBefore;
  for (let i = 0; i < before.length; i++) {
    const idx = start - before.length + i;
    if (idx >= 0 && lines[idx]!.hash === before[i]) score++;
  }
  const after = anchor.contextAfter;
  for (let i = 0; i < after.length; i++) {
    const idx = start + count + i;
    if (idx < lines.length && lines[idx]!.hash === after[i]) score++;
  }
  return score;
}

/** Locate the anchor in the (possibly changed) diff. Returns the start index in side-lines or undefined. */
export function locateAnchor(diff: FileDiff, side: CommentSide, anchor: CommentAnchor): number | undefined {
  const lines = sideLines(diff, side);
  const n = anchor.lineHashes.length;
  if (n === 0) return undefined;

  // 1. Same hunk still exists -> same relative position.
  for (let hi = 0; hi < diff.hunks.length; hi++) {
    if (diff.hunks[hi]!.hash !== anchor.hunkHash) continue;
    const idx = lines.findIndex((l) => l.hunkIndex === hi && l.hunkOffset === anchor.hunkLineOffset);
    if (idx >= 0 && matchesAt(lines, idx, anchor.lineHashes)) return idx;
  }

  // 2. Search the whole file for the line sequence; disambiguate with context.
  const candidates: number[] = [];
  for (let i = 0; i + n <= lines.length; i++) {
    if (matchesAt(lines, i, anchor.lineHashes)) candidates.push(i);
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  let best: number[] = [];
  let bestScore = -1;
  for (const c of candidates) {
    const s = contextScore(lines, c, n, anchor);
    if (s > bestScore) {
      bestScore = s;
      best = [c];
    } else if (s === bestScore) {
      best.push(c);
    }
  }
  return best.length === 1 ? best[0] : undefined;
}

/**
 * Re-attach a comment to the current diff of its file. `diff` is undefined when the file is
 * no longer part of the target (deleted / reverted) -> orphaned.
 */
export function reanchorComment(comment: Comment, diff: FileDiff | undefined, now = new Date().toISOString()): Comment {
  const orphan = (): Comment => (comment.status === 'orphaned' ? comment : { ...comment, status: 'orphaned', updatedAt: now });
  if (!diff || diff.binary) return orphan();
  const idx = locateAnchor(diff, comment.side, comment.anchor);
  if (idx === undefined) return orphan();
  const lines = sideLines(diff, comment.side);
  const res = anchorAt(lines, diff, idx, comment.anchor.lineHashes.length);
  const status: Comment['status'] = comment.exportedAt ? 'exported' : 'active';
  const unchanged =
    comment.status === status && comment.startLine === res.startLine && comment.endLine === res.endLine && comment.anchor.hunkHash === res.anchor.hunkHash;
  if (unchanged) return comment;
  return {
    ...comment,
    startLine: res.startLine,
    endLine: res.endLine,
    codeSnippet: res.snippet,
    anchor: res.anchor,
    status,
    updatedAt: now,
  };
}
