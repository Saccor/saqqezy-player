import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { AppApi } from '../src/appApi.ts';

// Guides that tag no sport category and mark nothing live: a match titled "Side - Side" on channels whose folder or
// own name says sport still reaches the On now row. Synthetic names only.
const NOW = Date.UTC(2026, 9, 24, 17, 20);
const H = 3_600_000;
const xmlDate = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const entry = (n: number, group: string, name: string) =>
  [`#EXTINF:-1 tvg-id="c${n}.test" tvg-chno="${n}" group-title="${group}",${name}`, `http://a.example.test/live/${n}.ts`];
const SPORT_PLAYLIST = ['#EXTM3U',
  ...entry(1, 'XX| SPORT', 'Synthetic One'), ...entry(2, 'XX| SPORT', 'Synthetic Two'),
  ...entry(3, 'YY| Mixed', 'Synthetic Football 3'), ...entry(4, 'XX| News', 'Synthetic News'), ''].join('\n');
const PLAIN_PLAYLIST = ['#EXTM3U',
  ...entry(1, 'XX| News', 'Synthetic One'), ...entry(2, 'XX| News', 'Synthetic Two'),
  ...entry(3, 'YY| Mixed', 'Synthetic Three'), ...entry(4, 'XX| News', 'Synthetic News'), ''].join('\n');
// The same match on all four guide channels, on air since 50 minutes ago; no <category>, no <live/>.
const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>${[1, 2, 3, 4].map((n) => `<channel id="c${n}.test"><display-name>C${n}</display-name></channel>`).join('')}`
  + [1, 2, 3, 4].map((n) => `<programme start="${xmlDate(NOW - 50 * 60_000)}" stop="${xmlDate(NOW + 70 * 60_000 + H)}" channel="c${n}.test"><title>Northbridge FC - Eastport</title></programme>`).join('')
  + '</tv>';

let playlistText = SPORT_PLAYLIST;
const fetchFn: FetchFn = async (u) =>
  u === 'http://example.test/p.m3u' ? new Response(playlistText)
    : u === 'http://example.test/epg.xml' ? new Response(EPG, { headers: { 'content-type': 'application/xml' } })
      : new Response('', { status: 404 });

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); playlistText = SPORT_PLAYLIST; });

async function setup() {
  const service = new SourceService({ storage, fetch: fetchFn, now: () => NOW });
  const api = new AppApi({ service, storage, emit: () => undefined, now: () => NOW });
  live.push(api);
  await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/p.m3u', epgUrl: 'http://example.test/epg.xml' });
  await api.idle();
  await api.refresh('epg');
  await api.idle();
  return api;
}

describe('On now – guides with no sport categories', () => {
  test('a "Side - Side" match on sport-named channels is on the On now row, live, with those channels', async () => {
    const api = await setup();
    const home = await api.getStartHome();
    const row = home.rows.find((r) => r.id === 'sports');
    expect(row?.title).toBe('On now');
    const first = row!.cells[0]!;
    expect(first.type).toBe('event');
    if (first.type !== 'event') return;
    expect(first.event.sides).toEqual(['Northbridge FC', 'Eastport']);
    expect(first.event.onAir).toBe(true);
    // The three sport-named channels (two by folder, one by its own name); the news channel's airing is not a match.
    expect(first.event.channelCount).toBe(3);
  });

  test('the same guide on channels with no sport in their names stays out (no category, nothing live)', async () => {
    playlistText = PLAIN_PLAYLIST;
    const api = await setup();
    const home = await api.getStartHome();
    expect(home.rows.find((r) => r.id === 'sports')).toBeUndefined();
  });
});
