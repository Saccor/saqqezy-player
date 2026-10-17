import { describe, expect, it } from 'vitest';
import { cueTextOf, nativeHlsPreferred } from './trackSupport.ts';

describe('nativeHlsPreferred', () => {
  it('keeps native HLS for live, and for VOD only where the element can switch audio tracks', () => {
    expect(nativeHlsPreferred({ prefer: true, live: true, audioTrackApi: false })).toBe(true);
    expect(nativeHlsPreferred({ prefer: true, live: false, audioTrackApi: true })).toBe(true);
    expect(nativeHlsPreferred({ prefer: true, live: false, audioTrackApi: false })).toBe(false);
    expect(nativeHlsPreferred({ prefer: false, live: true, audioTrackApi: true })).toBe(false);
  });
});

describe('cueTextOf', () => {
  it('joins the active cues, strips markup and decodes entities', () => {
    expect(cueTextOf([{ text: '<i>Hello</i> &amp; <b>bye</b>' }, { text: 'Line&nbsp;two &lt;3' }])).toBe('Hello & bye\nLine two <3');
    expect(cueTextOf([{ text: '<c.yellow>Coloured</c>' }])).toBe('Coloured');
  });
  it('is null without a cue or with only blank text', () => {
    expect(cueTextOf(undefined)).toBeNull();
    expect(cueTextOf(null)).toBeNull();
    expect(cueTextOf([])).toBeNull();
    expect(cueTextOf([{ text: ' <i></i> ' }])).toBeNull();
  });
  it('skips cues without text (non-text cue types)', () => {
    expect(cueTextOf([{}, { text: 'Only this' }])).toBe('Only this');
  });
});
