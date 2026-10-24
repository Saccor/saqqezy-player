import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { AppApi } from '../src/appApi.ts';

// Spec 2026-10-24 §2.2–2.3: your countries (pick order) come first in every Search section and in the match picker.
// Synthetic playlist and guide: one channel per country folder, all airing the same match now; one later airing.
const NOW = Date.UTC(2026, 9, 24, 15, 10);
const xmlDate = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const H = 3_600_000;
const entry = (code: string, n: number, name = `${code} Synthetic Sport`) =>
  [`#EXTINF:-1 tvg-id="c${n}.test" tvg-chno="${n}" group-title="${code} | Sport",${name}`, `http://a.example.test/live/${n}.ts`];
const PLAYLIST = [
  '#EXTM3U',
  ...entry('DE', 1), ...entry('US', 2), ...entry('SE', 3), ...entry('DK', 4),
  ...entry('DE', 5, 'Northbridge Fan TV'), ...entry('SE', 6, 'Northbridge Fan TV'),
  '',
].join('\n');
const prog = (n: number, title: string, startH: number, lenH = 2) =>
  `<programme start="${xmlDate(NOW + startH * H)}" stop="${xmlDate(NOW + (startH + lenH) * H)}" channel="c${n}.test"><title>${title}</title><category>Sport</category></programme>`;
const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>${[1, 2, 3, 4].map((n) => `<channel id="c${n}.test"><display-name>C${n}</display-name></channel>`).join('')}`
  + [1, 2, 3, 4].map((n) => prog(n, 'Northbridge FC v Eastport', -0.5)).join('')
  // Later: DE at +3 h, DK one minute after it.
  + prog(1, 'Eastport v Westvale', 3) + prog(4, 'Eastport v Westvale', 3 + 1 / 60)
  + '</tv>';
const fetchFn: FetchFn = async (u) =>
  u === 'http://example.test/p.m3u' ? new Response(PLAYLIST)
    : u === 'http://example.test/epg.xml' ? new Response(EPG, { headers: { 'content-type': 'application/xml' } })
      : new Response('', { status: 404 });

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

async function setup() {
  const service = new SourceService({ storage, fetch: fetchFn, now: () => NOW });
  const api = new AppApi({ service, storage, emit: () => undefined, now: () => NOW });
  live.push(api);
  await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/p.m3u', epgUrl: 'http://example.test/epg.xml' });
  await api.idle();
  await api.refresh('epg');
  await api.idle();
  // The first search starts the title index load; the second has programme hits.
  await api.search('x', 1);
  await api.idle();
  return api;
}
// A regions change rebuilds the index and drops the title index: search once to reload it, then wait.
async function setRegions(api: AppApi, regions: Parameters<AppApi['setRegions']>[0]) {
  await api.setRegions(regions);
  await api.idle();
  await api.search('x', 1);
  await api.idle();
}
const groupsOf =(rows: { group: string }[]) => rows.map((r) => r.group.slice(0, 2));

describe('Search – your countries first', () => {
  test('off: today\'s order (playlist order within a title)', async () => {
    const api = await setup();
    const r = await api.search('northbridge', 50);
    expect(groupsOf(r.onNow.map((h) => h.channel))).toEqual(['DE', 'US', 'SE', 'DK']);
    expect(groupsOf(r.channels)).toEqual(['DE', 'SE']);
  });

  test('on: channels, on now and later put the chosen countries first in pick order', async () => {
    const api = await setup();
    await setRegions(api, { mode: 'first', codes: ['DK', 'SE'] });
    const r = await api.search('northbridge', 50);
    expect(groupsOf(r.onNow.map((h) => h.channel))).toEqual(['DK', 'SE', 'DE', 'US']);
    expect(groupsOf(r.channels)).toEqual(['SE', 'DE']);
    const later = await api.search('eastport v westvale', 50);
    expect(later.later).toHaveLength(1);
    expect(later.later[0]!.channel.group.slice(0, 2)).toBe('DK'); // the chosen country's airing, one minute later
    expect(later.later[0]!.more).toBe(1);
  });

  test('a favourite comes before a chosen country', async () => {
    const api = await setup();
    await setRegions(api, { mode: 'first', codes: ['DK'] });
    const us = (await api.search('northbridge', 50)).onNow.find((h) => h.channel.group.startsWith('US'))!;
    expect(await api.toggleFavourite(us.channel.id)).toBe(true);
    const r = await api.search('northbridge', 50);
    expect(groupsOf(r.onNow.map((h) => h.channel))).toEqual(['US', 'DK', 'DE', 'SE']);
  });
});
