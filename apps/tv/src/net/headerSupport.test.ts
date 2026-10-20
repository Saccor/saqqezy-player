import { describe, expect, it } from 'vitest';
import { tvHeaderSupport } from './headerSupport.ts';

describe('tvHeaderSupport', () => {
  const T = { userAgent: true, referrer: true };
  const F = { userAgent: false, referrer: false };
  it('dev browser: all through the dev proxy; production browser: none', () => {
    expect(tvHeaderSupport('browser', true)).toEqual({ lists: T, streams: T });
    expect(tvHeaderSupport('browser', false)).toEqual({ lists: F, streams: F });
  });
  it('TVs never use the dev proxy (it refuses the LAN)', () => {
    expect(tvHeaderSupport('tizen', true)).toEqual({ lists: F, streams: { userAgent: true, referrer: false } });
    expect(tvHeaderSupport('webos', false)).toEqual({ lists: F, streams: F });
  });
});
