import { describe, expect, test } from 'vitest';
import { ChannelIndex, normSide, type Channel, type SportsCandidate, type SportsIndexRecord } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { SportsController, eventTiles } from '../src/sportsController.ts';

const H = 3600_000;
const NOW = Date.UTC(2026, 9, 19, 18, 10);
const ch = (n: number, epg: string, name = `Channel ${String(n).padStart(3, '0')}`): Channel =>
  ({ id: `c${n}`, sourceId: 's', name, url: `http://example.test/${n}.ts`, group: 'G', epgId: epg, number: n });
const cand = (epg: string, a: string, b: string, startH = 0, durH = 2, live = false): SportsCandidate => ({
  epgKey: epg, start: Date.UTC(2026, 9, 19, 18) + startH * H, stop: Date.UTC(2026, 9, 19, 18) + (startH + durH) * H,
  title: `${a} v ${b}`, nt: `${a} v ${b}`.toLowerCase(), ns: [normSide(a), normSide(b)], sides: [a, b], live,
});
const rec = (candidates: SportsCandidate[]): SportsIndexRecord => ({ gen: 1, built: NOW, candidates, truncated: false });

describe('SportsController', () => {
  test('maps candidates to visible channels, applies the offset, groups and drops ended events', async () => {
    const index = new ChannelIndex([ch(1, 'e1'), ch(2, 'e2'), ch(3, 'e3')]);
    const sc = new SportsController({ storage: new MemoryStorage(), now: () => NOW });
    const events = await sc.events('s', rec([
      cand('e1', 'Northbridge FC', 'Eastport'), cand('e2', 'Eastport', 'Northbridge'),
      cand('e3', 'Lakeshore', 'Pinecrest', -5, 2), cand('nobody', 'Harbour City', 'Kingsgate'),
    ]), index, 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.airings.map((a) => a.channelId).sort()).toEqual(['c1', 'c2']);
    expect(events[0]!.start).toBe(Date.UTC(2026, 9, 19, 19));
  });

  test('regroups after 30 minutes so events entering the 24 h window appear', async () => {
    const index = new ChannelIndex([ch(1, 'e1'), ch(2, 'e2')]);
    let t = NOW;
    const sc = new SportsController({ storage: new MemoryStorage(), now: () => t });
    const r = rec([cand('e1', 'Northbridge FC', 'Eastport'), cand('e2', 'Lakeshore', 'Pinecrest', 26, 2)]);
    const first = await sc.events('s', r, index, 0);
    expect(first).toHaveLength(1);
    t = NOW + 10 * 60_000;
    expect(await sc.events('s', r, index, 0)).toStrictEqual(first);
    t = NOW + 2 * H;
    const later = await sc.events('s', r, index, 0);
    expect(later.map((e) => e.title)).toEqual(['Lakeshore v Pinecrest']); // the first one has ended
  });

  test('learned aliases are stored and used on the next grouping', async () => {
    const storage = new MemoryStorage();
    const index = new ChannelIndex([ch(1, 'e1'), ch(2, 'e2'), ch(3, 'e3')]);
    const sc = new SportsController({ storage, now: () => NOW });
    await sc.events('s', rec([cand('e1', 'Harbour City', 'Westvale United'), cand('e2', 'Harbour City', 'Westvale Unitd'), cand('e3', 'Harbour City', 'Westvale Unitd')]), index, 0);
    expect(await storage.getMeta('sportsAliases')).toEqual([['westvale unitd', 'westvale united']]);
    const again = new SportsController({ storage, now: () => NOW });
    await again.events('s', rec([]), index, 0);
    expect(again.aliases().get('westvale unitd')).toBe('westvale united');
  });

  test('eventTiles: followed first, then live now, then start; channel counts', async () => {
    const index = new ChannelIndex([ch(1, 'e1'), ch(2, 'e2'), ch(3, 'e3')]);
    const sc = new SportsController({ storage: new MemoryStorage(), now: () => NOW });
    const events = await sc.events('s', rec([
      cand('e1', 'Northbridge FC', 'Eastport', 0), cand('e2', 'Lakeshore', 'Pinecrest', 3), cand('e3', 'Rivermouth Rovers', 'Kingsgate', 1),
    ]), index, 0);
    const tiles = eventTiles(events, NOW, ['Kingsgate'], new Map());
    expect(tiles.map((t) => t.title)).toEqual(['Rivermouth Rovers v Kingsgate', 'Northbridge FC v Eastport', 'Lakeshore v Pinecrest']);
    expect(tiles[0]!.followed).toBe(true);
    expect(tiles[1]!.channelCount).toBe(1);
  });
});
