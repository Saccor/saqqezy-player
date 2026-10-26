import { describe, expect, it } from 'vitest';
import { sameData } from './sameData.ts';

describe('sameData', () => {
  it('equal primitives, arrays and nested plain objects compare equal, even as fresh copies', () => {
    expect(sameData(1, 1)).toBe(true);
    expect(sameData('a', 'a')).toBe(true);
    expect(sameData(undefined, undefined)).toBe(true);
    expect(sameData({ a: [1, { b: 'x' }], c: null }, { c: null, a: [1, { b: 'x' }] })).toBe(true);
  });

  it('any difference in value, length, keys or shape is unequal', () => {
    expect(sameData({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameData([1, 2], [1, 2, 3])).toBe(false);
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameData([1], { 0: 1 })).toBe(false);
    expect(sameData(null, {})).toBe(false);
    expect(sameData(undefined, {})).toBe(false);
  });
});
