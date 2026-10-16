import { describe, expect, it } from 'vitest';
import { dirName } from './paths';

describe('dirName', () => {
  it('takes the last segment', () => {
    expect(dirName('/home/me/work/warden')).toBe('warden');
  });

  it('ignores a trailing slash', () => {
    expect(dirName('/home/me/work/warden-2/')).toBe('warden-2');
  });

  it.each(['C:\\work\\中文 project\\', 'C:/work/中文 project/', String.raw`\\server\share\中文 project`])('recognizes Windows path separators in %s', (value) =>
    expect(dirName(value)).toBe('中文 project'),
  );

  it('preserves a literal backslash in a POSIX filename', () => {
    expect(dirName(String.raw`/home/me/back\slash`)).toBe(String.raw`back\slash`);
  });

  it('falls back to the path when there is no segment', () => {
    expect(dirName('/')).toBe('/');
  });
});
