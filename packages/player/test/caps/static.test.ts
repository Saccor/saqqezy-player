import { describe, expect, it } from 'vitest';
import { capsSupport, staticCaps } from '../../src/index.ts';

describe('staticCaps', () => {
  it('desktop Chromium engines cannot decode Dolby or DTS', () => {
    for (const e of ['native', 'hls.js', 'mpegts.js'] as const) {
      const c = staticCaps('desktop', e);
      for (const a of ['ac3', 'eac3', 'eac3joc', 'truehd', 'dts', 'dtshd', 'ac4'] as const) expect(capsSupport(c, a)).toBe('none');
      expect(capsSupport(c, 'aac')).toBe('decode');
      expect(c.video.mpeg2?.value).toBe('none');
    }
  });
  it('browser matches desktop for HTML5 engines', () => {
    expect(staticCaps('browser', 'native').audio).toEqual(staticCaps('desktop', 'native').audio);
  });
  it('Tizen AVPlay: no DTS or TrueHD, AC-3/E-AC-3 decoded', () => {
    const c = staticCaps('tizen', 'avplay');
    expect(['truehd', 'dts', 'dtshd'].map((a) => capsSupport(c, a as never))).toEqual(['none', 'none', 'none']);
    expect(capsSupport(c, 'eac3')).toBe('decode');
    expect(c.display.hdr.dv5?.value).toBe('none');
  });
  it('webOS native: TrueHD none, DTS unknown', () => {
    const c = staticCaps('webos', 'native');
    expect(capsSupport(c, 'truehd')).toBe('none');
    expect(capsSupport(c, 'dts')).toBe('unknown');
  });
  it('mpegts.js quirks everywhere', () => {
    expect(staticCaps('webos', 'mpegts.js').quirks).toEqual({ firstAudioPidOnly: true, dvbAc3Undetected: true, noMpeg2: true });
  });
  it('mpv decodes everything, passes nothing through by default', () => {
    const c = staticCaps('desktop', 'mpv');
    expect(capsSupport(c, 'truehd')).toBe('decode');
    expect(capsSupport(c, 'dts')).toBe('decode');
  });
  it('media3 starts unknown', () => {
    expect(capsSupport(staticCaps('androidtv', 'media3'), 'eac3')).toBe('unknown');
  });
  it('every value carries static evidence', () => {
    for (const v of Object.values(staticCaps('tizen', 'avplay').audio)) expect(v?.evidence).toBe('static');
  });
});
