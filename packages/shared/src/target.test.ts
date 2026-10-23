import { describe, expect, it } from 'vitest';
import { formatTargetKey, parseTargetKey, targetLabel, TargetKeyError } from './target.js';

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

  it.each([String.raw`C:\Workspaces\中文 project`, 'D:/Workspaces/project', String.raw`\\server\share\project`])(
    'round-trips every target kind for the Windows absolute path %s',
    (worktree) => {
      for (const suffix of ['working', 'staged', 'all', 'commit:abc123', 'range:main..HEAD', 'base:main']) {
        const key = `worktree:${worktree}:${suffix}`;
        expect(parseTargetKey(key).worktree).toBe(worktree);
        expect(formatTargetKey(parseTargetKey(key))).toBe(key);
      }
      const name = worktree.endsWith('中文 project') ? '中文 project' : 'project';
      expect(targetLabel(parseTargetKey(`worktree:${worktree}:working`))).toBe(`[${name}] Working tree`);
    },
  );

  it.each(['C:relative', String.raw`\relative`, String.raw`\\server`, String.raw`\\.\device`, '/path\0invalid'])(
    'rejects relative, incomplete and device paths: %s',
    (worktree) => expect(() => parseTargetKey(`worktree:${worktree}:working`)).toThrow(TargetKeyError),
  );
  it('rejects option-looking refs and garbage', () => {
    expect(() => parseTargetKey('commit:--output=/tmp/x')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('range:-x..HEAD')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('range:a...b')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('foo')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('worktree:relative:working')).toThrow(TargetKeyError);
    expect(() => parseTargetKey('')).toThrow(TargetKeyError);
  });
  it('round-trips', () => {
    for (const key of [
      'working',
      'commit:abc',
      'range:a..b',
      'base:main',
      'worktree:/p/q:staged',
      'worktree:/p/q:range:x..y',
      'worktree:/p/q:base:origin/main',
    ]) {
      expect(formatTargetKey(parseTargetKey(key))).toBe(key);
    }
  });
});
