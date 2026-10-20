import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { SourceService, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import { AppApi } from '../src/appApi.ts';
import type { AppEvent, CatchupPlayable } from '../src/types.ts';

// 2026-10-20 18:10 UTC; the fake panel runs on Europe/Stockholm (UTC+2 until 2026-10-25).
const NOW = Date.UTC(2026, 9, 20, 18, 10);
const H = 3_600_000;
const D = 24 * H;
const SLOT = (ms: number) => Math.floor(ms / 1_800_000) * 1_800_000;
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 12, catchup: true, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });

const make = (fetchFn: FetchFn = (u, i) => fetch(u, i)) => {
  const events: AppEvent[] = [];
  const storage = new MemoryStorage();
  const service = new SourceService({ storage, fetch: fetchFn, now: () => NOW, shortEpgGapMs: 0 });
  const api = new AppApi({ service, storage, emit: (e) => events.push(e), now: () => NOW });
  live.push(api);
  return { api, events };
};
const xtream = async (fetchFn?: FetchFn, extra: Record<string, unknown> = {}) => {
  const m = make(fetchFn);
  const { sourceId } = await m.api.addSource({ kind: 'xtream', name: 'Fake', server: server.url, username: 'test', password: 'test', ...extra });
  await m.api.idle();
  return { ...m, sourceId, ch: (n: number) => `${sourceId}:x${n}` };
};
const status = async (url: string) => (await fetch(url, { redirect: 'manual' })).status;
const isPlayable = (v: unknown): v is CatchupPlayable => typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'catchup';

describe('rows carry archive days', () => {
  test('Guide and list rows say which channels have catch-up', async () => {
    const { api } = await xtream();
    const epg = await api.getEpgRows('all', 0, 4, NOW - 3 * H, NOW + 3 * H);
    expect(epg.rows.map((r) => r.channel.archiveDays)).toEqual([7, 3, undefined, undefined]);
    const slice = await api.getChannelSlice('all', 0, 2);
    expect(slice.rows.map((r) => r.archiveDays)).toEqual([7, 3]);
  });
});

describe('getCatchupPlayable (Xtream)', () => {
  test('a past programme: timeshift URL in the panel zone, the php alternate, the next programme', async () => {
    const { api, ch } = await xtream();
    const start = SLOT(NOW) - 2 * H; // 16:00 UTC = 18:00 in Stockholm
    const p = await api.getCatchupPlayable(ch(1), start);
    if (!isPlayable(p)) throw new Error(`not playable: ${JSON.stringify(p)}`);
    expect(p).toMatchObject({
      kind: 'catchup', channelId: ch(1), channelName: 'Channel 001', start, stop: start + 1_800_000, openedAtMs: 0, stepMs: 60_000,
      url: `${server.url}/timeshift/test/test/31/2026-10-20:18-00/1.ts`,
      alternateUrl: `${server.url}/streaming/timeshift.php?username=test&password=test&stream=1&start=2026-10-20%3A18-00&duration=31`,
      next: { start: start + 1_800_000, stop: start + 3_600_000 },
    });
    expect(p.title).toMatch(/^Programme \d+$/);
    expect(p.cooldownKey).toBeDefined();
    expect(await status(p.url)).toBe(302);
    expect(await status(p.alternateUrl!)).toBe(302);
  });

  test('the programme on air plays from its start; it has no next to offer yet', async () => {
    const { api, ch } = await xtream();
    const p = await api.getCatchupPlayable(ch(1), SLOT(NOW));
    if (!isPlayable(p)) throw new Error('not playable');
    expect(p.url).toBe(`${server.url}/timeshift/test/test/31/2026-10-20:20-00/1.ts`);
    expect(p.next).toBeUndefined();
    expect(await status(p.url)).toBe(302);
  });

  test('xc uses the live format the source plays in (the format setting)', async () => {
    const { api, ch } = await xtream();
    await api.saveSettings({ preferredFormat: 'm3u8' });
    const p = await api.getCatchupPlayable(ch(1), SLOT(NOW) - 2 * H);
    expect(isPlayable(p) && p.url).toBe(`${server.url}/timeshift/test/test/31/2026-10-20:18-00/1.m3u8`);
  });

  test('a seek re-open starts at the floored minute and asks for the rest', async () => {
    const { api, ch } = await xtream();
    const start = SLOT(NOW) - 2 * H;
    const p = await api.getCatchupPlayable(ch(1), start, 125_400);
    if (!isPlayable(p)) throw new Error('not playable');
    expect(p.openedAtMs).toBe(120_000);
    expect(p.url).toBe(`${server.url}/timeshift/test/test/29/2026-10-20:18-02/1.ts`);
  });

  test('not available: future, no catch-up, no such programme, too old', async () => {
    const { api, ch } = await xtream();
    expect(await api.getCatchupPlayable(ch(1), SLOT(NOW) + 2 * H)).toEqual({ notAvailable: 'future' });
    expect(await api.getCatchupPlayable(ch(3), SLOT(NOW) - 2 * H)).toEqual({ notAvailable: 'none' });
    expect(await api.getCatchupPlayable(ch(1), SLOT(NOW) - 2 * H + 60_000 * 7)).toEqual({ notAvailable: 'none' });
    expect(await api.getCatchupPlayable('nope', SLOT(NOW))).toEqual({ notAvailable: 'none' });
  });

  test('a manual catch-up time writes wall-clock URLs in that offset, without a playlist refresh', async () => {
    let lists = 0;
    const counting: FetchFn = (u, i) => {
      if (u.includes('get_live_streams')) lists++;
      return fetch(u, i);
    };
    const { api, ch, sourceId } = await xtream(counting);
    const before = lists;
    expect(await api.setCatchupOffset(sourceId, 61)).toBe(60);
    expect(lists).toBe(before);
    expect((await api.getSource(sourceId))?.catchupOffsetMin).toBe(60);
    const p = await api.getCatchupPlayable(ch(1), SLOT(NOW) - 2 * H);
    expect(isPlayable(p) && p.url).toBe(`${server.url}/timeshift/test/test/31/2026-10-20:17-00/1.ts`);
    expect((await api.diagnostics()).sources[0]!.catchupTime).toBe('manual +1:00');
    expect(await api.setCatchupOffset(sourceId, undefined)).toBeUndefined();
    expect((await api.diagnostics()).sources[0]!.catchupTime).toBe('Europe/Stockholm');
  });

  test('a TV edit of the source (the login form has no Catch-up time) keeps the manual catch-up time', async () => {
    const { api, sourceId } = await xtream();
    await api.setCatchupOffset(sourceId, 60);
    // What AddSource's edit mode sends: the login fields with the id (toUpdatedSource), no catchupOffsetMin.
    await api.updateSource({ kind: 'xtream', id: sourceId, name: 'Renamed', server: server.url, username: 'test', password: 'test' });
    expect(await api.getSource(sourceId)).toMatchObject({ name: 'Renamed', catchupOffsetMin: 60 });
  });

  test('the source User-Agent goes with the archive URL', async () => {
    const { api, ch } = await xtream(undefined, { userAgent: 'SyntheticAgent/1.0' });
    const p = await api.getCatchupPlayable(ch(1), SLOT(NOW) - 2 * H);
    expect(isPlayable(p) && p.headers).toEqual({ userAgent: 'SyntheticAgent/1.0' });
  });
});

describe('Guide history after a catch-up import (end to end)', () => {
  test('a Guide read more than 24 h back finds the stored past of a catch-up channel; the look-back record is in place', async () => {
    const storage = new MemoryStorage();
    const service = new SourceService({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW, shortEpgGapMs: 0 });
    const api = new AppApi({ service, storage, emit: () => undefined, now: () => NOW });
    live.push(api);
    const { sourceId } = await api.addSource({ kind: 'xtream', name: 'Fake', server: server.url, username: 'test', password: 'test' });
    await api.idle();
    // The import wrote the look-back record of its generation (its longest programme, 30 min here), so reads do not
    // look back the default 24 h, and still find programmes a day and more in the past.
    const gen = await storage.getMeta<number>(`epgGen:${sourceId}`);
    expect(await storage.getMeta(`epgLongest:${sourceId}`)).toEqual({ gen, ms: 1_800_000 });
    const from = SLOT(NOW - 40 * H);
    const page = await api.getEpgRows('all', 0, 3, from, from + 3 * H);
    const [c1, c2, c3] = page.rows;
    expect(c1!.channel.archiveDays).toBe(7);
    expect(c1!.programmes.map((p) => p.start)).toEqual([0, 1, 2, 3, 4, 5].map((k) => from + k * 1_800_000));
    expect(c2!.programmes).toEqual([]); // its feed keeps the usual 6 h
    expect(c3!.programmes).toEqual([]);
    // Past the history budget of this source (12 channels, 6 with catch-up: 66 h), nothing is stored.
    const older = await api.getEpgRows('all', 0, 1, SLOT(NOW - 70 * H), SLOT(NOW - 70 * H) + 2 * H);
    expect(older.rows[0]!.programmes).toEqual([]);
  });
});

describe('refineArchive', () => {
  test('fills the past the stored guide lacks, marks it, and makes it playable', async () => {
    const { api, events, ch } = await xtream();
    const twoDaysAgo = SLOT(NOW - 2 * D);
    const before = await api.getEpgRows('all', 1, 1, twoDaysAgo, twoDaysAgo + 3 * H);
    expect(before.rows[0]!.programmes).toEqual([]);
    expect(await api.getCatchupPlayable(ch(2), twoDaysAgo)).toEqual({ notAvailable: 'none' });
    await api.refineArchive(ch(2));
    expect(events).toContainEqual({ type: 'archiveRefined', channelId: ch(2) });
    const after = await api.getEpgRows('all', 1, 1, twoDaysAgo, twoDaysAgo + 3 * H);
    expect(after.rows[0]!.programmes).toHaveLength(6);
    expect(after.rows[0]!.programmes.every((p) => p.archive === true)).toBe(true);
    const p = await api.getCatchupPlayable(ch(2), twoDaysAgo);
    if (!isPlayable(p)) throw new Error('not playable');
    expect(await status(p.url)).toBe(302);
    // Stored programmes in the refined row get the panel's flag too (on air: has_archive 0, still on air).
    const nowRow = await api.getEpgRows('all', 1, 1, SLOT(NOW) - H, SLOT(NOW) + H);
    expect(nowRow.rows[0]!.programmes.map((x) => x.archive)).toEqual([true, true, false, false]);
  });

  test('one request per channel per 30 min, one in flight; Xtream only; no storage write', async () => {
    let tables = 0;
    const counting: FetchFn = (u, i) => {
      if (u.includes('get_simple_data_table')) tables++;
      return fetch(u, i);
    };
    const { api, ch } = await xtream(counting);
    await Promise.all([api.refineArchive(ch(1)), api.refineArchive(ch(2))]);
    expect(tables).toBe(1);
    await api.refineArchive(ch(1));
    await api.refineArchive(ch(2));
    expect(tables).toBe(2);
    await api.refineArchive(ch(2));
    await api.refineArchive(ch(3)); // no catch-up
    expect(tables).toBe(2);
  });
});

describe('M3U catch-up modes against the fake source', () => {
  const m3u = async () => {
    const m = make();
    const { sourceId } = await m.api.addSource({
      kind: 'm3u', name: 'Catch-up M3U', playlistUrl: `${server.url}/catchup.m3u?username=test&password=test`,
      epgUrl: `${server.url}/xmltv.php?username=test&password=test`,
    });
    await m.api.idle();
    const rows = (await m.api.getChannelSlice('all', 0, 20)).rows;
    return { ...m, sourceId, id: (name: string) => rows.find((r) => r.name === name)!.id };
  };

  test('every mode builds a URL the source answers; the gone archive answers 404', async () => {
    const { api, id } = await m3u();
    const start = SLOT(NOW) - 2 * H;
    const s = start / 1000;
    const want: Record<string, string> = {
      'Catch-up default': `${server.url}/archive/1/index.m3u8?start=${s}&end=${s + 1800}`,
      'Catch-up wall clock': `${server.url}/archive/1/2026-10-20/16-00.m3u8?minutes=30`,
      'Catch-up append': `${server.url}/plain/5.m3u8?token=synthetic&utc=${s}&lutc=${NOW / 1000}`,
      'Catch-up shift': `${server.url}/plain/9.m3u8?utc=${s}&lutc=${NOW / 1000}`,
      'Catch-up flussonic': `${server.url}/flu/ch9/index-${s}-1800.m3u8`,
      'Catch-up xc': `${server.url}/timeshift/test/test/31/2026-10-20:18-00/1.ts`,
      'Catch-up inferred': `${server.url}/plain/2.m3u8?utc=${s}&lutc=${NOW / 1000}`,
    };
    for (const [name, url] of Object.entries(want)) {
      const p = await api.getCatchupPlayable(id(name), start);
      if (!isPlayable(p)) throw new Error(`${name}: ${JSON.stringify(p)}`);
      expect(p.url, name).toBe(url);
      expect(p.alternateUrl, name).toBeUndefined();
      expect(await status(p.url), name).toBe(302);
    }
    const gone = await api.getCatchupPlayable(id('Catch-up not available'), start);
    expect(isPlayable(gone) && (await status(gone.url))).toBe(404);
    expect(await api.getCatchupPlayable(id('Catch-up unsupported'), start)).toEqual({ notAvailable: 'none' });
  });

  test('diagnostics count catch-up channels and name the catch-up time', async () => {
    const { api } = await m3u();
    const d = await api.diagnostics();
    expect(d.sources[0]).toMatchObject({ catchupChannels: 8, catchupUnsupported: 1, catchupTime: 'Europe/Stockholm' });
    expect(JSON.stringify(d)).not.toContain('{utc}');
  });
});
