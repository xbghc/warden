import type { DiffLine, FileDiff, FileStatus, Hunk } from '@warden/shared';
import { hunkHash, sha1 } from './hash.js';

/** Decode a git-quoted path ("..." with C escapes, octal bytes for non-ASCII). */
export function unquotePath(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      const buf = Buffer.from(ch, 'utf8');
      for (const b of buf) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      let oct = '';
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && /[0-7]/.test(inner[j]!)) {
        oct += inner[j];
        j++;
      }
      bytes.push(parseInt(oct, 8));
      i = j - 1;
      continue;
    }
    const map: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '\\': 92, '"': 34 };
    bytes.push(map[next] ?? next.charCodeAt(0));
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string {
  const u = unquotePath(p);
  return u.startsWith(prefix) ? u.slice(2) : u;
}

/** Split the remainder of `diff --git a/X b/Y` into the two paths. */
function splitGitHeader(rest: string): { a: string; b: string } {
  if (rest.startsWith('"')) {
    // Quoted form: "a/..." "b/..."
    const m = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
    if (m && m[1] && m[2]) return { a: stripPrefix(m[1], 'a/'), b: stripPrefix(m[2], 'b/') };
  }
  // Prefer an index where both halves are the same path (the common case, robust to spaces).
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== ' ') continue;
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if (left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      return { a: left.slice(2), b: stripPrefix(right, 'b/') };
    }
  }
  const idx = rest.indexOf(' b/');
  if (idx > 0) return { a: stripPrefix(rest.slice(0, idx), 'a/'), b: stripPrefix(rest.slice(idx + 1), 'b/') };
  return { a: rest, b: rest };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

interface Pending {
  a: string;
  b: string;
  oldPath?: string;
  newPath?: string;
  fromMinus?: string;
  fromPlus?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  hunks: Hunk[];
  raw: string[];
}

function finalize(p: Pending): FileDiff {
  let status: FileStatus = 'modified';
  if (p.isNew) status = 'added';
  else if (p.isDeleted) status = 'deleted';
  else if (p.isRename) status = 'renamed';

  let newPath = p.newPath ?? (p.fromPlus && p.fromPlus !== '/dev/null' ? p.fromPlus : undefined) ?? p.b;
  let oldPath = p.oldPath ?? (p.fromMinus && p.fromMinus !== '/dev/null' ? p.fromMinus : undefined) ?? p.a;
  if (status === 'deleted') newPath = oldPath;
  if (status === 'added') oldPath = newPath;

  let additions = 0;
  let deletions = 0;
  for (const h of p.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') additions++;
      else if (l.type === 'del') deletions++;
    }
  }
  const hashInput = [status, oldPath, newPath, p.binary ? 'binary' : 'text', p.oldMode ?? '', p.newMode ?? '', ...p.raw].join('\n');
  const file: FileDiff = {
    path: newPath,
    status,
    additions,
    deletions,
    binary: p.binary,
    contentHash: sha1(hashInput),
    hunks: p.hunks,
  };
  if (status === 'renamed' && oldPath !== newPath) file.oldPath = oldPath;
  if (p.oldMode) file.oldMode = p.oldMode;
  if (p.newMode) file.newMode = p.newMode;
  return file;
}

/**
 * Parse the output of `git diff` (unified format, -M rename detection) into FileDiff objects.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split('\n');
  // git output always ends with a newline -> trailing empty element; drop it.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let cur: Pending | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let lastLine: DiffLine | null = null;

  const flush = () => {
    if (cur) files.push(finalize(cur));
    cur = null;
    hunk = null;
    lastLine = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      flush();
      const { a, b } = splitGitHeader(line.slice('diff --git '.length));
      cur = { a, b, isNew: false, isDeleted: false, isRename: false, binary: false, hunks: [], raw: [] };
      continue;
    }
    if (!cur) continue; // preamble noise
    const c: Pending = cur;

    if (hunk) {
      const ch = line[0];
      if (ch === ' ' || ch === '+' || ch === '-' || line === '') {
        const content = line === '' ? '' : line.slice(1);
        let dl: DiffLine;
        if (ch === '+') dl = { type: 'add', newLineNo: newNo++, content };
        else if (ch === '-') dl = { type: 'del', oldLineNo: oldNo++, content };
        else dl = { type: 'context', oldLineNo: oldNo++, newLineNo: newNo++, content };
        hunk.lines.push(dl);
        lastLine = dl;
        c.raw.push(line);
        continue;
      }
      if (line.startsWith('\\')) {
        if (lastLine) lastLine.noNewline = true;
        c.raw.push(line);
        continue;
      }
      // Anything else terminates the hunk (next header).
      hunk = null;
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      hunk = {
        hash: '',
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        header: hm[5] ?? '',
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      c.hunks.push(hunk);
      c.raw.push(line);
      continue;
    }

    // A name with a space in it gets a tab after it on these two lines (quoted or not), so a
    // reader can tell where the name ends. A tab that is part of a name is quoted, never bare.
    if (line.startsWith('--- ')) {
      c.fromMinus = stripPrefix(line.slice(4).replace(/\t$/, ''), 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      c.fromPlus = stripPrefix(line.slice(4).replace(/\t$/, ''), 'b/');
      continue;
    }
    if (line.startsWith('new file mode ')) {
      c.isNew = true;
      c.newMode = line.slice('new file mode '.length);
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      c.isDeleted = true;
      c.oldMode = line.slice('deleted file mode '.length);
      continue;
    }
    if (line.startsWith('old mode ')) {
      c.oldMode = line.slice('old mode '.length);
      continue;
    }
    if (line.startsWith('new mode ')) {
      c.newMode = line.slice('new mode '.length);
      continue;
    }
    if (line.startsWith('rename from ')) {
      c.isRename = true;
      c.oldPath = unquotePath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      c.isRename = true;
      c.newPath = unquotePath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('copy from ')) {
      c.oldPath = unquotePath(line.slice('copy from '.length));
      continue;
    }
    if (line.startsWith('copy to ')) {
      c.isNew = true;
      c.newPath = unquotePath(line.slice('copy to '.length));
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      c.binary = true;
      c.raw.push(line);
      continue;
    }
    // similarity index / dissimilarity index / index abc..def -> ignore
  }
  flush();

  for (const f of files) {
    for (const h of f.hunks) {
      h.hash = hunkHash(h.lines.map((l) => l.content));
    }
  }
  return files;
}
