import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, regionsKey, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { AppApi } from '../src/appApi.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 20, 18, 0);
const entry = (group: string, name: string, n: number, attrs = '') =>
  [`#EXTINF:-1 ${attrs}group-title="${group}",${name}`, `http://a.example.test/live/${n}.ts`];
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

async function setup(st: MemoryStorage = storage) {
  const events: AppEvent[] = [];
  const service = new SourceService({ storage: st, fetch: fetchFn, now: () => NOW });
  const api = new AppApi({ service, storage: st, emit: (e) => events.push(e), now: () => NOW });
  live.push(api);
  const added = await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/p.m3u' });
  await api.idle();
  return { api, events, service, sourceId: added.sourceId };
}
const providerGroupIds = async (api: AppApi) => (await api.getGroups()).filter((g) => g.id.startsWith('g:')).map((g) => g.id);

describe('AppApi regions', () => {
  test('getRegions: detected countries with counts, not sure, other; largest first', async () => {
    const { api } = await setup();
    const r = await api.getRegions();
    expect(r).toMatchObject({ mode: 'off', codes: [], stale: false });
    expect(r.countries).toEqual([
      { code: 'SE', label: 'Sweden', groups: 2, channels: 2 },
      { code: 'DK', label: 'Denmark', groups: 2, channels: 2 },
    ]);
    expect(r.notSure).toEqual({ groups: 1, channels: 1 });
    expect(r.other).toEqual({ groups: 1, channels: 1 });
  });

  test('setRegions only: Live TV shows the chosen country and undetected groups; first reorders', async () => {
    const { api, events } = await setup();
    events.length = 0;
    await api.setRegions({ codes: ['DK'], mode: 'only' });
    expect(await providerGroupIds(api)).toEqual(['g:DK | Synthetic News', 'g:DK | Synthetic Docs', 'g:Mixed', 'g:Weekly (FI)']);
    expect(events.some((e) => e.type === 'layoutChanged')).toBe(true);
    await api.setRegions({ codes: ['DK'], mode: 'first' });
    expect((await providerGroupIds(api))[0]).toBe('g:DK | Synthetic News');
    expect(await providerGroupIds(api)).toHaveLength(6);
    expect((await api.getSettings()).regions).toEqual({ codes: ['DK'], mode: 'first' });
  });

  test('setGroupVisibility and setGroupRegion go through the layout', async () => {
    const { api } = await setup();
    await api.setRegions({ codes: ['SE'], mode: 'only' });
    await api.setGroupVisibility(['g:DK | Synthetic Docs'], 'show');
    expect(await providerGroupIds(api)).toContain('g:DK | Synthetic Docs');
    await api.setGroupVisibility(['g:DK | Synthetic Docs'], 'rule');
    expect(await providerGroupIds(api)).not.toContain('g:DK | Synthetic Docs');
    await api.setGroupVisibility(['g:SE | Synthetic Kids'], 'hide');
    expect(await providerGroupIds(api)).not.toContain('g:SE | Synthetic Kids');
    await api.setGroupRegion('g:Mixed', ['DK']);
    expect(await providerGroupIds(api)).not.toContain('g:Mixed');
    expect((await api.getLayout()).groupRegion).toEqual({ 'g:Mixed': ['DK'] });
  });

  test('stale: chosen countries this source lacks turn the rule off and report it', async () => {
    const { api } = await setup();
    await api.setRegions({ codes: ['PL'], mode: 'only' });
    expect(await providerGroupIds(api)).toHaveLength(6);
    expect((await api.getRegions()).stale).toBe(true);
  });

  test('cold start reads the cached record; a missing one is rebuilt after activation, not before', async () => {
    const first = await setup();
    await first.api.setRegions({ codes: ['DK'], mode: 'only' });
    await storage.setMeta(regionsKey(first.sourceId), null);
    const service = new SourceService({ storage, fetch: fetchFn, now: () => NOW });
    const api = new AppApi({ service, storage, emit: () => {}, now: () => NOW });
    live.push(api);
    await api.init();
    // Nothing detected yet: the rule cannot match, so nothing is hidden on the first answer.
    expect(await providerGroupIds(api)).toHaveLength(6);
    await api.idle();
    expect(await providerGroupIds(api)).toEqual(['g:DK | Synthetic News', 'g:DK | Synthetic Docs', 'g:Mixed', 'g:Weekly (FI)']);
    expect(await storage.getMeta(regionsKey(first.sourceId))).toBeTruthy();
  });

  test('the companion state carries your countries and the sure detections', async () => {
    const { api } = await setup();
    await api.setRegions({ codes: ['SE'], mode: 'only' });
    const st = await api.getCompanionState();
    expect(st.regions).toEqual({
      mode: 'only', codes: ['SE'],
      keys: { 'g:SE | Synthetic News': ['SE'], 'g:SE | Synthetic Kids': ['SE'], 'g:DK | Synthetic News': ['DK'], 'g:DK | Synthetic Docs': ['DK'] },
    });
    expect(st.groups.find((g) => g.id === 'g:DK | Synthetic Docs')).toMatchObject({ hidden: false, regionHidden: true });
  });
});

describe('AppApi regions: first mode plays your country first', () => {
  const FOLD = [
    '#EXTM3U',
    ...entry('DK | Synthetic Nordic', 'DK | Synthetic One FHD', 11, 'tvg-id="one.example" '),
    ...entry('SE | Synthetic Nordic', 'SE | Synthetic One HD', 12, 'tvg-id="one.example" '),
    ...entry('SE | Synthetic Kids', 'SE | Synthetic Two', 13),
    '',
  ].join('\n');
  const foldFetch: FetchFn = async (u) => (u === 'http://example.test/f.m3u' ? new Response(FOLD) : new Response('', { status: 404 }));

  test('a chosen-country HD stream beats another country FHD in getPlayable and liveSources', async () => {
    const service = new SourceService({ storage, fetch: foldFetch, now: () => NOW });
    const api = new AppApi({ service, storage, emit: () => {}, now: () => NOW });
    live.push(api);
    await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/f.m3u' });
    await api.idle();
    await api.saveSettings({ combineChannels: true });
    // Off: best quality first, so the DK FHD stream leads.
    const row = (await api.getChannelSlice('all', 0, 10)).rows.find((r) => r.sourceCount === 2)!;
    expect(row).toBeDefined();
    const dk = (await api.liveSources(row.id))[0]!.id;
    expect((await api.getPlayable(row.id))!.url).toBe('http://a.example.test/live/11.ts');
    await api.setRegions({ codes: ['SE'], mode: 'first' });
    const sources = await api.liveSources(row.id);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.id).not.toBe(dk);
    expect((await api.getPlayable(row.id))!.url).toBe('http://a.example.test/live/12.ts');
  });
});
