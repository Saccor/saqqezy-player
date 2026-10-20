import { describe, expect, test } from 'vitest';
import { normalizeServer, XtreamClient } from '../src/xtream/client.ts';
import { xtreamToChannels } from '../src/xtream/toChannels.ts';
import { ChannelIndex } from '../src/index/channelIndex.ts';
import { SourceAuthError, SourceNetworkError } from '../src/errors.ts';
import type { FetchFn } from '../src/types.ts';
import { INGEST_NAME_MAX } from '../src/constants.ts';

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

  test('authenticate keeps max_connections and active_cons when they are valid numbers', async () => {
    const auth = (info: Record<string, unknown>) => fakeFetch({ auth: () => json({ user_info: { auth: 1, status: 'Active', ...info } }) });
    expect(await new XtreamClient(cfg, auth({ max_connections: '3', active_cons: '0' })).authenticate())
      .toEqual({ maxConnections: 3, activeConnections: 0 });
    expect(await new XtreamClient(cfg, auth({ max_connections: 1, active_cons: 1 })).authenticate())
      .toEqual({ maxConnections: 1, activeConnections: 1 });
    expect(await new XtreamClient(cfg, auth({ max_connections: '0', active_cons: '-1' })).authenticate()).toEqual({});
    expect(await new XtreamClient(cfg, auth({ max_connections: 'x', active_cons: null })).authenticate()).toEqual({});
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

describe('XtreamClient – body reading', () => {
  test('a stalled JSON body fails with the stall message, invalid JSON keeps its message', async () => {
    const stalled = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"user_info":')); },
      pull: () => new Promise<void>(() => {}),
    }));
    const c = new XtreamClient(cfg, fakeFetch({ auth: stalled }), { idleMs: 20 });
    await expect(c.authenticate()).rejects.toThrow('The provider stopped sending data.');
    const bad = new XtreamClient(cfg, fakeFetch({ auth: () => new Response('<html>') }), { idleMs: 20 });
    await expect(bad.authenticate()).rejects.toThrow('Unexpected response from the provider.');
    const chunked = () => new Response(new ReadableStream<Uint8Array>({
      start(ctl) {
        const enc = new TextEncoder();
        ctl.enqueue(enc.encode('{"user_info":{"auth":'));
        ctl.enqueue(enc.encode('1,"status":"Active"}}'));
        ctl.close();
      },
    }));
    await expect(new XtreamClient(cfg, fakeFetch({ auth: chunked }), { idleMs: 20 }).authenticate()).resolves.toEqual({});
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

  const cats = [{ id: '3', name: 'C3' }, { id: '1', name: 'C1' }, { id: '2', name: 'C2' }];

  test('groups follow the category list order, not the stream order', () => {
    const c = new XtreamClient(cfg, fakeFetch({}));
    const ch = xtreamToChannels('s', c, cats, [
      { streamId: 1, name: 'Channel 001', categoryId: '1', num: 1 },
      { streamId: 2, name: 'Channel 002', categoryId: '2', num: 2 },
      { streamId: 3, name: 'Channel 003', categoryId: '3', num: 3 },
    ]);
    expect(ch.map((x) => x.group)).toEqual(['C3', 'C1', 'C2']);
    expect(new ChannelIndex(ch).groups().slice(2).map((g) => g.name)).toEqual(['C3', 'C1', 'C2']);
  });

  test('unknown or missing categories go last; stream order is kept inside a category', () => {
    const c = new XtreamClient(cfg, fakeFetch({}));
    const ch = xtreamToChannels('s', c, cats, [
      { streamId: 1, name: 'Channel 001', categoryId: '99', num: 1 },
      { streamId: 2, name: 'Channel 002', categoryId: '1', num: 2 },
      { streamId: 3, name: 'Channel 003', num: 3 },
      { streamId: 4, name: 'Channel 004', categoryId: '3', num: 4 },
      { streamId: 5, name: 'Channel 005', categoryId: '1', num: 5 },
      { streamId: 6, name: 'Channel 006', categoryId: '3', num: 6 },
    ]);
    expect(ch.map((x) => x.id)).toEqual(['s:x4', 's:x6', 's:x2', 's:x5', 's:x1', 's:x3']);
    expect(new ChannelIndex(ch).groups().slice(2).map((g) => g.name)).toEqual(['C3', 'C1', 'Uncategorized']);
  });

  test('channels without num keep the numbers they had in stream order', () => {
    const c = new XtreamClient(cfg, fakeFetch({}));
    const ch = xtreamToChannels('s', c, cats, [
      { streamId: 1, name: 'Channel 001', categoryId: '1' },
      { streamId: 2, name: 'Channel 002', categoryId: '2', num: 10 },
      { streamId: 3, name: 'Channel 003', categoryId: '3' },
      { streamId: 4, name: 'Channel 004', categoryId: '1' },
    ]);
    const num = Object.fromEntries(ch.map((x) => [x.id, x.number]));
    expect(num).toEqual({ 's:x1': 11, 's:x2': 10, 's:x3': 12, 's:x4': 13 });
    expect(ch.map((x) => x.id)).toEqual(['s:x3', 's:x1', 's:x4', 's:x2']);
  });
});

describe('XtreamClient – shape guards', () => {
  test('liveStreams/liveCategories skip null and non-object rows', async () => {
    const c = new XtreamClient(cfg, fakeFetch({
      get_live_streams: () => json([null, 5, 'x', { stream_id: 3, name: 'Ok' }]),
      get_live_categories: () => json([null, 'x', { category_id: '1', category_name: 'News' }]),
    }));
    expect((await c.liveStreams()).map((s) => s.streamId)).toEqual([3]);
    expect(await c.liveCategories()).toEqual([{ id: '1', name: 'News' }]);
  });

  test('stream and category names are capped at INGEST_NAME_MAX characters; icons are not', async () => {
    const long = 'N'.repeat(5000);
    const icon = `http://img.test/${'p'.repeat(400)}.png`;
    const c = new XtreamClient(cfg, fakeFetch({
      get_live_streams: () => json([{ stream_id: 3, name: long, stream_icon: icon }]),
      get_live_categories: () => json([{ category_id: '1', category_name: long }]),
    }));
    const [s] = await c.liveStreams();
    expect(s!.name).toHaveLength(INGEST_NAME_MAX);
    expect(s!.icon).toBe(icon);
    expect((await c.liveCategories())[0]!.name).toHaveLength(INGEST_NAME_MAX);
  });

  test('shortEpg tolerates non-array listings, null rows and non-object bodies', async () => {
    for (const body of [null, 'x', 5, {}, { epg_listings: 'nope' }, { epg_listings: { a: 1 } }]) {
      const c = new XtreamClient(cfg, fakeFetch({ get_short_epg: () => json(body) }));
      expect(await c.shortEpg(1, 'e')).toEqual([]);
    }
    const rows = [null, 3, { start_timestamp: '10', stop_timestamp: '20', title: btoa('T') }];
    const c = new XtreamClient(cfg, fakeFetch({ get_short_epg: () => json({ epg_listings: rows }) }));
    const out = await c.shortEpg(1, 'e');
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('T');
  });

  test('authenticate with a malformed body is an auth error, not a TypeError', async () => {
    for (const body of [null, 'x', { user_info: null }, { user_info: 'x' }]) {
      const c = new XtreamClient(cfg, fakeFetch({ auth: () => json(body) }));
      await expect(c.authenticate()).rejects.toBeInstanceOf(SourceAuthError);
    }
  });

  test('error messages never contain credentials or a url', async () => {
    const secret = { server: 'example.test', username: 'zed-user', password: 'zed-pass' };
    const failures: FetchFn[] = [
      async () => { throw new TypeError('fetch failed http://example.test/player_api.php?username=zed-user&password=zed-pass'); },
      async () => new Response('', { status: 401 }),
      async () => new Response('', { status: 502 }),
      async () => new Response('not json'),
    ];
    for (const f of failures) {
      const err = await new XtreamClient(secret, f).authenticate().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      for (const bad of ['zed-user', 'zed-pass', 'http']) expect(msg).not.toContain(bad);
    }
  });
});

describe('XtreamClient – source headers', () => {
  test('player_api requests carry the source User-Agent and Referer as FetchInit.sourceHeaders', async () => {
    const inits: (Parameters<FetchFn>[1])[] = [];
    const f: FetchFn = async (_url, init) => { inits.push(init); return authOk(); };
    await new XtreamClient({ ...cfg, userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' }, f).authenticate();
    expect(inits[0]?.sourceHeaders).toEqual({ userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' });
  });

  test('without settings the init has no sourceHeaders field', async () => {
    const inits: (Parameters<FetchFn>[1])[] = [];
    const f: FetchFn = async (_url, init) => { inits.push(init); return authOk(); };
    await new XtreamClient(cfg, f).authenticate();
    expect(inits[0] && 'sourceHeaders' in inits[0]).toBe(false);
  });
});
