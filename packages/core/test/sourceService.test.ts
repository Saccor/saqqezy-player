import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { SourceService } from '../src/service/sourceService.ts';
import { SourceAuthError, SourceNetworkError } from '../src/errors.ts';
import type { FetchFn } from '../src/types.ts';

const m3u = readFileSync(new URL('./fixtures/basic.m3u', import.meta.url), 'utf8');
const xml = readFileSync(new URL('./fixtures/basic.xml', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 9, 13, 17, 10);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

let routes: Record<string, () => Response>;
let storage: MemoryStorage;
let service: SourceService;
const fetchFn: FetchFn = async (url) => {
  const u = new URL(url);
  const key = u.pathname.endsWith('player_api.php') ? `api:${u.searchParams.get('action') ?? 'auth'}` : u.pathname;
  const r = routes[key];
  if (!r) throw new TypeError(`no route ${key}`);
  return r();
};

beforeEach(() => {
  routes = { '/p.m3u': () => new Response(m3u), '/epg.xml': () => new Response(xml) };
  storage = new MemoryStorage();
  let n = 0;
  service = new SourceService({ storage, fetch: fetchFn, now: () => NOW, newId: () => `id${++n}` });
});

const m3uInput = { kind: 'm3u' as const, name: 'Mine', playlistUrl: 'http://example.test/p.m3u', epgUrl: 'http://example.test/epg.xml' };

describe('SourceService – m3u', () => {
  test('addSource ingests, persists, activates and reports progress', async () => {
    const progress: number[] = [];
    const { source, result } = await service.addSource(m3uInput, (p) => progress.push(p.count));
    expect(source).toEqual({ ...m3uInput, id: 'id1' });
    expect(result).toEqual({ channelCount: 4, skipped: 1 });
    expect(progress.at(-1)).toBe(5);
    expect(await service.getActiveSourceId()).toBe('id1');
    expect(await storage.getMeta('playlistAt:id1')).toBe(NOW);
    expect((await service.loadIndex('id1')).groupSize('all')).toBe(4);
  });

  test('failed add leaves storage untouched', async () => {
    routes['/p.m3u'] = () => new Response('nope', { status: 403 });
    await expect(service.addSource(m3uInput)).rejects.toBeInstanceOf(SourceAuthError);
    routes['/p.m3u'] = () => new Response('#EXTM3U\n');
    await expect(service.addSource(m3uInput)).rejects.toThrow('no channels');
    delete routes['/p.m3u'];
    await expect(service.addSource(m3uInput)).rejects.toThrow('Could not reach the provider.');
    expect(await service.listSources()).toEqual([]);
    expect(await service.getActiveSourceId()).toBeUndefined();
  });

  test('flags persist through saveFlags/loadIndex', async () => {
    const { source } = await service.addSource(m3uInput);
    const idx = await service.loadIndex(source.id);
    const first = idx.slice('all', 0, 1)[0]!;
    idx.setFavourite(first.id, true);
    await service.saveFlags(source.id, idx);
    expect((await service.loadIndex(source.id)).groupSize('fav')).toBe(1);
  });

  test('refresh timing helpers', async () => {
    const { source } = await service.addSource(m3uInput);
    expect(await service.needsPlaylistRefresh(source.id)).toBe(false);
    expect(await service.needsEpgRefresh(source.id)).toBe(true);
    await storage.setMeta(`playlistAt:${source.id}`, NOW - 13 * 3600_000);
    expect(await service.needsPlaylistRefresh(source.id)).toBe(true);
  });

  test('refreshEpg stores matched in-window programmes; nowNextFor finds them', async () => {
    const { source } = await service.addSource(m3uInput);
    const res = await service.refreshEpg(source.id);
    expect(res).toEqual({ programmes: 2, skipped: 2 });
    expect(await service.needsEpgRefresh(source.id)).toBe(false);
    const channels = (await service.loadIndex(source.id)).slice('all', 0, 10);
    const nn = await service.nowNextFor(source.id, channels);
    const ch1 = channels.find((c) => c.epgId === 'ch1.test')!;
    expect(nn.get(ch1.id)?.now?.title).toBe('Evening Bulletin');
  });

  test('deleteSource removes it and moves active to the next source', async () => {
    const a = await service.addSource(m3uInput);
    const b = await service.addSource({ ...m3uInput, name: 'Second' });
    await service.deleteSource(a.source.id);
    expect((await service.listSources()).map((s) => s.id)).toEqual([b.source.id]);
    expect(await service.getActiveSourceId()).toBe(b.source.id);
    await service.deleteSource(b.source.id);
    expect(await service.getActiveSourceId()).toBeUndefined();
  });
});

describe('SourceService – xtream', () => {
  const xInput = { kind: 'xtream' as const, name: 'X', server: 'http://example.test', username: 'u', password: 'p' };

  test('addSource authenticates and maps streams; short EPG fallback works', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 1, status: 'Active' } });
    routes['api:get_live_categories'] = () => json([{ category_id: '1', category_name: 'News' }]);
    routes['api:get_live_streams'] = () => json([{ stream_id: 7, name: 'Channel 007', category_id: '1', epg_channel_id: 'c7.test', num: 7 }]);
    routes['api:get_short_epg'] = () => json({ epg_listings: [
      { title: btoa('Live Now'), start_timestamp: String(NOW / 1000 - 60), stop_timestamp: String(NOW / 1000 + 60) },
    ] });
    const { source, result } = await service.addSource(xInput);
    expect(result).toEqual({ channelCount: 1, skipped: 0 });
    const [c7] = (await service.loadIndex(source.id)).slice('all', 0, 1);
    expect(c7?.url).toBe('http://example.test/live/u/p/7.ts');
    const nn = await service.nowNextFor(source.id, [c7!]);
    expect(nn.get(c7!.id)?.now?.title).toBe('Live Now');
  });

  test('rejected login surfaces SourceAuthError, server error surfaces SourceNetworkError', async () => {
    routes['api:auth'] = () => json({ user_info: { auth: 0 } });
    await expect(service.addSource(xInput)).rejects.toBeInstanceOf(SourceAuthError);
    routes['api:auth'] = () => json({}, 502);
    await expect(service.addSource(xInput)).rejects.toBeInstanceOf(SourceNetworkError);
  });
});
