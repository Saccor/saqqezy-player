import { describe, expect, test } from 'vitest';
import { renderTemplate, templateStepMs, validTemplate } from '../src/catchup/template.ts';
import type { CatchupZone } from '../src/catchup/zone.ts';

// A programme 2026-10-20 20:00–21:30 UTC, played at 22:00:30 UTC.
const T = { start: Date.UTC(2026, 9, 20, 20, 0), stop: Date.UTC(2026, 9, 20, 21, 30), now: Date.UTC(2026, 9, 20, 22, 0, 30) };
const S = T.start / 1000;
const UTC: CatchupZone = { kind: 'fixed', offsetMin: 0 };
const STHLM: CatchupZone = { kind: 'iana', name: 'Europe/Stockholm' };
const r = (tpl: string, zone: CatchupZone = UTC, t = T) => renderTemplate(tpl, t, zone);

describe('renderTemplate golden outputs', () => {
  test('Unix-second placeholders and their aliases', () => {
    expect(r('a?s={utc}&e={utcend}&n={lutc}')).toBe(`a?s=${S}&e=${S + 5400}&n=${T.now / 1000}`);
    expect(r('a?s={start}&e={end}&n={now}&t={timestamp}')).toBe(`a?s=${S}&e=${S + 5400}&n=${T.now / 1000}&t=${T.now / 1000}`);
    expect(r('a?s=${start}&e=${end}&n=${now}&t=${timestamp}')).toBe(`a?s=${S}&e=${S + 5400}&n=${T.now / 1000}&t=${T.now / 1000}`);
  });

  test('duration and offset, with a divisor', () => {
    expect(r('a?d={duration}&m={duration:60}&o={offset}&om={offset:60}&x=${duration}&y=${offset}'))
      .toBe('a?d=5400&m=90&o=7230&om=120&x=5400&y=7230');
  });

  test('wall-clock fields are zero-padded in the zone', () => {
    expect(r('/a/{Y}/{m}/{d}/{H}-{M}-{S}.ts')).toBe('/a/2026/10/20/20-00-00.ts');
    expect(r('/a/{Y}/{m}/{d}/{H}-{M}-{S}.ts', STHLM)).toBe('/a/2026/10/20/22-00-00.ts');
    expect(r('/a/{H}{M}.ts', { kind: 'fixed', offsetMin: -330 }, { ...T, start: Date.UTC(2026, 0, 2, 3, 5) })).toBe('/a/2135.ts');
  });

  test('FMT forms for start and end, path and query', () => {
    expect(r('/a/{utc:Y-m-d}/{utc:H.M.S}_{utcend:H:M}.ts')).toBe('/a/2026-10-20/20.00.00_21:30.ts');
    expect(r('/a/${start:Y/m/d}/${end:H_M}.ts', STHLM)).toBe('/a/2026/10/20/23_30.ts');
    // In a query the formatted value is percent-encoded.
    expect(r('a?from={utc:Y-m-d H:M:S}')).toBe('a?from=2026-10-20%2020%3A00%3A00');
  });

  test('literal text and characters around placeholders are kept', () => {
    expect(r('http://h.test/p/x{utc}y.m3u8?q=1')).toBe(`http://h.test/p/x${S}y.m3u8?q=1`);
  });
});

describe('validTemplate', () => {
  test('accepts the Kodi-compatible set', () => {
    for (const t of ['{utc}', '{utcend}', '{lutc}', '{start}', '${start}', '{end}', '${end}', '{now}', '${now}', '{timestamp}',
      '${timestamp}', '{duration}', '{duration:60}', '${duration}', '{offset}', '{offset:3600}', '${offset}', '{Y}{m}{d}{H}{M}{S}',
      '{utc:Y-m-d H:M:S}', '${start:Y/m/d}', '{utcend:H.M}', '${end:H_M}', 'plain/no/placeholders']) {
      expect(validTemplate(t), t).toBe(true);
    }
  });

  test('rejects unknown names, bad divisors, bad FMT characters and stray braces', () => {
    for (const t of ['{unknown}', '{duration:0}', '{duration:x}', '{utc:Y%m}', '{lutc:Y}', '{Y:m}', '{utc', 'a}b{', '{}', '{UTC}']) {
      expect(validTemplate(t), t).toBe(false);
    }
  });
});

test('step: minutes when a wall-clock start lacks seconds, else seconds', () => {
  expect(templateStepMs('a?s={utc}')).toBe(1000);
  expect(templateStepMs('/a/{Y}{m}{d}/{H}{M}.ts')).toBe(60_000);
  expect(templateStepMs('/a/{Y}{m}{d}/{H}{M}{S}.ts')).toBe(1000);
  expect(templateStepMs('/a/{utc:Y-m-d H:M}.ts')).toBe(60_000);
  expect(templateStepMs('/a/{utc:Y-m-d H:M:S}.ts')).toBe(1000);
  // Both forms present: the minute floor keeps them in agreement.
  expect(templateStepMs('/a/{utc:Y-m-d H:M}?s={utc}')).toBe(60_000);
});
