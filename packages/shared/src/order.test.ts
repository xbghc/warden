import { describe, expect, it } from 'vitest';
import { insertAfter, moveBefore } from './order.js';

const a = { id: 'a' };
const b = { id: 'b' };
const c = { id: 'c' };
const ids = (xs: { id: string }[] | null) => xs?.map((x) => x.id) ?? null;

describe('list order helpers', () => {
  it('inserts at the top by default and right after a given item', () => {
    expect(ids(insertAfter([a, b], c))).toEqual(['c', 'a', 'b']);
    expect(ids(insertAfter([a, b], c, 'a'))).toEqual(['a', 'c', 'b']);
    expect(ids(insertAfter([a, b], c, 'b'))).toEqual(['a', 'b', 'c']);
    // An item that has since gone: top, not lost.
    expect(ids(insertAfter([a, b], c, 'zzz'))).toEqual(['c', 'a', 'b']);
  });

  it('moves before another item or to the end, and refuses unknown ids', () => {
    expect(ids(moveBefore([a, b, c], 'c', 'a'))).toEqual(['c', 'a', 'b']);
    expect(ids(moveBefore([a, b, c], 'a', null))).toEqual(['b', 'c', 'a']);
    expect(ids(moveBefore([a, b, c], 'a', 'c'))).toEqual(['b', 'a', 'c']);
    expect(ids(moveBefore([a, b, c], 'b', 'b'))).toEqual(['a', 'b', 'c']);
    expect(moveBefore([a, b, c], 'zzz', null)).toBeNull();
    expect(moveBefore([a, b, c], 'a', 'zzz')).toBeNull();
  });
});
