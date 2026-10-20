import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, VOD_ALL, VodService, type RegionSettings, type VodItem, type VodList } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import { VodController } from '../src/vodController.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 20, 18, 0);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 1, movies: 1, series: 1, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const movie = (n: number, title: string, categoryId: string): VodItem => ({ id: `SRC:m${n}`, kind: 'movie', title, categoryId, xid: n });

let storage: MemoryStorage;
let settings: { combineDuplicates: boolean; preferredLanguages: string[]; combineCategories: boolean; regions: RegionSettings };
beforeEach(() => {
  storage = new MemoryStorage();
  settings = { combineDuplicates: true, preferredLanguages: [], combineCategories: false, regions: { codes: [], mode: 'off' } };
});

async function setup() {
  const deps = { storage, fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => NOW, fallbackGapMs: 0 };
  const sources = new SourceService(deps);
  const vod = new VodService(deps);
  const { source } = await sources.addSource({ kind: 'xtream', name: 'Fake', server: server.url, username: 'test', password: 'test' });
  const id = source.id;
  const fix = (it: VodItem): VodItem => ({ ...it, id: it.id.replace('SRC', id) });
  const movies: VodList = {
    items: [
      movie(1, 'Synthetic Film (2021)', '1'),
      movie(2, 'Synthetic Film (2021)', '2'),
      movie(3, 'Example Story (2020)', '2'),
      movie(4, 'Plain Title', '3'),
    ].map(fix),
    categories: [
      { id: '1', kind: 'movie', name: 'SE | Action', count: 1 },
      { id: '2', kind: 'movie', name: 'EN | Action', count: 2 },
      { id: '3', kind: 'movie', name: 'Classics', count: 1 },
    ],
  };
  await storage.replaceVod(id, 'movie', movies);
  await storage.setMeta(`vodAt:movie:${id}`, NOW);
  await storage.replaceVod(id, 'series', { items: [], categories: [] });
  await storage.setMeta(`vodAt:series:${id}`, NOW);
  const events: AppEvent[] = [];
  const c = new VodController({
    vod, emit: (e) => events.push(e), record: (_w, err) => (err instanceof Error ? err : new Error(String(err))),
    settings: async () => settings, locale: () => 'en-US',
  });
  c.reset(id);
  return { c, id, events };
}
const catIds = async (c: VodController) => (await c.categories('movie')).map((x) => x.id).filter((x) => !x.startsWith('vod:') && x !== VOD_ALL);

describe('VodController categories', () => {
  test('provider categories by default; the opt-in merges across languages', async () => {
    const { c } = await setup();
    expect(await catIds(c)).toEqual(['1', '2', '3']);
    settings.combineCategories = true;
    c.settingsChanged(true);
    expect((await c.categories('movie')).map((x) => x.name)).toContain('Action');
    expect((await catIds(c)).length).toBe(2);
  });

  test('region rule over categories: only hides other languages, unknown stays; regions() counts', async () => {
    const { c } = await setup();
    settings.regions = { codes: ['SE'], mode: 'only' };
    c.settingsChanged(true);
    expect(await catIds(c)).toEqual(['1', '3']);
    const all = await c.slice('movie', VOD_ALL, 'provider', 0, 10);
    expect(all.rows.map((r) => r.title)).toEqual(['Synthetic Film', 'Plain Title']);
    const r = await c.regions('movie');
    expect(r.countries.map((x) => x.code)).toEqual(['lang:en', 'SE']);
    expect(r).toMatchObject({ mode: 'only', stale: false, other: { groups: 1, channels: 1 } });
  });

  test('layout ops hide, show and order categories', async () => {
    const { c } = await setup();
    await c.applyLayoutOps('movie', [{ op: 'hideCategories', ids: ['1'] }, { op: 'setCategoryOrder', ids: ['3'] }]);
    expect(await catIds(c)).toEqual(['3', '2']);
    settings.regions = { codes: ['SE'], mode: 'only' };
    c.settingsChanged(true);
    await c.applyLayoutOps('movie', [{ op: 'showCategories', ids: ['2'] }]);
    expect(await catIds(c)).toEqual(['3', '2']);
  });
});
