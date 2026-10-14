import { describe, expect, it } from 'vitest';
import { LogoCache } from './logoCache.ts';

describe('LogoCache', () => {
  it('remembers failed logos and keeps at most max entries (least recently used goes first)', () => {
    const c = new LogoCache(3);
    expect(c.usable('a')).toBe(true);
    c.markFailed('a');
    expect(c.usable('a')).toBe(false);
    c.touch('b');
    c.touch('c');
    c.touch('d');
    expect(c.size()).toBe(3);
    expect(c.usable('a')).toBe(true); // evicted, so it may be tried again
    c.touch('b');
    c.touch('e');
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(false);
    expect(c.usable(undefined)).toBe(false);
    expect(c.usable('')).toBe(false);
  });

  it('defaults to 200 entries', () => {
    const c = new LogoCache();
    for (let i = 0; i < 250; i++) c.touch(`u${i}`);
    expect(c.size()).toBe(200);
  });
});
