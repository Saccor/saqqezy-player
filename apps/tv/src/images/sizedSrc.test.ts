import { afterEach, describe, expect, it } from 'vitest';
import { coverSize, isSvgUrl, parseSized, setImageScale, sizedSrc } from './sizedSrc.ts';

afterEach(() => setImageScale(1));

describe('sizedSrc / parseSized', () => {
  it('round-trips the URL and the box', () => {
    const s = sizedSrc('http://img.test/p/1.jpg?x=1', 188, 282);
    expect(s).toBe('http://img.test/p/1.jpg?x=1#iptv-px=188x282');
    expect(parseSized(s)).toEqual({ url: 'http://img.test/p/1.jpg?x=1', w: 188, h: 282 });
  });

  it('scales the box to device pixels and rounds it', () => {
    setImageScale(1.5);
    expect(parseSized(sizedSrc('a.png', 101, 60))).toEqual({ url: 'a.png', w: 152, h: 90 });
  });

  it('keeps a fragment the URL already had', () => {
    expect(parseSized(sizedSrc('a.png#frag', 10, 10))).toEqual({ url: 'a.png#frag', w: 10, h: 10 });
  });

  it('leaves empty and untagged sources alone', () => {
    expect(sizedSrc('', 10, 10)).toBe('');
    expect(parseSized('a.png')).toBeUndefined();
    expect(parseSized('a.png#iptv-px=0x5')).toBeUndefined();
    expect(parseSized('a.png#iptv-px=big')).toBeUndefined();
  });

  it('ignores a bad scale', () => {
    setImageScale(Number.NaN);
    expect(sizedSrc('a.png', 10, 20)).toBe('a.png#iptv-px=10x20');
  });
});

describe('coverSize', () => {
  it('shrinks a large poster to the smallest size that still covers its box, at its own aspect', () => {
    expect(coverSize(1000, 1500, 188, 282)).toEqual({ w: 188, h: 282 });
    // A wider image in a poster box: the height decides.
    expect(coverSize(2000, 1500, 188, 282)).toEqual({ w: 376, h: 282 });
  });

  it('never enlarges a small image', () => {
    expect(coverSize(100, 100, 188, 282)).toEqual({ w: 100, h: 100 });
  });

  it('a backdrop covers its wide box', () => {
    expect(coverSize(1920, 1080, 1100, 560)).toEqual({ w: 1100, h: 619 });
  });
});

describe('isSvgUrl', () => {
  it('detects SVGs with a query or a fragment', () => {
    expect(isSvgUrl('http://x.test/a.svg')).toBe(true);
    expect(isSvgUrl('http://x.test/a.SVG?v=2')).toBe(true);
    expect(isSvgUrl('/a.svg#iptv-px=1x1')).toBe(true);
    expect(isSvgUrl('http://x.test/a.png')).toBe(false);
  });
});
