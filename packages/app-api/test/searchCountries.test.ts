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
// Second playlist: the four guide channels plus 15 prefix-matching "Northbridge Fan" channels (14 DE, the SE one last).
// The fan channels' tvg-ids are not in the guide, so only the four original channels have programmes.
const fan = (n: number) => {
  const code = n === 15 ? 'SE' : 'DE';
  return [`#EXTINF:-1 tvg-id="f${n}.test" tvg-chno="${n + 10}" group-title="${code} | Sport",Northbridge Fan ${String(n).padStart(2, '0')}`, `http://a.example.test/live/f${n}.ts`];
};
const PLAYLIST_MANY = [
  '#EXTM3U',
  ...entry('DE', 1), ...entry('US', 2), ...entry('SE', 3), ...entry('DK', 4),
  ...Array.from({ length: 15 }, (_, i) => fan(i + 1)).flat(),
  '',
].join('\n');
// A programme whose title also matches "northbridge fan", so the channel section is cut to its with-programmes cap.
const EPG_MANY = EPG.replace('</tv>', `${prog(2, 'Northbridge Fan Show', 3)}</tv>`);
let playlistText = PLAYLIST;
let epgText = EPG;
const fetchFn: FetchFn = async (u) =>
  u === 'http://example.test/p.m3u' ? new Response(playlistText)
    : u === 'http://example.test/epg.xml' ? new Response(epgText,{ headers: { 'content-type': 'application/xml' } })
      : new Response('', { status: 404 });

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); playlistText = PLAYLIST; epgText = EPG; });

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
const groupsOf = (rows: { group: string }[]) => rows.map((r) => r.group.slice(0, 2));

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

  test('a chosen-country channel late in the playlist survives the channel cap', async () => {
    playlistText = PLAYLIST_MANY;
    epgText = EPG_MANY;
    const api = await setup();
    const off = await api.search('northbridge fan', 50);
    expect(off.channels).toHaveLength(10); // the cap when programmes also match
    expect(off.channels.some((c) => c.group.startsWith('SE'))).toBe(false); // number 15 is cut in playlist order
    await setRegions(api, { mode: 'first', codes: ['SE'] });
    const on = await api.search('northbridge fan', 50);
    expect(on.channels).toHaveLength(10);
    expect(on.channels[0]!.group.slice(0, 2)).toBe('SE');
    // Limit below the prefix-match count: the chosen country still leads.
    const small = await api.search('northbridge fan', 5);
    expect(small.channels[0]!.group.slice(0, 2)).toBe('SE');
  });
});
