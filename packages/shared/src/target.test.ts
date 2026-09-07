import { describe, expect, it } from 'vitest';
import { formatTargetKey, parseTargetKey, TargetKeyError } from './target.js';

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
    for (const key of ['working', 'commit:abc', 'range:a..b', 'worktree:/p/q:staged', 'worktree:/p/q:range:x..y']) {
      expect(formatTargetKey(parseTargetKey(key))).toBe(key);
    }
  });
});
