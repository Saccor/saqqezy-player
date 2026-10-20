import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { archiveDays, parseWallClock, wallClockIn } from '../src/catchup.ts';
import { startFakeXtream } from '../src/server.ts';

// 2026-10-20 18:10 UTC: Stockholm is on summer time (UTC+2) until 2026-10-25 01:00 UTC.
const NOW = Date.UTC(2026, 9, 20, 18, 10);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 12, catchup: true, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const api = (q: string, user = 'test') =>
  fetch(`${server.url}/player_api.php?username=${user}&password=test&${q}`).then((r) => r.json());
/** The xc path form of `ms` in the panel zone: `YYYY-MM-DD:HH-MM`. */
const xcAt = (ms: number) => {
  const w = wallClockIn(ms, 'Europe/Stockholm');
  return `${w.slice(0, 10)}:${w.slice(11, 13)}-${w.slice(14, 16)}`;
};

describe('zone helpers', () => {
  test('wall clock in Europe/Stockholm across the DST end, and back', () => {
    expect(wallClockIn(Date.UTC(2026, 9, 20, 18, 0), 'Europe/Stockholm')).toBe('2026-10-20 20:00:00');
    expect(wallClockIn(Date.UTC(2026, 9, 26, 18, 0), 'Europe/Stockholm')).toBe('2026-10-26 19:00:00');
    expect(parseWallClock('2026-10-20:20-00', 'Europe/Stockholm')).toBe(Date.UTC(2026, 9, 20, 18, 0));
    expect(parseWallClock('2026-10-26 19:00:00', 'Europe/Stockholm')).toBe(Date.UTC(2026, 9, 26, 18, 0));
    expect(parseWallClock('nonsense', 'Europe/Stockholm')).toBeUndefined();
  });

  test('archive days: 7 for n % 4 = 1, 3 for n % 4 = 2, none otherwise', () => {
    expect([1, 2, 3, 4, 5, 6].map(archiveDays)).toEqual([7, 3, 0, 0, 7, 3]);
  });
});

describe('fake catch-up (catchup: true)', () => {
  test('login reports the panel zone and clock', async () => {
    const info = (await api('')).server_info;
    expect(info.timezone).toBe('Europe/Stockholm');
    expect(info.timestamp_now).toBe(Math.floor(NOW / 1000));
    expect(info.time_now).toBe('2026-10-20 20:10:00');
  });

  test('live streams carry tv_archive and tv_archive_duration', async () => {
    const streams = await api('action=get_live_streams');
    expect(streams.slice(0, 4).map((s: { tv_archive: number; tv_archive_duration: string }) => [s.tv_archive, s.tv_archive_duration]))
      .toEqual([[1, '7'], [1, '3'], [0, '0'], [0, '0']]);
  });

  test('timeshift path and php forms redirect to the test stream inside the window, 404 outside', async () => {
    const go = (p: string) => fetch(`${server.url}${p}`, { redirect: 'manual' });
    const ok = await go(`/timeshift/test/test/31/${xcAt(NOW - 2 * 3600_000)}/1.ts`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
    // Older than channel 2's 3 days.
    expect((await go(`/timeshift/test/test/31/${xcAt(NOW - 4 * 86_400_000)}/2.m3u8`)).status).toBe(404);
    // A channel without archive, a future start, a wrong password.
    expect((await go(`/timeshift/test/test/31/${xcAt(NOW - 2 * 3600_000)}/3.ts`)).status).toBe(404);
    expect((await go(`/timeshift/test/test/31/${xcAt(NOW + 2 * 3600_000)}/1.ts`)).status).toBe(404);
    expect((await go(`/timeshift/test/nope/31/${xcAt(NOW - 2 * 3600_000)}/1.ts`)).status).toBe(401);
    const php = await go(`/streaming/timeshift.php?username=test&password=test&stream=1&start=${xcAt(NOW - 2 * 3600_000)}&duration=31`);
    expect(php.status).toBe(302);
  });

  test('gone404 timeshift answers 404 like its live streams', async () => {
    const res = await fetch(`${server.url}/timeshift/gone404/test/31/${xcAt(NOW - 3600_000)}/1.ts`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  test('get_simple_data_table lists the archive days with has_archive and base64 titles', async () => {
    const table = await api('action=get_simple_data_table&stream_id=2');
    const list = table.epg_listings as { title: string; start_timestamp: string; stop_timestamp: string; has_archive: number }[];
    const first = list[0]!;
    expect(Number(first.start_timestamp) * 1000).toBeLessThanOrEqual(NOW - 3 * 86_400_000 + 1800_000);
    expect(Buffer.from(first.title, 'base64').toString('utf8')).toMatch(/^(Archive programme|Programme) /);
    const past = list.filter((l) => Number(l.stop_timestamp) * 1000 <= NOW);
    expect(past.length).toBeGreaterThan(3 * 48 - 2);
    expect(past.every((l) => l.has_archive === 1)).toBe(true);
    expect(list.filter((l) => Number(l.start_timestamp) * 1000 > NOW).every((l) => l.has_archive === 0)).toBe(true);
    const none = await api('action=get_simple_data_table&stream_id=3');
    expect(none.epg_listings.every((l: { has_archive: number }) => l.has_archive === 0)).toBe(true);
  });

  test('XMLTV keeps 7 days of history for 7-day channels only', async () => {
    const xml = await (await fetch(`${server.url}/xmltv.php?username=test&password=test`)).text();
    const count = (id: string) => xml.split(`channel="${id}"`).length - 1;
    expect(count('c1.test')).toBeGreaterThan(count('c2.test') + 6 * 48);
    expect(count('c2.test')).toBe(count('c3.test'));
    expect(xml).toContain('<title>Archive programme ');
  });

  test('catch-up M3U lists every mode and an unsupported template; the archive routes answer', async () => {
    const text = await (await fetch(`${server.url}/catchup.m3u?username=test&password=test`)).text();
    expect(text.split('\n')[0]).toBe('#EXTM3U catchup-days="2"');
    for (const mode of ['default', 'append', 'shift', 'flussonic', 'xc']) expect(text).toContain(`catchup="${mode}"`);
    expect(text).toContain('{unknown}');
    const utc = Math.floor((NOW - 3600_000) / 1000);
    const go = (p: string) => fetch(`${server.url}${p}`, { redirect: 'manual' }).then((r) => r.status);
    expect(await go(`/archive/1/index.m3u8?start=${utc}&end=${utc + 1800}`)).toBe(302);
    expect(await go(`/archive/1/index.m3u8?start=${utc - 8 * 86_400}&end=${utc}`)).toBe(404);
    expect(await go(`/archive/gone/index.m3u8?start=${utc}&end=${utc + 1800}`)).toBe(404);
    expect(await go('/plain/5.m3u8')).toBe(302);
    expect(await go(`/plain/5.m3u8?utc=${utc}&lutc=${utc + 3600}`)).toBe(302);
    expect(await go(`/plain/5.m3u8?utc=${utc + 7200}&lutc=${utc + 3600}`)).toBe(404);
    expect(await go('/flu/ch9/index.m3u8')).toBe(302);
    expect(await go(`/flu/ch9/index-${utc}-1800.m3u8`)).toBe(302);
    expect(await go(`/flu/ch9/timeshift_abs-${utc}.ts`)).toBe(302);
    expect((await fetch(`${server.url}/catchup.m3u?username=test&password=bad`)).status).toBe(401);
  });
});

test('without the catchup option the live streams have no archive and the zone stays UTC', async () => {
  const s = await startFakeXtream({ port: 0, channels: 2, now: () => NOW });
  try {
    const login = await (await fetch(`${s.url}/player_api.php?username=test&password=test`)).json();
    expect(login.server_info.timezone).toBe('UTC');
    const streams = await (await fetch(`${s.url}/player_api.php?username=test&password=test&action=get_live_streams`)).json();
    expect(streams[0].tv_archive).toBeUndefined();
  } finally {
    await s.close();
  }
});
