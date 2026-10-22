import { describe, expect, test } from 'vitest';
import { createSessionTable, livePlaylist, segmentLocation } from '../src/connections.ts';

describe('session table', () => {
  test('refuse mode: the open past N is refused while N sessions are read', () => {
    const s = createSessionTable({ max: 2, mode: 'refuse' }, () => 0);
    const a = s.open('u');
    const b = s.open('u');
    expect(a.ok && b.ok).toBe(true);
    expect(s.open('u')).toEqual({ ok: false });
    expect(s.open('other').ok).toBe(true); // the limit is per user
    expect(s.stats()).toMatchObject({ refused: 1, open: { u: 2, other: 1 } });
  });

  test('an idle session stops counting after idleMs, like a panel cron', () => {
    let t = 0;
    const s = createSessionTable({ max: 1, mode: 'refuse', idleMs: 20_000 }, () => t);
    const a = s.open('u');
    if (!a.ok) throw new Error('first open');
    t = 19_000;
    expect(s.touch(a.sid)).toBe(true);
    t = 38_000;
    expect(s.open('u').ok).toBe(false); // read at 19 s: still open
    t = 40_000;
    expect(s.open('u').ok).toBe(true);
    expect(s.touch(a.sid)).toBe(false); // expired
  });

  test('kick mode: the open past N succeeds and the oldest session is cut', () => {
    let t = 0;
    const s = createSessionTable({ max: 2, mode: 'kick' }, () => t);
    const a = s.open('u');
    t = 1;
    const b = s.open('u');
    t = 2;
    const c = s.open('u');
    if (!a.ok || !b.ok || !c.ok) throw new Error('all open');
    expect(s.touch(a.sid)).toBe(false);
    expect(s.touch(b.sid)).toBe(true);
    expect(s.touch(c.sid)).toBe(true);
    expect(s.stats()).toMatchObject({ kicked: 1, open: { u: 2 } });
  });

  test('reopening the same stream replaces the earlier session (a client reconnecting, not a second stream)', () => {
    const s = createSessionTable({ max: 1, mode: 'refuse' }, () => 0);
    const a = s.open('u', 5);
    const b = s.open('u', 5);
    if (!a.ok || !b.ok) throw new Error('both open');
    expect(s.touch(a.sid)).toBe(false);
    expect(s.touch(b.sid)).toBe(true);
    expect(s.open('u', 6)).toEqual({ ok: false }); // another stream is still a second connection
    expect(s.stats()).toMatchObject({ refused: 1, kicked: 0, open: { u: 1 } });
  });

  test('reset clears sessions and counters', () => {
    const s = createSessionTable({ max: 1, mode: 'refuse' }, () => 0);
    s.open('u');
    s.open('u');
    s.reset();
    expect(s.stats()).toMatchObject({ refused: 0, kicked: 0, open: {} });
    expect(s.open('u').ok).toBe(true);
  });
});

describe('live wrapper playlist', () => {
  test('a 3-segment sliding window that advances every 10 s, segments under the session', () => {
    const p = livePlaylist('s1', 25_000);
    expect(p).toContain('#EXT-X-TARGETDURATION:10');
    expect(p).toContain('#EXT-X-MEDIA-SEQUENCE:2');
    expect(p).not.toContain('#EXT-X-ENDLIST');
    expect(p.match(/^\/__mv\/s1\/\d+\.ts$/gm)).toEqual(['/__mv/s1/2.ts', '/__mv/s1/3.ts', '/__mv/s1/4.ts']);
  });

  test('wrapping the 63 test segments adds a discontinuity', () => {
    const p = livePlaylist('s1', 62 * 10_000);
    expect(p).toMatch(/\/__mv\/s1\/62\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:10\.000,\n\/__mv\/s1\/63\.ts/);
    expect(segmentLocation(63)).toBe(segmentLocation(0));
    // The rendition's segment paths are relative to its own playlist, under url_4/.
    expect(segmentLocation(0)).toBe('https://test-streams.mux.dev/x36xhzz/url_4/url_718/193039199_mp4_h264_aac_7.ts');
  });
});
