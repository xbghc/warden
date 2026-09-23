import type { FileDiff } from '@warden/shared';

/**
 * Debug code the author means to keep out of a commit, marked in a comment. There is no one
 * agreed convention; these are the ones in use: a `NOCOMMIT`-style tag on a single line (what the
 * pre-commit hooks that guard against this look for) and a start / end pair around a block, as
 * webpack-strip-block and gulp-strip-block spell it (`develblock:start`) or shorter (`debug:start`).
 *
 * The marker has to open a comment, right after its `//`, `/*`, `#`, `--`, `<!--`, `;` or `%`, so a
 * word in running prose or an identifier does not count. A string that happens to hold a comment
 * leader and a marker still does; telling the two apart would take a parser per language. (Which
 * is also why this file and its test never write a marker out after a leader.)
 */
const LEADER = String.raw`(?:\/\/+|\/\*+|#+|--|<!--|;+|%+)\s*`;
const BLOCK_START = new RegExp(`${LEADER}(?:debug|develblock):start\\b`, 'i');
const BLOCK_END = new RegExp(`${LEADER}(?:debug|develblock):end\\b`, 'i');
const LINE_TAG = new RegExp(`${LEADER}[@!]?(?:no-?commit|do not commit)\\b`, 'i');

/**
 * Fixed strings, one of which a file must contain to have any debug line at all: `git grep` picks
 * the files worth reading in full with them. An end marker alone marks nothing, so it is not here.
 */
export const DEBUG_MARKER_STRINGS = ['debug:start', 'develblock:start', 'nocommit', 'no-commit', 'do not commit'];

/**
 * 1-based numbers of the lines of `text` that are debug code, markers included. Blocks nest; a
 * block left open runs to the end of the file, since that is what the author has not closed yet,
 * and an end marker with no block open is ignored.
 */
export function debugLineNumbers(text: string): Set<number> {
  const out = new Set<number>();
  const lines = text.split('\n');
  let depth = 0;
  lines.forEach((line, i) => {
    const no = i + 1;
    if (BLOCK_START.test(line)) depth++;
    if (depth > 0 || LINE_TAG.test(line)) out.add(no);
    if (depth > 0 && BLOCK_END.test(line)) depth--;
  });
  return out;
}

/**
 * Flags the lines of `diff` that are debug code and counts the changed ones. An added or context
 * line is judged by the new side of the file, a deleted one by the old side: both are needed, a
 * hunk rarely shows the marker that opened the block its lines are in.
 */
export function markDebugLines(diff: FileDiff, newSide: Set<number> | undefined, oldSide: Set<number> | undefined): void {
  let added = 0;
  let deleted = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const debug = line.type === 'del' ? !!oldSide?.has(line.oldLineNo!) : !!newSide?.has(line.newLineNo!);
      if (!debug) continue;
      line.debug = true;
      if (line.type === 'add') added++;
      else if (line.type === 'del') deleted++;
    }
  }
  if (added) diff.debugAdditions = added;
  if (deleted) diff.debugDeletions = deleted;
}
