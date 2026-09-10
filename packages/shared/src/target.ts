import type { TargetKey } from './types.js';

export type Target = (
  | { kind: 'working' }
  | { kind: 'staged' }
  | { kind: 'all' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: string; head: string }
  /** Everything since the branch forked off `ref`: merge-base(ref, HEAD) against the working tree. */
  | { kind: 'base'; ref: string }
) & {
  /** Absolute path of the worktree this target refers to (undefined = main repo). */
  worktree?: string;
};

export class TargetKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetKeyError';
  }
}

/** A ref is acceptable when it can't be mistaken for a git option or contain shell-ish junk. */
export function isValidRef(ref: string): boolean {
  if (!ref || ref.length > 256) return false;
  if (ref.startsWith('-') || ref.startsWith('.')) return false;
  if (/[\s\0]/.test(ref)) return false;
  if (ref.includes('..')) return false;
  return true;
}

function parseSuffix(rest: string): Target {
  if (rest === 'working' || rest === 'staged' || rest === 'all') return { kind: rest };
  if (rest.startsWith('commit:')) {
    const sha = rest.slice('commit:'.length);
    if (!isValidRef(sha)) throw new TargetKeyError(`invalid commit ref: ${sha}`);
    return { kind: 'commit', sha };
  }
  if (rest.startsWith('base:')) {
    const ref = rest.slice('base:'.length);
    if (!isValidRef(ref)) throw new TargetKeyError(`invalid base ref: ${ref}`);
    return { kind: 'base', ref };
  }
  if (rest.startsWith('range:')) {
    const spec = rest.slice('range:'.length);
    const idx = spec.indexOf('..');
    if (idx <= 0) throw new TargetKeyError(`invalid range: ${spec}`);
    const base = spec.slice(0, idx);
    const head = spec.slice(idx + 2);
    if (!isValidRef(base) || !isValidRef(head)) throw new TargetKeyError(`invalid range refs: ${spec}`);
    return { kind: 'range', base, head };
  }
  throw new TargetKeyError(`unknown target key: ${rest}`);
}

export function parseTargetKey(key: TargetKey): Target {
  if (typeof key !== 'string' || !key) throw new TargetKeyError('empty target key');
  if (key.startsWith('worktree:')) {
    const rest = key.slice('worktree:'.length);
    const m = /^(.+):(working|staged|all|commit:.+|range:.+|base:.+)$/.exec(rest);
    if (!m?.[1] || !m[2]) throw new TargetKeyError(`invalid worktree target key: ${key}`);
    const worktree = m[1];
    if (!worktree.startsWith('/')) throw new TargetKeyError(`worktree path must be absolute: ${worktree}`);
    return { ...parseSuffix(m[2]), worktree };
  }
  return parseSuffix(key);
}

export function formatTargetKey(t: Target): TargetKey {
  let suffix: string;
  switch (t.kind) {
    case 'working':
    case 'staged':
    case 'all':
      suffix = t.kind;
      break;
    case 'commit':
      suffix = `commit:${t.sha}`;
      break;
    case 'range':
      suffix = `range:${t.base}..${t.head}`;
      break;
    case 'base':
      suffix = `base:${t.ref}`;
      break;
  }
  return t.worktree ? `worktree:${t.worktree}:${suffix}` : suffix;
}

export function targetLabel(t: Target): string {
  let label: string;
  switch (t.kind) {
    case 'working':
      label = 'Working tree';
      break;
    case 'staged':
      label = 'Staged';
      break;
    case 'all':
      label = 'Working tree vs HEAD';
      break;
    case 'commit':
      label = `Commit ${t.sha.length > 12 ? t.sha.slice(0, 8) : t.sha}`;
      break;
    case 'range':
      label = `${t.base}..${t.head}`;
      break;
    case 'base':
      label = `Branch vs ${t.ref}`;
      break;
  }
  if (t.worktree) {
    const name = t.worktree.split('/').filter(Boolean).pop() ?? t.worktree;
    return `[${name}] ${label}`;
  }
  return label;
}

/** Try to parse a key; returns undefined on failure. */
export function tryParseTargetKey(key: string): Target | undefined {
  try {
    return parseTargetKey(key);
  } catch {
    return undefined;
  }
}

/**
 * Working tree / index views of one worktree, as opposed to a commit, a range or a `base` target.
 * `base` reads the working tree too, but it is not local: comments there must survive the commits
 * an agent makes while the branch is under review, so it keeps its own pool instead of the shared one.
 */
export function isLocalTarget(t: Target): boolean {
  return t.kind === 'working' || t.kind === 'staged' || t.kind === 'all';
}

/**
 * State key under which the comments of `key` live. The three local views of a worktree share a
 * single scope so a comment survives `git add` (it moves between views instead of being orphaned).
 * Commit, range and base targets keep their own key. Scope keys are state indices only — never targets,
 * so they are deliberately not parseable by `parseTargetKey`.
 */
export function commentScopeKey(key: TargetKey): TargetKey {
  const t = tryParseTargetKey(key);
  if (!t || !isLocalTarget(t)) return key;
  return t.worktree ? `worktree:${t.worktree}:local` : 'local';
}

export type StageMode = 'stage' | 'unstage';

/**
 * What staging means in a view, or undefined where it means nothing. `working` diffs the index
 * against the working tree, so its hunks can be moved into the index; `staged` shows what is in
 * the index, so its hunks can be taken back out. `all` mixes the two and a commit is history.
 */
export function stageModeFor(t: Target): StageMode | undefined {
  if (t.kind === 'working') return 'stage';
  if (t.kind === 'staged') return 'unstage';
  return undefined;
}

/** The local view keys of the same worktree as `key`, in reanchor-candidate order. */
export function localViewKeys(key: TargetKey): TargetKey[] {
  const t = tryParseTargetKey(key);
  const wt = t?.worktree ? { worktree: t.worktree } : {};
  return [formatTargetKey({ kind: 'working', ...wt }), formatTargetKey({ kind: 'staged', ...wt }), formatTargetKey({ kind: 'all', ...wt })];
}
