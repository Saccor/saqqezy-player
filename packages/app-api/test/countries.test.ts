import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SourceService, VodService, type FetchFn, type VodList } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { AppApi } from '../src/appApi.ts';

const NOW = Date.UTC(2026, 9, 22, 18, 0);
const entry = (group: string, name: string, n: number) => [`#EXTINF:-1 group-title="${group}",${name}`, `http://a.example.test/live/${n}.ts`];
const PLAYLIST = [
  '#EXTM3U',
  ...entry('SE | Synthetic News', 'Synthetic One', 1),
  ...entry('SE | Synthetic Kids', 'Synthetic Two', 2),
  ...entry('DK | Synthetic News', 'Synthetic Three', 3),
  ...entry('DK | Synthetic Docs', 'Synthetic Four', 4),
  ...entry('Mixed', 'Synthetic Five', 5),
  ...entry('Weekly (FI)', 'Synthetic Six', 6),
  '',
].join('\n');
const fetchFn: FetchFn = async (u) => (u === 'http://example.test/p.m3u' ? new Response(PLAYLIST) : new Response('', { status: 404 }));

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

async function setup() {
  const deps = { storage, fetch: fetchFn, now: () => NOW };
  const service = new SourceService(deps);
  const vod = new VodService(deps);
  const api = new AppApi({ service, storage, vod, emit: () => {}, now: () => NOW });
  live.push(api);
  const added = await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/p.m3u' });
  await api.idle();
  return { api, vod, sourceId: added.sourceId };
}
const shape = async (api: AppApi) => (await api.getGroups()).map((g) => (g.fold ? `${g.id}@${g.fold}` : g.id));

describe('AppApi: Your countries', () => {
  test('getCountryChoices: Live counts, this TV\'s country first once the TV has said it', async () => {
    const { api } = await setup();
    let c = await api.getCountryChoices();
    expect(c.choices.map((x) => [x.key, x.live])).toEqual([['DK', 2], ['SE', 2]]);
    expect(c).toMatchObject({ regions: { codes: [], mode: 'off' }, foldCountries: true, combineCategories: false, stale: false, counts: { live: 0 } });
    expect(c.deviceCountry).toBeUndefined();
    await api.setDeviceCountry('se');
    c = await api.getCountryChoices();
    expect(c.deviceCountry).toBe('SE');
    expect(c.choices[0]!.key).toBe('SE');
    await api.setDeviceCountry('PL');
    expect((await api.getCountryChoices()).deviceCountry).toBeUndefined();
    await api.setDeviceCountry(undefined);
    expect((await api.getCountryChoices()).choices[0]!.key).toBe('DK');
  });

  test('everyone gets the fold once two countries are detected', async () => {
    const { api } = await setup();
    expect(await shape(api)).toEqual([
      'all', 'fav', 'g:DK | Synthetic News@DK', 'g:DK | Synthetic Docs@DK', 'g:SE | Synthetic News@SE', 'g:SE | Synthetic Kids@SE', 'g:Mixed', 'g:Weekly (FI)',
    ]);
  });

  test('setCountries: one save; combining turns off only with codes and a mode that is not off; fresh counts back', async () => {
    const { api } = await setup();
    await api.saveSettings({ combineCategories: true });
    let c = await api.setCountries({ codes: ['SE'], mode: 'off' });
    expect(c.combineCategories).toBe(true);
    c = await api.setCountries({ mode: 'first' });
    expect(c).toMatchObject({ regions: { codes: ['SE'], mode: 'first' }, combineCategories: false, counts: { live: 2 } });
    expect(await shape(api)).toEqual([
      'all', 'fav', 'g:SE | Synthetic News', 'g:SE | Synthetic Kids', 'g:DK | Synthetic News@DK', 'g:DK | Synthetic Docs@DK', 'g:Mixed', 'g:Weekly (FI)',
    ]);
    c = await api.setCountries({ foldCountries: false });
    expect(c.foldCountries).toBe(false);
    expect((await api.getGroups()).some((g) => g.fold)).toBe(false);
    expect((await api.getSettings())).toMatchObject({ foldCountries: false, regions: { codes: ['SE'], mode: 'first' }, combineCategories: false });
  });

  test('stale: picks this source lacks', async () => {
    const { api } = await setup();
    const c = await api.setCountries({ codes: ['PL'], mode: 'first' });
    expect(c).toMatchObject({ stale: true, counts: { live: 0 } });
  });

  test('VOD counts come from a catalogue already shaped this session; getCountryChoices never loads one', async () => {
    const { api, vod, sourceId } = await setup();
    const movies: VodList = {
      items: [
        { id: `${sourceId}:m1`, kind: 'movie', title: 'Synthetic Film', categoryId: '1' },
        { id: `${sourceId}:m2`, kind: 'movie', title: 'Example Story', categoryId: '2' },
        { id: `${sourceId}:m3`, kind: 'movie', title: 'Plain Title', categoryId: '3' },
      ],
      categories: [
        { id: '1', kind: 'movie', name: 'SE | Action', count: 1 },
        { id: '2', kind: 'movie', name: 'EN | Action', count: 1 },
        { id: '3', kind: 'movie', name: 'Classics', count: 1 },
      ],
    };
    await storage.replaceVod(sourceId, 'movie', movies);
    await storage.setMeta(`vodAt:movie:${sourceId}`, NOW);
    const load = vi.spyOn(vod, 'storedCatalog');
    const before = await api.getCountryChoices();
    expect(load).not.toHaveBeenCalled();
    expect(before.choices.every((x) => x.movies === undefined)).toBe(true);
    await api.getVodCategories('movie');
    expect(load).toHaveBeenCalledTimes(1);
    const after = await api.getCountryChoices();
    expect(load).toHaveBeenCalledTimes(1);
    expect(after.choices.find((x) => x.key === 'SE')).toMatchObject({ live: 2, movies: 1 });
    expect(after.choices.find((x) => x.key === 'lang:en')).toMatchObject({ live: 0, movies: 1, isLanguage: true, label: 'English' });
    // A pick regroups (the resident catalogue is dropped); the counts stay.
    const picked = await api.setCountries({ codes: ['SE'], mode: 'first' });
    expect(picked.counts).toEqual({ live: 2, movies: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
