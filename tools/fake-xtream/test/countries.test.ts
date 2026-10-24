import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFakeXtream } from '../src/server.ts';

type Server = Awaited<ReturnType<typeof startFakeXtream>>;
const api = (s: Server, q: string) => fetch(`${s.url}/player_api.php?username=test&password=test&${q}`).then((r) => r.json());
const names = async (s: Server, action: string) =>
  ((await api(s, `action=${action}`)) as { category_name: string }[]).map((c) => c.category_name);

describe('FAKE_COUNTRIES (countries option)', () => {
  let on: Server;
  let off: Server;
  beforeAll(async () => {
    on = await startFakeXtream({ port: 0, channels: 40, countries: true });
    off = await startFakeXtream({ port: 0, channels: 40 });
  });
  afterAll(async () => { await on.close(); await off.close(); });

  test('live groups, movie and series categories carry synthetic country prefixes', async () => {
    const live = await names(on, 'get_live_categories');
    expect(live).toContain('SE | News');
    expect(live).toContain('EN | Music');
    expect(live).toContain('News');
    expect(new Set(live.filter((n) => n.includes(' | ')).map((n) => n.split(' | ')[0])).size).toBeGreaterThanOrEqual(4);
    expect(await names(on, 'get_vod_categories')).toEqual(['SE | Drama', 'DK | Comedy', 'BE | Documentary', 'Family']);
    expect(await names(on, 'get_series_categories')).toEqual(['SE | Drama', 'DK | Comedy', 'Kids']);
  });

  test('every channel lands in a listed group', async () => {
    const ids = new Set(((await api(on, 'action=get_live_categories')) as { category_id: string }[]).map((c) => c.category_id));
    const streams = (await api(on, 'action=get_live_streams')) as { category_id: string }[];
    expect(streams.every((s) => ids.has(s.category_id))).toBe(true);
    expect(new Set(streams.map((s) => s.category_id)).size).toBe(ids.size);
  });

  test('without the option the plain names stay', async () => {
    expect(await names(off, 'get_live_categories')).toEqual(['News', 'Movies', 'Kids', 'Music']);
    expect(await names(off, 'get_vod_categories')).toEqual(['Drama', 'Comedy', 'Documentary', 'Family']);
    expect(await names(off, 'get_series_categories')).toEqual(['Drama', 'Comedy', 'Kids']);
  });
});
