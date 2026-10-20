import { describe, expect, test } from 'vitest';
import { buildCatchupUrl } from '../src/catchup/buildUrl.ts';
import type { CatchupZone } from '../src/catchup/zone.ts';
import type { ChannelCatchup } from '../src/types.ts';

const UTC: CatchupZone = { kind: 'fixed', offsetMin: 0 };
const STHLM: CatchupZone = { kind: 'iana', name: 'Europe/Stockholm' };
// 2026-10-20 18:00–18:30 UTC, played at 20:00 UTC.
const prog = { start: Date.UTC(2026, 9, 20, 18, 0), stop: Date.UTC(2026, 9, 20, 18, 30) };
const NOW = Date.UTC(2026, 9, 20, 20, 0);
const S = prog.start / 1000;
const TPL = ['http://archive.test/a?start={utc}&end={utcend}', '?utc={utc}&lutc={lutc}', 'http://archive.test/{Y}{m}{d}/{H}{M}.ts', '&t={utc}'];
const ch = (url: string, catchup: ChannelCatchup) => ({ url, catchup });
const build = (url: string, c: ChannelCatchup, offsetMs = 0, zone: CatchupZone = UTC, xtream = false) =>
  buildCatchupUrl(ch(url, c), TPL, prog, offsetMs, zone, NOW, { xtream });

describe('buildCatchupUrl per mode', () => {
  test('default: the template is the whole URL', () => {
    expect(build('http://s.test/1.m3u8', { mode: 'default', days: 3, tpl: 0 }))
      .toEqual({ url: `http://archive.test/a?start=${S}&end=${S + 1800}`, stepMs: 1000, openStart: prog.start });
  });

  test('append: channel URL plus the suffix; a second ? becomes &', () => {
    expect(build('http://s.test/1.m3u8', { mode: 'append', days: 3, tpl: 1 })!.url).toBe(`http://s.test/1.m3u8?utc=${S}&lutc=${NOW / 1000}`);
    expect(build('http://s.test/1.m3u8?token=x', { mode: 'append', days: 3, tpl: 1 })!.url).toBe(`http://s.test/1.m3u8?token=x&utc=${S}&lutc=${NOW / 1000}`);
    expect(build('http://s.test/1.m3u8?token=x', { mode: 'append', days: 3, tpl: 3 })!.url).toBe(`http://s.test/1.m3u8?token=x&t=${S}`);
  });

  test('shift: utc and lutc joined with ? or &', () => {
    expect(build('http://s.test/1.m3u8', { mode: 'shift', days: 3 })!.url).toBe(`http://s.test/1.m3u8?utc=${S}&lutc=${NOW / 1000}`);
    expect(build('http://s.test/1.m3u8?a=1', { mode: 'shift', days: 3 })!.url).toBe(`http://s.test/1.m3u8?a=1&utc=${S}&lutc=${NOW / 1000}`);
  });

  test('a channel URL with braces is never read as a template', () => {
    expect(build('http://s.test/{x}.m3u8', { mode: 'shift', days: 3 })!.url).toBe(`http://s.test/{x}.m3u8?utc=${S}&lutc=${NOW / 1000}`);
  });

  test('flussonic: HLS and TS path rewrites, query kept', () => {
    expect(build('http://s.test/ch1/index.m3u8?token=x', { mode: 'flussonic', days: 3 })!.url).toBe(`http://s.test/ch1/index-${S}-1800.m3u8?token=x`);
    expect(build('http://s.test/ch1/mono.m3u8', { mode: 'flussonic', days: 3 })!.url).toBe(`http://s.test/ch1/mono-${S}-1800.m3u8`);
    expect(build('http://s.test/ch1/mpegts', { mode: 'flussonic', days: 3 })!.url).toBe(`http://s.test/ch1/timeshift_abs-${S}.ts`);
  });

  test('xc: path form in the zone, minute step; the php alternate only for Xtream sources', () => {
    const m3u = build('http://x.test/live/u/p/5.ts', { mode: 'xc', days: 3 }, 0, STHLM);
    expect(m3u).toEqual({ url: 'http://x.test/timeshift/u/p/31/2026-10-20:20-00/5.ts', stepMs: 60_000, openStart: prog.start });
    const xt = build('http://x.test/live/u/p/5.ts', { mode: 'xc', days: 3 }, 0, STHLM, true);
    expect(xt!.alternateUrl).toBe('http://x.test/streaming/timeshift.php?username=u&password=p&stream=5&start=2026-10-20%3A20-00&duration=31');
  });

  test('xc: the live format that plays on the source replaces the channel URL\'s', () => {
    const r = buildCatchupUrl({ url: 'http://x.test/live/u/p/5.ts', catchup: { mode: 'xc', days: 3 } }, TPL, prog, 0, UTC, NOW, { ext: 'm3u8' });
    expect(r!.url).toBe('http://x.test/timeshift/u/p/31/2026-10-20:18-00/5.m3u8');
  });

  test('wall-clock template: minute step in the zone', () => {
    expect(build('http://s.test/1.m3u8', { mode: 'default', days: 3, tpl: 2 }, 0, STHLM))
      .toEqual({ url: 'http://archive.test/20261020/2000.ts', stepMs: 60_000, openStart: prog.start });
  });

  test('broken data gives undefined, never a wrong URL', () => {
    expect(build('http://s.test/1.m3u8', { mode: 'default', days: 3, tpl: 9 })).toBeUndefined();
    expect(build('http://s.test/1.m3u8', { mode: 'default', days: 3 })).toBeUndefined();
    expect(build('http://s.test/x.m3u8', { mode: 'flussonic', days: 3 })).toBeUndefined();
    expect(build('http://s.test/x.m3u8', { mode: 'xc', days: 3 })).toBeUndefined();
    expect(buildCatchupUrl({ url: 'http://s.test/x.m3u8' }, TPL, prog, 0, UTC, NOW)).toBeUndefined();
  });
});

describe('seek re-open', () => {
  test('the start is floored to the step; the remainder is the caller\'s', () => {
    const sec = build('http://s.test/1.m3u8', { mode: 'default', days: 3, tpl: 0 }, 125_400)!;
    expect(sec.openStart).toBe(prog.start + 125_000);
    expect(sec.url).toBe(`http://archive.test/a?start=${S + 125}&end=${S + 1800}`);
    const xc = build('http://x.test/live/u/p/5.ts', { mode: 'xc', days: 3 }, 125_400, UTC)!;
    expect(xc.openStart).toBe(prog.start + 120_000);
    // 28 minutes left, plus one for the floor.
    expect(xc.url).toBe('http://x.test/timeshift/u/p/29/2026-10-20:18-02/5.ts');
  });
});
