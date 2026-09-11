import type { CommitInfo, CommitRef } from '@warden/shared';

const SEP = '\x1f';

/** One commit per line. `%D` is the decoration list `git log --decorate` prints in parentheses. */
export const COMMIT_FORMAT = `%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%P${SEP}%D${SEP}%s`;

/**
 * `%D` reads like `HEAD -> main, tag: v1.2, origin/main`. Tags are told apart and so is where
 * HEAD sits; remote branches are not distinguished from local ones, since git does not either
 * at this level.
 */
export function parseDecorations(raw: string): { refs: CommitRef[]; head: boolean } {
  const refs: CommitRef[] = [];
  let head = false;
  for (const part of raw.split(', ')) {
    const p = part.trim();
    if (!p || p === 'grafted' || p === 'replaced') continue;
    // `origin/HEAD` only ever repeats the remote's default branch listed right beside it.
    if (p.endsWith('/HEAD')) continue;
    if (p === 'HEAD') head = true;
    else if (p.startsWith('HEAD -> ')) {
      head = true;
      // First, whatever git printed it after: the UI reads refs[0] as "the branch HEAD is on".
      refs.unshift({ name: p.slice('HEAD -> '.length), kind: 'branch' });
    } else if (p.startsWith('tag: ')) refs.push({ name: p.slice('tag: '.length), kind: 'tag' });
    else refs.push({ name: p, kind: 'branch' });
  }
  return { refs, head };
}

export function parseCommitLog(stdout: string): CommitInfo[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', shortSha = '', author = '', email = '', date = '', parents = '', decorations = '', ...rest] = line.split(SEP);
      return {
        sha,
        shortSha,
        author,
        email,
        date,
        parents: parents.split(' ').filter(Boolean),
        ...parseDecorations(decorations),
        subject: rest.join(SEP),
      };
    });
}
