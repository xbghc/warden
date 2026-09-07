import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, unquotePath } from './diffparse.js';

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
\\ No newline at end of file
`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file with two hunks', () => {
    const files = parseUnifiedDiff(MODIFIED);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('src/a.ts');
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    expect(f.binary).toBe(false);
    expect(f.hunks).toHaveLength(2);
    const h = f.hunks[0]!;
    expect(h.header).toBe('function foo() {');
    expect(h.oldStart).toBe(1);
    expect(h.newLines).toBe(5);
    expect(h.lines.map((l) => [l.type, l.oldLineNo, l.newLineNo])).toEqual([
      ['context', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ]);
    // blank context line (no leading space) tolerated
    expect(h.lines[5]!.content).toBe('');
    const h2 = f.hunks[1]!;
    expect(h2.lines[h2.lines.length - 1]!.noNewline).toBe(true);
    expect(h.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(f.contentHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('parses added, deleted, renamed, binary and mode changes', () => {
    const text = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..587be6b
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+x
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 587be6b..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/img.png b/img.png
index 1234567..89abcde 100644
Binary files a/img.png and b/img.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git a/r2.ts b/r3.ts
similarity index 90%
rename from r2.ts
rename to r3.ts
index 1..2 100644
--- a/r2.ts
+++ b/r3.ts
@@ -1,2 +1,2 @@
 a
-b
+c
`;
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.oldPath, f.status, f.binary])).toEqual([
      ['new.txt', undefined, 'added', false],
      ['gone.txt', undefined, 'deleted', false],
      ['new name.txt', 'old name.txt', 'renamed', false],
      ['img.png', undefined, 'modified', true],
      ['run.sh', undefined, 'modified', false],
      ['r3.ts', 'r2.ts', 'renamed', false],
    ]);
    expect(files[4]).toMatchObject({ oldMode: '100644', newMode: '100755' });
    expect(files[5]!.additions).toBe(1);
    expect(files[0]!.hunks[0]!.lines[0]).toEqual({ type: 'add', newLineNo: 1, content: 'x' });
  });

  it('decodes quoted paths', () => {
    expect(unquotePath('"a/caf\\303\\251.txt"')).toBe('a/café.txt');
    expect(unquotePath('"x\\ty\\"z"')).toBe('x\ty"z');
    expect(unquotePath('plain')).toBe('plain');
    const files = parseUnifiedDiff(`diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
new file mode 100644
--- /dev/null
+++ "b/caf\\303\\251.txt"
@@ -0,0 +1 @@
+hi
`);
    expect(files[0]!.path).toBe('café.txt');
  });

  it('returns empty list for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('content hash is stable for same content and differs when content changes', () => {
    const a = parseUnifiedDiff(MODIFIED)[0]!.contentHash;
    const b = parseUnifiedDiff(MODIFIED.replace('index 1111111..2222222', 'index 3333333..4444444'))[0]!.contentHash;
    const c = parseUnifiedDiff(MODIFIED.replace('+const c = 4;', '+const c = 5;'))[0]!.contentHash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
