import { describe, expect, test } from 'vitest';
import { XtreamClient } from '../src/xtream/client.ts';
import { xtreamToChannels } from '../src/xtream/toChannels.ts';
import type { FetchFn } from '../src/types.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchJson = (body: unknown, seen: string[] = []): FetchFn => async (url) => {
  seen.push(url);
  return json(body);
};
const cfg = { server: 'http://x.test', username: 'u', password: 'p' };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('Xtream catch-up fields', () => {
  test('tv_archive and tv_archive_duration: strings, numbers, 0, missing, capped', async () => {
    const streams = [
      { stream_id: 1, name: 'A', tv_archive: 1, tv_archive_duration: 7 },
      { stream_id: 2, name: 'B', tv_archive: '1', tv_archive_duration: '5' },
      { stream_id: 3, name: 'C', tv_archive: 1, tv_archive_duration: 0 },
      { stream_id: 4, name: 'D', tv_archive: 1 },
      { stream_id: 5, name: 'E', tv_archive: 0, tv_archive_duration: 7 },
      { stream_id: 6, name: 'F' },
      { stream_id: 7, name: 'G', tv_archive: '1', tv_archive_duration: '90' },
    ];
    const c = new XtreamClient(cfg, fetchJson(streams));
    const got = await c.liveStreams();
    expect(got.map((s) => s.archiveDays)).toEqual([7, 5, 3, 3, undefined, undefined, 30]);
    const ch = xtreamToChannels('s', c, [], got);
    expect(ch.map((x) => x.catchup)).toEqual([
      { mode: 'xc', days: 7 }, { mode: 'xc', days: 5 }, { mode: 'xc', days: 3 }, { mode: 'xc', days: 3 }, undefined, undefined, { mode: 'xc', days: 30 },
    ]);
    expect('catchup' in ch[5]!).toBe(false);
  });

  test('server_info: zone and the panel clock offset', async () => {
    const ts = Date.UTC(2026, 9, 20, 18, 10) / 1000;
    const c = new XtreamClient(cfg, fetchJson({
      user_info: { auth: 1, status: 'Active' },
      server_info: { timezone: 'Europe/Stockholm', time_now: '2026-10-20 20:10:03', timestamp_now: ts },
    }));
    expect(await c.authenticate()).toEqual({ serverTimeZone: 'Europe/Stockholm', serverOffsetMin: 120 });
    const none = new XtreamClient(cfg, fetchJson({ user_info: { auth: 1 }, server_info: { timezone: '' } }));
    expect(await none.authenticate()).toEqual({});
  });

  test('simpleDataTable: base64 titles, has_archive, timestamps; junk rows skipped', async () => {
    const seen: string[] = [];
    const c = new XtreamClient(cfg, fetchJson({
      epg_listings: [
        { title: b64('Past'), description: b64('About'), start_timestamp: '1792512000', stop_timestamp: '1792513800', has_archive: 1 },
        { title: b64('Now'), start_timestamp: 1792513800, stop_timestamp: 1792515600, has_archive: '0' },
        { title: b64('Bad'), start_timestamp: 'x' },
        null,
      ],
    }, seen));
    const rows = await c.simpleDataTable(5, 'e.test');
    expect(seen[0]).toContain('action=get_simple_data_table');
    expect(seen[0]).toContain('stream_id=5');
    expect(rows).toEqual([
      { epgId: 'e.test', start: 1792512000_000, stop: 1792513800_000, title: 'Past', desc: 'About', hasArchive: true },
      { epgId: 'e.test', start: 1792513800_000, stop: 1792515600_000, title: 'Now', hasArchive: false },
    ]);
    expect(await new XtreamClient(cfg, fetchJson([])).simpleDataTable(5, 'e')).toEqual([]);
  });
});
