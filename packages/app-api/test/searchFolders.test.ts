import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { AppApi } from '../src/appApi.ts';

// Spec 2026-10-24 §3.1: folders matching a search, in their own section.
const NOW = Date.UTC(2026, 9, 24, 15, 10);
const entry = (group: string, name: string, n: number) =>
  [`#EXTINF:-1 tvg-chno="${n}" group-title="${group}",${name}`, `http://a.example.test/live/${n}.ts`];
const PLAYLIST = [
  '#EXTM3U',
  ...entry('DE | Sport', 'Synthetic One', 1), ...entry('DE | Sport', 'Synthetic Two', 2),
  ...entry('SE | Sport', 'Synthetic Three', 3),
  ...entry('DK | Sport Extra', 'Synthetic Four', 4),
  ...entry('SE | Kids', 'Synthetic Five', 5),
  ...entry('Motorsport Mix', 'Synthetic Six', 6),
  '',
].join('\n');
const fetchFor = (playlist: string): FetchFn => async (u) => (u === 'http://example.test/p.m3u' ? new Response(playlist) : new Response('', { status: 404 }));

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

async function setup(playlist = PLAYLIST) {
  const service = new SourceService({ storage, fetch: fetchFor(playlist), now: () => NOW });
  const api = new AppApi({ service, storage, emit: () => undefined, now: () => NOW });
  live.push(api);
  await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/p.m3u' });
  await api.idle();
  return api;
}
const names = (r: { folders: { name: string }[] }) => r.folders.map((f) => f.name);

describe('Search – folders', () => {
  test('provider folders whose name contains the query; never All channels or Recently watched', async () => {
    const api = await setup();
    const r = await api.search('sport', 50);
    expect(names(r)).toEqual(['DE | Sport', 'SE | Sport', 'DK | Sport Extra', 'Motorsport Mix']);
    expect(r.folders[0]).toEqual({ kind: 'live', id: 'g:DE | Sport', name: 'DE | Sport', count: 2 });
    expect(names(await api.search('all ch', 50))).toEqual([]);
    expect(names(await api.search('recent', 50))).toEqual([]);
    expect((await api.search('', 50)).folders).toEqual([]);
  });

  test('prefix matches come before contains matches', async () => {
    const api = await setup();
    expect(names(await api.search('motor', 50))).toEqual(['Motorsport Mix']);
    expect(names(await api.search('se |', 50))).toEqual(['SE | Sport', 'SE | Kids']);
    expect(names(await api.search('sport', 50))[3]).toBe('Motorsport Mix');
  });

  test('your countries first in pick order among provider folders; the user\'s lists before provider folders', async () => {
    const api = await setup();
    await api.setRegions({ mode: 'first', codes: ['DK', 'SE'] });
    expect(names(await api.search('sport', 50))).toEqual(['DK | Sport Extra', 'SE | Sport', 'DE | Sport', 'Motorsport Mix']);
    const one = (await api.searchChannels('synthetic one', 1))[0]!.id;
    await api.toggleFavourite(one);
    // Favourites is the user's first list: its name matches "fav".
    const fav = await api.search('favour', 50);
    expect(fav.folders[0]).toMatchObject({ kind: 'live', name: 'Favourites', count: 1 });
  });

  test('a user list comes before a provider folder that matches the same query', async () => {
    const api = await setup();
    const one = (await api.searchChannels('synthetic one', 1))[0]!.id;
    await api.applyLayoutOps([{ op: 'createList', id: 'picks', name: 'Sport Picks' }, { op: 'addToList', listId: 'picks', channelIds: [one] }]);
    const r = await api.search('sport', 50);
    expect(r.folders[0]).toMatchObject({ kind: 'live', name: 'Sport Picks', count: 1 });
    expect(names(r)).toEqual(['Sport Picks', 'DE | Sport', 'SE | Sport', 'DK | Sport Extra', 'Motorsport Mix']);
  });

  test('an empty user list is not a folder hit', async () => {
    const api = await setup();
    await api.applyLayoutOps([{ op: 'createList', id: 'empty', name: 'Sport Empty' }]);
    expect(names(await api.search('sport', 50))).not.toContain('Sport Empty');
    expect(names(await api.search('empty', 50))).toEqual([]);
  });

  test('at most 20 folders', async () => {
    const many = ['#EXTM3U', ...Array.from({ length: 25 }, (_, i) => entry(`DE | Sport ${String(i + 1).padStart(2, '0')}`, `Synthetic ${i + 1}`, i + 1)).flat(), ''].join('\n');
    const api = await setup(many);
    expect((await api.search('sport', 50)).folders).toHaveLength(20);
  });

  test('a hidden folder is not listed', async () => {
    const api = await setup();
    await api.applyLayoutOps([{ op: 'hideGroups', ids: ['g:Motorsport Mix'] }]);
    expect(names(await api.search('motor', 50))).toEqual([]);
  });
});
