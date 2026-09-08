import { describe, expect, it } from 'vitest';
import { commentScopeKey, formatTargetKey, isLocalTarget, parseTargetKey, targetLabel, TargetKeyError } from './target.js';

describe('target keys', () => {
  it('parses simple kinds', () => {
    expect(parseTargetKey('working')).toEqual({ kind: 'working' });
    expect(parseTargetKey('staged')).toEqual({ kind: 'staged' });
    expect(parseTargetKey('all')).toEqual({ kind: 'all' });
  });
  it('parses commit and range', () => {
    expect(parseTargetKey('commit:abc123')).toEqual({ kind: 'commit', sha: 'abc123' });
    expect(parseTargetKey('range:main..HEAD~3')).toEqual({ kind: 'range', base: 'main', head: 'HEAD~3' });
    expect(parseTargetKey('range:@..feature/x')).toEqual({ kind: 'range', base: '@', head: 'feature/x' });
  });
  it('parses base', () => {
    expect(parseTargetKey('base:main')).toEqual({ kind: 'base', ref: 'main' });
    expect(parseTargetKey('base:origin/main')).toEqual({ kind: 'base', ref: 'origin/main' });
    expect(parseTargetKey('worktree:/home/u/a:b/wt:base:main')).toEqual({ kind: 'base', ref: 'main', worktree: '/home/u/a:b/wt' });
    expect(() => parseTargetKey('base:')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('base:-x')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('base:a..b')).toThrow(TargetKeyError);
  });
  it('keeps a base target out of the local comment pool', () => {
    expect(isLocalTarget(parseTargetKey('base:main'))).toBe(false);
    expect(commentScopeKey('base:main')).toBe('base:main');
    expect(commentScopeKey('worktree:/p/q:base:main')).toBe('worktree:/p/q:base:main');
    expect(targetLabel(parseTargetKey('worktree:/p/wt:base:main'))).toBe('[wt] Branch vs main');
  });
  it('parses worktree variants including paths with colons', () => {
    expect(parseTargetKey('worktree:/home/u/wt:working')).toEqual({ kind: 'working', worktree: '/home/u/wt' });
    expect(parseTargetKey('worktree:/home/u/a:b/wt:range:main..dev')).toEqual({
      kind: 'range',
      base: 'main',
      head: 'dev',
      worktree: '/home/u/a:b/wt',
    });
    expect(parseTargetKey('worktree:/x/y:commit:deadbeef')).toEqual({ kind: 'commit', sha: 'deadbeef', worktree: '/x/y' });
  });
  it('rejects option-looking refs and garbage', () => {
    expect(() => parseTargetKey('commit:--output=/tmp/x')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('range:-x..HEAD')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('range:a...b')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('foo')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('worktree:relative:working')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('')).toThrow(TargetKeyError);
  });
  it('round-trips', () => {
    for (const key of ['working', 'commit:abc', 'range:a..b', 'base:main', 'worktree:/p/q:staged', 'worktree:/p/q:range:x..y', 'worktree:/p/q:base:origin/main']) {
      expect(formatTargetKey(parseTargetKey(key))).toBe(key);
    }
  });
});
