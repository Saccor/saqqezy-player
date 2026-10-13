import { describe, expect, test } from 'vitest';
import { normalizeServer, XtreamClient } from '../src/xtream/client.ts';
import { xtreamToChannels } from '../src/xtream/toChannels.ts';
import { SourceAuthError, SourceNetworkError } from '../src/errors.ts';
import type { FetchFn } from '../src/types.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(byAction: Record<string, () => Response>, seen: string[] = []): FetchFn {
  return async (url) => {
    seen.push(url);
    const action = new URL(url).searchParams.get('action') ?? 'auth';
    const handler = byAction[action];
    if (!handler) throw new Error(`unexpected action ${action}`);
    return handler();
  };
}
const cfg = { server: 'example.test:8080/', username: 'user 1', password: 'p&ss' };
const authOk = () => json({ user_info: { auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '2' } });

describe('normalizeServer', () => {
  test('adds scheme and strips trailing slashes', () => {
    expect(normalizeServer('  example.test:8080// ')).toBe('http://example.test:8080');
    expect(normalizeServer('https://example.test')).toBe('https://example.test');
  });
});

describe('XtreamClient', () => {
  test('authenticate returns account info and encodes credentials', async () => {
    const seen: string[] = [];
    const c = new XtreamClient(cfg, fakeFetch({ auth: authOk }, seen));
    expect(await c.authenticate()).toEqual({ expiresAt: 1893456000_000, maxConnections: 2 });
    expect(seen[0]).toBe('http://example.test:8080/player_api.php?username=user+1&password=p%26ss');
  });

  test('authenticate rejects auth=0, expired and 401', async () => {
    await expect(new XtreamClient(cfg, fakeFetch({ auth: () => json({ user_info: { auth: 0 } }) })).authenticate())
      .rejects.toBeInstanceOf(SourceAuthError);
    await expect(new XtreamClient(cfg, fakeFetch({ auth: () => json({ user_info: { auth: 1, status: 'Expired' } }) })).authenticate())
      .rejects.toThrow('expired');
    await expect(new XtreamClient(cfg, fakeFetch({ auth: () => json({}, 401) })).authenticate())
      .rejects.toBeInstanceOf(SourceAuthError);
  });

  test('network, http and json errors become SourceNetworkError', async () => {
    const down: FetchFn = async () => { throw new TypeError('fetch failed'); };
    await expect(new XtreamClient(cfg, down).authenticate()).rejects.toThrow('Could not reach the provider.');
    const e500 = new XtreamClient(cfg, fakeFetch({ auth: () => json({}, 500) }));
    await expect(e500.authenticate()).rejects.toMatchObject({ name: 'SourceNetworkError', status: 500 });
    const bad = new XtreamClient(cfg, fakeFetch({ auth: () => new Response('<html>') }));
    await expect(bad.authenticate()).rejects.toBeInstanceOf(SourceNetworkError);
  });

  test('categories, streams, urls and short epg', async () => {
    const c = new XtreamClient(cfg, fakeFetch({
      get_live_categories: () => json([{ category_id: '7', category_name: 'News' }]),
      get_live_streams: () => json([
        { stream_id: 101, name: 'Channel 001', stream_icon: 'http://example.test/1.png', epg_channel_id: 'ch1.test', category_id: '7', num: 1 },
        { stream_id: '102', name: 'Channel 002', stream_icon: '', epg_channel_id: null, category_id: '99', num: 0 },
      ]),
      get_short_epg: () => json({ epg_listings: [
        { title: btoa('Morning Show'), description: btoa('Synthetic'), start_timestamp: '1000', stop_timestamp: '2000' },
      ] }),
    }));
    expect(await c.liveCategories()).toEqual([{ id: '7', name: 'News' }]);
    const streams = await c.liveStreams();
    expect(streams).toEqual([
      { streamId: 101, name: 'Channel 001', icon: 'http://example.test/1.png', epgChannelId: 'ch1.test', categoryId: '7', num: 1 },
      { streamId: 102, name: 'Channel 002', categoryId: '99' },
    ]);
    expect(c.streamUrl(101, 'ts')).toBe('http://example.test:8080/live/user%201/p%26ss/101.ts');
    expect(c.xmltvUrl()).toBe('http://example.test:8080/xmltv.php?username=user+1&password=p%26ss');
    expect(await c.shortEpg(101, 'ch1.test')).toEqual([
      { epgId: 'ch1.test', start: 1_000_000, stop: 2_000_000, title: 'Morning Show', desc: 'Synthetic' },
    ]);
  });
});

describe('xtreamToChannels', () => {
  test('maps groups, ids, numbers and urls', () => {
    const c = new XtreamClient(cfg, fakeFetch({}));
    const ch = xtreamToChannels('s1', c,
      [{ id: '7', name: 'News' }],
      [
        { streamId: 101, name: 'Channel 001', epgChannelId: 'ch1.test', categoryId: '7', num: 5, icon: 'http://example.test/1.png' },
        { streamId: 102, name: 'Channel 002', categoryId: '99' },
      ], 'm3u8');
    expect(ch).toEqual([
      { id: 's1:x101', sourceId: 's1', name: 'Channel 001', url: 'http://example.test:8080/live/user%201/p%26ss/101.m3u8', group: 'News', number: 5, epgId: 'ch1.test', logo: 'http://example.test/1.png' },
      { id: 's1:x102', sourceId: 's1', name: 'Channel 002', url: 'http://example.test:8080/live/user%201/p%26ss/102.m3u8', group: 'Uncategorized', number: 6 },
    ]);
  });
});
