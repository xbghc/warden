import type { DiffLine, FileDiff, Hunk, HunkSelection, StageMode } from '@warden/shared';
import { badRequest } from './errors.js';

/**
 * Quote a path for a diff header the way git does (C-style, octal escapes for the bytes of
 * non-ASCII characters). Git itself leaves a space bare and relies on the reader to work out
 * where the name ends; quoting it too keeps every header unambiguous, and `git apply` unquotes
 * both forms.
 */
export function quotePath(p: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point; git quotes exactly these
  if (!/[\s"\\\x00-\x1f\x7f]|[^\x00-\x7f]/.test(p)) return p;
  let out = '"';
  for (const byte of Buffer.from(p, 'utf8')) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += '\\\\';
    else if (byte === 0x0a) out += '\\n';
    else if (byte === 0x09) out += '\\t';
    else if (byte < 0x20 || byte >= 0x7f) out += '\\' + byte.toString(8).padStart(3, '0');
    else out += String.fromCharCode(byte);
  }
  return out + '"';
}

export interface StagePatch {
  patch: string;
  /** Changed lines the patch carries. */
  lines: number;
}

interface OutLine {
  ch: ' ' | '+' | '-';
  content: string;
  noNewline: boolean;
}

/**
 * A hunk cut down to the picked lines, in the form `git add -p`'s edit mode asks for. The other
 * changed lines have to disappear without leaving a trace on the side the patch is applied to:
 * when staging, the index is the old side, so an unpicked deletion is still there (context) and
 * an unpicked addition is not (dropped); when unstaging the index is the new side and it is the
 * other way round.
 */
function cutHunk(hunk: Hunk, picked: Set<number>, mode: StageMode): OutLine[] {
  const out: OutLine[] = [];
  hunk.lines.forEach((l: DiffLine, i: number) => {
    const noNewline = !!l.noNewline;
    if (l.type === 'context') out.push({ ch: ' ', content: l.content, noNewline });
    else if (picked.has(i)) out.push({ ch: l.type === 'add' ? '+' : '-', content: l.content, noNewline });
    else if ((l.type === 'del') === (mode === 'stage')) out.push({ ch: ' ', content: l.content, noNewline });
  });
  // "\ No newline at end of file" belongs to the last line of a side; a cut that leaves lines of
  // that side after it would read as those lines glued onto the end of the previous one.
  out.forEach((l, j) => {
    if (!l.noNewline) return;
    const rest = out.slice(j + 1);
    const ok = l.ch === ' ' ? rest.length === 0 : l.ch === '-' ? rest.every((r) => r.ch === '+') : rest.every((r) => r.ch === '-');
    if (!ok) throw badRequest('the selection splits the missing newline at the end of the file; include the neighbouring changed lines', 'newline_split');
  });
  return out;
}

/** hunk index -> indices of the changed lines picked in it. */
function pickedLines(diff: FileDiff, selection: HunkSelection[] | undefined): Map<number, Set<number>> {
  const picked = new Map<number, Set<number>>();
  const changed = (h: Hunk): number[] => h.lines.map((l, i) => (l.type === 'context' ? -1 : i)).filter((i) => i >= 0);
  if (selection === undefined) {
    for (const [i, h] of diff.hunks.entries()) picked.set(i, new Set(changed(h)));
    return picked;
  }
  if (!Array.isArray(selection)) throw badRequest('hunks must be an array', 'bad_selection');
  for (const sel of selection) {
    if (!sel || !Number.isInteger(sel.index) || sel.index < 0 || sel.index >= diff.hunks.length)
      throw badRequest(`no such hunk: ${sel?.index}`, 'bad_selection');
    const hunk = diff.hunks[sel.index]!;
    const set = picked.get(sel.index) ?? new Set<number>();
    picked.set(sel.index, set);
    if (sel.lines === undefined) {
      for (const i of changed(hunk)) set.add(i);
      continue;
    }
    if (!Array.isArray(sel.lines)) throw badRequest('lines must be an array of indices', 'bad_selection');
    for (const i of sel.lines) {
      if (!Number.isInteger(i) || i < 0 || i >= hunk.lines.length) throw badRequest(`no such line in hunk ${sel.index}: ${i}`, 'bad_selection');
      if (hunk.lines[i]!.type !== 'context') set.add(i);
    }
  }
  return picked;
}

/**
 * The patch that moves the selected lines of `diff` into the index (`stage`) or, applied in
 * reverse, back out of it (`unstage`). No selection means the whole file, mode change and
 * rename included; a selection only ever carries content.
 */
export function buildStagePatch(diff: FileDiff, mode: StageMode, selection?: HunkSelection[]): StagePatch {
  if (diff.binary) throw badRequest('binary files cannot be staged from here; use git add', 'not_stageable');
  const whole = selection === undefined;
  const picked = pickedLines(diff, selection);
  let lines = 0;
  for (const set of picked.values()) lines += set.size;
  const changedTotal = diff.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type !== 'context').length, 0);
  /** Every changed line is in — a hunk-level pick of a one-hunk file counts, not only `whole`. */
  const full = lines === changedTotal;
  const modeChange = !!(diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode);
  const rename = diff.status === 'renamed' && !!diff.oldPath && diff.oldPath !== diff.path;
  const oldPath = diff.oldPath ?? diff.path;
  const newPath = diff.path;

  const gitLine = (a: string, b: string) => `diff --git ${quotePath(`a/${a}`)} ${quotePath(`b/${b}`)}`;
  const from = (p: string | null) => (p === null ? '--- /dev/null' : `--- ${quotePath(`a/${p}`)}`);
  const to = (p: string | null) => (p === null ? '+++ /dev/null' : `+++ ${quotePath(`b/${p}`)}`);
  const header: string[] = [];
  if (diff.status === 'added' && (mode === 'stage' || full)) {
    // The index does not have the file (or, unstaging it whole, will not): the patch creates it.
    header.push(gitLine(newPath, newPath), `new file mode ${diff.newMode ?? '100644'}`);
    if (lines > 0) header.push(from(null), to(newPath));
  } else if (diff.status === 'deleted' && full) {
    header.push(gitLine(oldPath, oldPath), `deleted file mode ${diff.oldMode ?? '100644'}`);
    if (lines > 0) header.push(from(oldPath), to(null));
  } else if (diff.status === 'deleted' && mode === 'unstage') {
    // The index no longer has the file, so there is nothing to put a few lines back into.
    throw badRequest('a staged deletion can only be unstaged as a whole', 'whole_file_only');
  } else if (rename && full) {
    header.push(gitLine(oldPath, newPath));
    if (whole && modeChange) header.push(`old mode ${diff.oldMode}`, `new mode ${diff.newMode}`);
    header.push(`rename from ${quotePath(oldPath)}`, `rename to ${quotePath(newPath)}`);
    if (lines > 0) header.push(from(oldPath), to(newPath));
  } else {
    // A plain edit of the file under its current name — which is also what a slice of a
    // rename, of a deletion or of a staged new file amounts to, seen from the index.
    header.push(gitLine(newPath, newPath));
    if (whole && modeChange) header.push(`old mode ${diff.oldMode}`, `new mode ${diff.newMode}`);
    if (lines > 0) header.push(from(newPath), to(newPath));
  }

  if (lines === 0) {
    const headerOnly = whole && (modeChange || rename || ((diff.status === 'added' || diff.status === 'deleted') && diff.hunks.length === 0));
    if (!headerOnly) throw badRequest('no changed lines selected', 'empty_selection');
    return { patch: header.join('\n') + '\n', lines: 0 };
  }

  // The new-side start of each hunk is where it lands after the hunks before it in *this* patch.
  let delta = 0;
  const hunks: string[] = [];
  diff.hunks.forEach((hunk, index) => {
    const set = picked.get(index);
    if (!set || set.size === 0) return;
    const out = cutHunk(hunk, set, mode);
    const oldLines = out.filter((l) => l.ch !== '+').length;
    const newLines = out.filter((l) => l.ch !== '-').length;
    // Git numbers an empty side by the line before it, so the first line the old side would have
    // is one further on when git wrote a `-N,0`, and a side that is empty here steps back by one.
    const oldBegin = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    const oldStart = oldLines === 0 ? oldBegin - 1 : oldBegin;
    const newStart = newLines === 0 ? oldBegin + delta - 1 : oldBegin + delta;
    delta += newLines - oldLines;
    const text: string[] = [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${hunk.header ? ' ' + hunk.header : ''}`];
    for (const l of out) {
      text.push(l.ch + l.content);
      if (l.noNewline) text.push('\\ No newline at end of file');
    }
    hunks.push(text.join('\n'));
  });

  return { patch: [...header, ...hunks].join('\n') + '\n', lines };
}
