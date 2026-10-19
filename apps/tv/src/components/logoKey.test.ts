import { describe, expect, test } from 'vitest';
import { logoKey } from './logoKey.ts';

describe('logoKey', () => {
  const usable = (u: string | undefined) => u !== 'https://logos.invalid/bad.png';
  test('the URL is the key; the same URL from a different row object keys the same', () => {
    expect(logoKey('https://logos.invalid/a.png', undefined, usable)).toBe('https://logos.invalid/a.png');
    expect(logoKey(String('https://logos.invalid/a.png'), undefined, usable)).toBe('https://logos.invalid/a.png');
  });
  test('no URL, a URL that failed for this tile, or one the cache rejects: no key', () => {
    expect(logoKey(undefined, undefined, usable)).toBeUndefined();
    expect(logoKey('https://logos.invalid/a.png', 'https://logos.invalid/a.png', usable)).toBeUndefined();
    expect(logoKey('https://logos.invalid/bad.png', undefined, usable)).toBeUndefined();
  });
  test('a failure remembered for another URL does not block this one (the tile is re-used across rows)', () => {
    expect(logoKey('https://logos.invalid/b.png', 'https://logos.invalid/a.png', usable)).toBe('https://logos.invalid/b.png');
  });
});
