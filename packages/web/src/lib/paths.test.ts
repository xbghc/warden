import { describe, expect, it } from 'vitest';
import { dirName } from './paths';

describe('dirName', () => {
  it('takes the last segment', () => {
    expect(dirName('/home/me/work/warden')).toBe('warden');
  });

  it('ignores a trailing slash', () => {
    expect(dirName('/home/me/work/warden-2/')).toBe('warden-2');
  });

  it('falls back to the path when there is no segment', () => {
    expect(dirName('/')).toBe('/');
  });
});
