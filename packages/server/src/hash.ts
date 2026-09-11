import { createHash } from 'node:crypto';

export function sha1(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Hash of a single diff line: trailing whitespace is ignored. */
export function lineHash(content: string): string {
  return sha1(content.trimEnd());
}

/** Hash of a hunk: all line contents (without +/-/space prefix), trailing whitespace stripped, joined and trimmed. */
export function hunkHash(lineContents: string[]): string {
  return sha1(
    lineContents
      .map((l) => l.trimEnd())
      .join('\n')
      .trim(),
  );
}
