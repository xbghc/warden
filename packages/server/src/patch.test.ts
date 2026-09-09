import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@warden/shared';
import { parseUnifiedDiff } from './diffparse.js';
import { buildStagePatch, quotePath } from './patch.js';

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function foo() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;

@@ -20,3 +21,3 @@
 x
-y
+z
 w
`;

const one = (text: string): FileDiff => parseUnifiedDiff(text)[0]!;
const body = (patch: string) => patch.split('\n').slice(3).join('\n');

describe('buildStagePatch', () => {
  it('stage: an unpicked deletion stays as context, an unpicked addition is dropped', () => {
    const diff = one(MODIFIED);
    // Hunk 0 lines: 0 ctx, 1 del b, 2 add b=3, 3 add c, 4 ctx d, 5 ctx empty.
    const { patch, lines } = buildStagePatch(diff, 'stage', [{ index: 0, lines: [3] }]);
    expect(lines).toBe(1);
    expect(patch).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,4 +1,5 @@ function foo() {',
        ' const a = 1;',
        ' const b = 2;',
        '+const c = 4;',
        ' const d = 5;',
        ' ',
        '',
      ].join('\n'),
    );
  });

  it('unstage: the mirror image — an unpicked addition stays, an unpicked deletion goes', () => {
    const diff = one(MODIFIED);
    const { patch } = buildStagePatch(diff, 'unstage', [{ index: 0, lines: [1] }]);
    expect(body(patch)).toBe(['@@ -1,6 +1,5 @@ function foo() {', ' const a = 1;', '-const b = 2;', ' const b = 3;', ' const c = 4;', ' const d = 5;', ' ', ''].join('\n'));
  });

  it('numbers later hunks by what the earlier ones in the same patch did', () => {
    const diff = one(MODIFIED);
    const both = buildStagePatch(diff, 'stage', [{ index: 0 }, { index: 1 }]);
    expect(both.lines).toBe(5);
    expect(both.patch).toContain('@@ -1,4 +1,5 @@');
    expect(both.patch).toContain('@@ -20,3 +21,3 @@\n x\n-y\n+z\n w\n');
    // Only the second hunk: nothing above it moved, so it starts where the old side does.
    const second = buildStagePatch(diff, 'stage', [{ index: 1 }]);
    expect(second.patch).toContain('@@ -20,3 +20,3 @@');
    expect(second.patch).not.toContain('function foo');
    // Only the replacement out of the first hunk: it does not change the line count, so the
    // second hunk stays put.
    const half = buildStagePatch(diff, 'stage', [{ index: 0, lines: [1, 2] }, { index: 1 }]);
    expect(half.patch).toContain('@@ -1,4 +1,4 @@');
    expect(half.patch).toContain('@@ -20,3 +20,3 @@');
    const whole = buildStagePatch(diff, 'stage');
    expect(whole.patch).toBe(both.patch);
  });

  it('ignores context indices and rejects an empty or out-of-range pick', () => {
    const diff = one(MODIFIED);
    expect(() => buildStagePatch(diff, 'stage', [{ index: 0, lines: [0, 4] }])).toThrow(/no changed lines/);
    expect(() => buildStagePatch(diff, 'stage', [{ index: 5 }])).toThrow(/no such hunk/);
    expect(() => buildStagePatch(diff, 'stage', [{ index: 0, lines: [99] }])).toThrow(/no such line/);
    expect(() => buildStagePatch(diff, 'stage', [])).toThrow(/no changed lines/);
    expect(() => buildStagePatch({ ...diff, binary: true }, 'stage')).toThrow(/binary/);
  });

  it('a new file is created with the picked lines only; unstaging it whole removes it', () => {
    const diff = one(['diff --git a/n.ts b/n.ts', 'new file mode 100755', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,3 @@', '+one', '+two', '+three', ''].join('\n'));
    const part = buildStagePatch(diff, 'stage', [{ index: 0, lines: [0, 2] }]);
    expect(part.patch).toBe(['diff --git a/n.ts b/n.ts', 'new file mode 100755', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,2 @@', '+one', '+three', ''].join('\n'));
    const gone = buildStagePatch(diff, 'unstage');
    expect(gone.patch).toContain('new file mode 100755\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,3 @@');
    // Taking a few lines out of a staged new file leaves a shorter file in the index.
    const shorter = buildStagePatch(diff, 'unstage', [{ index: 0, lines: [1] }]);
    expect(shorter.patch).toBe(['diff --git a/n.ts b/n.ts', '--- a/n.ts', '+++ b/n.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three', ''].join('\n'));
  });

  it('a deletion is staged whole or in part, but only unstaged whole', () => {
    const diff = one(['diff --git a/d.ts b/d.ts', 'deleted file mode 100644', '--- a/d.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n'));
    expect(buildStagePatch(diff, 'stage').patch).toBe(['diff --git a/d.ts b/d.ts', 'deleted file mode 100644', '--- a/d.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n'));
    // Same thing picked hunk by hunk: still a deletion, not an edit down to nothing.
    expect(buildStagePatch(diff, 'stage', [{ index: 0 }]).patch).toContain('deleted file mode');
    expect(buildStagePatch(diff, 'stage', [{ index: 0, lines: [0] }]).patch).toBe(['diff --git a/d.ts b/d.ts', '--- a/d.ts', '+++ b/d.ts', '@@ -1,2 +1,1 @@', '-one', ' two', ''].join('\n'));
    expect(buildStagePatch(diff, 'unstage').patch).toContain('deleted file mode');
    expect(() => buildStagePatch(diff, 'unstage', [{ index: 0, lines: [0] }])).toThrow(/as a whole/);
  });

  it('carries a rename and a mode change only for the whole file', () => {
    const diff = one(
      ['diff --git a/old.sh b/new.sh', 'old mode 100644', 'new mode 100755', 'similarity index 90%', 'rename from old.sh', 'rename to new.sh', '--- a/old.sh', '+++ b/new.sh', '@@ -1,2 +1,2 @@', ' #!/bin/sh', '-echo a', '+echo b', ''].join('\n'),
    );
    expect(buildStagePatch(diff, 'stage').patch).toBe(
      ['diff --git a/old.sh b/new.sh', 'old mode 100644', 'new mode 100755', 'rename from old.sh', 'rename to new.sh', '--- a/old.sh', '+++ b/new.sh', '@@ -1,2 +1,2 @@', ' #!/bin/sh', '-echo a', '+echo b', ''].join('\n'),
    );
    // Unstaging the added line alone leaves the deletion staged: the index ends up with the shebang only.
    expect(buildStagePatch(diff, 'unstage', [{ index: 0, lines: [2] }]).patch).toBe(['diff --git a/new.sh b/new.sh', '--- a/new.sh', '+++ b/new.sh', '@@ -1,1 +1,2 @@', ' #!/bin/sh', '+echo b', ''].join('\n'));
    const modeOnly = one(['diff --git a/x.sh b/x.sh', 'old mode 100644', 'new mode 100755', ''].join('\n'));
    expect(buildStagePatch(modeOnly, 'stage').patch).toBe('diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n');
    expect(() => buildStagePatch(modeOnly, 'stage', [])).toThrow(/no changed lines/);
  });

  it('keeps "no newline" markers on the last line of a side and refuses cuts that would move them', () => {
    const diff = one(['diff --git a/e b/e', '--- a/e', '+++ b/e', '@@ -1,2 +1,3 @@', ' k', '-a', '\\ No newline at end of file', '+a', '+b', '\\ No newline at end of file', ''].join('\n'));
    // Lines: 0 ctx k, 1 del a (nonl), 2 add a, 3 add b (nonl).
    expect(buildStagePatch(diff, 'stage').patch).toContain('-a\n\\ No newline at end of file\n+a\n+b\n\\ No newline at end of file\n');
    // Picking only the last addition would turn "a" into context with no newline, then add "b" after it.
    expect(() => buildStagePatch(diff, 'stage', [{ index: 0, lines: [3] }])).toThrow(/newline/);
    // Picking the deletion and the first addition leaves "b" out: the new side now ends with a newline.
    expect(buildStagePatch(diff, 'stage', [{ index: 0, lines: [1, 2] }]).patch).toContain('@@ -1,2 +1,2 @@\n k\n-a\n\\ No newline at end of file\n+a\n');
    // Unstaging just "b": "a" stays as context, and "b" is the last line of the new side.
    expect(buildStagePatch(diff, 'unstage', [{ index: 0, lines: [3] }]).patch).toContain('@@ -1,2 +1,3 @@\n k\n a\n+b\n\\ No newline at end of file\n');
  });

  it('quotes paths the way git apply reads them', () => {
    expect(quotePath('src/a.ts')).toBe('src/a.ts');
    expect(quotePath('my notes.md')).toBe('"my notes.md"');
    expect(quotePath('sp "q.ts')).toBe('"sp \\"q.ts"');
    expect(quotePath('back\\slash')).toBe('"back\\\\slash"');
    expect(quotePath('文档.md')).toBe('"\\346\\226\\207\\346\\241\\243.md"');
    expect(quotePath('tab\there')).toBe('"tab\\there"');
  });
});
