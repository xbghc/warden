import type { TargetKey } from './types.js';

export type Target = (
  | { kind: 'working' }
  | { kind: 'staged' }
  | { kind: 'all' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: string; head: string }
  /** Exact saved trees in Warden's external snapshot store; no merge-base calculation. */
  | { kind: 'snapshot'; base: string; head: string }
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

// Shared with the browser: Node's host-specific path parser is not available here.
export function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\(?![.?][\\/])[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
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
  if (rest.startsWith('snapshot:')) {
    const match = /^snapshot:([a-f0-9]{40}(?:[a-f0-9]{24})?)\.\.([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(rest);
    if (!match) throw new TargetKeyError('Invalid snapshot target');
    return { kind: 'snapshot', base: match[1]!, head: match[2]! };
  }
  throw new TargetKeyError(`unknown target key: ${rest}`);
}

export function parseTargetKey(key: TargetKey): Target {
  if (typeof key !== 'string' || !key) throw new TargetKeyError('empty target key');
  if (key.startsWith('worktree:')) {
    const rest = key.slice('worktree:'.length);
    const m = /^(.+):(working|staged|all|commit:.+|range:.+|base:.+|snapshot:.+)$/.exec(rest);
    if (!m?.[1] || !m[2]) throw new TargetKeyError(`invalid worktree target key: ${key}`);
    const worktree = m[1];
    if (worktree.includes('\0') || (!worktree.startsWith('/') && !isWindowsAbsolutePath(worktree)))
      throw new TargetKeyError(`worktree path must be absolute: ${worktree}`);
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
    case 'snapshot':
      suffix = `snapshot:${t.base}..${t.head}`;
      break;
    case 'base':
      suffix = `base:${t.ref}`;
      break;
  }
  return t.worktree ? `worktree:${t.worktree}:${suffix}` : suffix;
}

/** Try to parse a key; returns undefined on failure. */
export function tryParseTargetKey(key: string): Target | undefined {
  try {
    return parseTargetKey(key);
  } catch {
    return undefined;
  }
}

/** Working tree / index comparisons, without a separate baseline. */
export function isLocalTarget(t: Target): boolean {
  return t.kind === 'working' || t.kind === 'staged' || t.kind === 'all';
}
