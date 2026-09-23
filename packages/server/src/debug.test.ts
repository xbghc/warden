import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diffparse.js';
import { debugLineNumbers, markDebugLines } from './debug.js';

// Markers are put together at run time: written out after a leader, they would mark this file.
const c = (leader: string, marker: string) => `${leader} ${marker}`;
const START = c('//', 'debug:start');
const END = c('//', 'debug:end');

const lines = (set: Set<number>) => [...set].sort((a, b) => a - b);

describe('debugLineNumbers', () => {
  it('takes a block with its markers, and a tagged line on its own', () => {
    const text = ['a', START, 'log(x)', END, 'b', `log(y) ${c('//', 'NOCOMMIT')}`, 'c'].join('\n');
    expect(lines(debugLineNumbers(text))).toEqual([2, 3, 4, 6]);
  });

  it('knows the other spellings and comment leaders', () => {
    const text = [
      c('/*', 'develblock:start */'),
      'x',
      c('/*', 'develblock:end */'),
      c('#', 'Debug:Start'),
      'y',
      c('#', 'debug:end'),
      c('<!--', 'do not commit -->'),
      c('--', '@no-commit'),
    ].join('\n');
    expect(lines(debugLineNumbers(text))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('wants the marker to open a comment', () => {
    const text = ["const s = 'debug:start';", c('//', 'see debug:start above'), 'nocommit()', 'x'].join('\n');
    expect(lines(debugLineNumbers(text))).toEqual([]);
  });

  it('nests blocks, runs an open one to the end, ignores a stray end', () => {
    expect(lines(debugLineNumbers([END, START, START, 'x', END, 'y', END, 'z'].join('\n')))).toEqual([2, 3, 4, 5, 6, 7]);
    expect(lines(debugLineNumbers(['a', START, 'b', 'c'].join('\n')))).toEqual([2, 3, 4]);
  });
});

describe('markDebugLines', () => {
  it('judges added and context lines by the new side, deleted ones by the old side', () => {
    const diff = parseUnifiedDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,3 @@
 keep
-old
+new
 tail
`)[0]!;
    markDebugLines(diff, new Set([10, 11]), new Set([11]));
    const h = diff.hunks[0]!.lines;
    expect(h.map((l) => !!l.debug)).toEqual([true, true, true, false]);
    expect(diff.debugAdditions).toBe(1);
    expect(diff.debugDeletions).toBe(1);
  });
});
