import { describe, expect, it } from 'vitest';
import type { Comment } from '@warden/shared';
import { parseUnifiedDiff } from './diffparse.js';
import { buildAnchor, reanchorComment } from './anchor.js';

function diffOf(lines: string[], opts: { oldStart?: number; newStart?: number } = {}) {
  const oldStart = opts.oldStart ?? 1;
  const newStart = opts.newStart ?? 1;
  const oldCount = lines.filter((l) => !l.startsWith('+')).length;
  const newCount = lines.filter((l) => !l.startsWith('-')).length;
  const text = [
    'diff --git a/f.ts b/f.ts',
    'index 1..2 100644',
    '--- a/f.ts',
    '+++ b/f.ts',
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...lines,
    '',
  ].join('\n');
  return parseUnifiedDiff(text)[0]!;
}

function makeComment(diff: ReturnType<typeof diffOf>, side: 'old' | 'new', start: number, end: number): Comment {
  const a = buildAnchor(diff, side, start, end)!;
  expect(a).toBeDefined();
  return {
    id: 'c1',
    targetKey: 'working',
    filePath: 'f.ts',
    side,
    startLine: a.startLine,
    endLine: a.endLine,
    codeSnippet: a.snippet,
    body: 'hi',
    status: 'active',
    anchor: a.anchor,
    createdAt: 't',
    updatedAt: 't',
  };
}

const BASE = [' a', ' b', '-old1', '+new1', '+new2', ' c', ' d', ' e', ' f', ' g'];

describe('buildAnchor', () => {
  it('builds anchor for new-side range', () => {
    const d = diffOf(BASE);
    const a = buildAnchor(d, 'new', 3, 4)!;
    expect(a.snippet).toEqual(['new1', 'new2']);
    expect(a.anchor.lineHashes).toHaveLength(2);
    expect(a.anchor.contextBefore).toHaveLength(2); // a, b
    expect(a.anchor.contextAfter).toHaveLength(3); // c, d, e
    expect(a.anchor.hunkLineOffset).toBe(2);
    expect(a.anchor.hunkHash).toBe(d.hunks[0]!.hash);
  });
  it('rejects ranges not present on the side', () => {
    const d = diffOf(BASE);
    expect(buildAnchor(d, 'old', 3, 3)).toBeDefined(); // old1
    expect(buildAnchor(d, 'new', 50, 51)).toBeUndefined();
  });
  it('rejects ranges spanning hunks', () => {
    const text = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,2 +10,2 @@
 x
-y
+Y
`;
    const d = parseUnifiedDiff(text)[0]!;
    expect(buildAnchor(d, 'new', 2, 10)).toBeUndefined();
  });
});

describe('reanchorComment', () => {
  it('keeps the comment where the hunk is unchanged', () => {
    const d = diffOf(BASE);
    const c = makeComment(d, 'new', 3, 4);
    const r = reanchorComment(c, d);
    expect(r).toBe(c);
  });

  it('follows the code when unrelated lines are added above (hunk content changed)', () => {
    const d1 = diffOf(BASE);
    const c = makeComment(d1, 'new', 3, 4);
    // Agent added 2 lines at the top of the same hunk -> hunk hash changes, lines shift by 2.
    const d2 = diffOf(['+top1', '+top2', ...BASE]);
    const r = reanchorComment(c, d2);
    expect(r.status).toBe('active');
    expect(r.startLine).toBe(5);
    expect(r.endLine).toBe(6);
    expect(r.codeSnippet).toEqual(['new1', 'new2']);
  });

  it('follows the code when the hunk moves (same hash, different line numbers)', () => {
    const d1 = diffOf(BASE);
    const c = makeComment(d1, 'new', 3, 4);
    const d2 = diffOf(BASE, { oldStart: 41, newStart: 41 });
    const r = reanchorComment(c, d2);
    expect(r.status).toBe('active');
    expect(r.startLine).toBe(43);
    expect(r.endLine).toBe(44);
  });

  it('becomes orphaned when the commented lines themselves changed', () => {
    const d1 = diffOf(BASE);
    const c = makeComment(d1, 'new', 3, 4);
    const d2 = diffOf(BASE.map((l) => (l === '+new1' ? '+changed' : l)));
    const r = reanchorComment(c, d2);
    expect(r.status).toBe('orphaned');
    expect(r.startLine).toBe(3);
    expect(r.codeSnippet).toEqual(['new1', 'new2']);
  });

  it('becomes orphaned when the file is gone', () => {
    const d1 = diffOf(BASE);
    const c = makeComment(d1, 'new', 3, 4);
    expect(reanchorComment(c, undefined).status).toBe('orphaned');
  });

  it('uses context to disambiguate duplicate lines', () => {
    const lines = [' a', '+dup', ' b', ' c', ' d', '+dup', ' e', ' f', ' g'];
    const d1 = diffOf(lines);
    const c = makeComment(d1, 'new', 6, 6); // second dup (after d)
    expect(c.codeSnippet).toEqual(['dup']);
    // Insert a line at top so the hunk hash changes and both dups shift.
    const d2 = diffOf(['+zzz', ...lines]);
    const r = reanchorComment(c, d2);
    expect(r.status).toBe('active');
    expect(r.startLine).toBe(7);
  });

  it('orphans when duplicates cannot be disambiguated', () => {
    const lines = [' a', '+dup', ' b', ' c', '+dup', ' b', ' c'];
    const d1 = diffOf(lines);
    const c = makeComment(d1, 'new', 5, 5);
    const d2 = diffOf(['+zzz', ' a', '+dup', ' b', ' c', ' q', '+dup', ' b', ' c', ' q']);
    // Both candidates: before-context differs only partially; second has 'q' after... keep them symmetric:
    const d3 = diffOf(['+zzz', ' q', '+dup', ' b', ' c', ' q', '+dup', ' b', ' c']);
    void d2;
    const r = reanchorComment(c, d3);
    expect(r.status).toBe('orphaned');
  });

  it('restores exported status when re-attached', () => {
    const d1 = diffOf(BASE);
    const c = { ...makeComment(d1, 'new', 3, 4), status: 'orphaned' as const, exportedAt: 'x' };
    const r = reanchorComment(c, d1);
    expect(r.status).toBe('exported');
  });

  it('handles old-side comments', () => {
    const d1 = diffOf(BASE);
    const c = makeComment(d1, 'old', 3, 3);
    expect(c.codeSnippet).toEqual(['old1']);
    const d2 = diffOf(['+top', ...BASE]);
    const r = reanchorComment(c, d2);
    expect(r.status).toBe('active');
    expect(r.startLine).toBe(3); // old side unchanged
  });
});
