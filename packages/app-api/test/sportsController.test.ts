import { describe, expect, test } from 'vitest';
import { ChannelIndex, SportsIndexBuilder, normSide, type Channel, type SportsCandidate, type SportsIndexRecord } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { SportsController, eventTiles, matchTiles, type MatchSettings } from '../src/sportsController.ts';

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
    expect(events[0]!.airings.flatMap((a) => a.channelIds).sort()).toEqual(['c1', 'c2']);
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

// ---------- v2 records (design note live-matches-ranking §3, fixtures §4) ----------

const T = Date.UTC(2026, 9, 19, 18);
const NOW2 = T + 30 * 60_000;
interface P { key: string; title: string; startMin?: number; lenMin?: number; cats?: string[]; live?: boolean; sub?: string; desc?: string; rerun?: boolean }
function v2(progs: P[], now = NOW2): SportsIndexRecord {
  const b = new SportsIndexBuilder(now);
  for (const p of progs) {
    const start = T + (p.startMin ?? 0) * 60_000;
    const extra: { categories?: string[]; live?: true; subTitle?: string; rerun?: true } = {};
    if (p.cats) extra.categories = p.cats;
    if (p.live) extra.live = true;
    if (p.sub) extra.subTitle = p.sub;
    if (p.rerun) extra.rerun = true;
    b.add({ epgId: p.key, title: p.title, start, stop: start + (p.lenMin ?? 115) * 60_000, ...(p.desc ? { desc: p.desc } : {}) }, extra, p.key);
  }
  return b.record(1, now);
}
/** `copies` playlist channels per guide key ("HD", "FHD", "SD"), names with an optional country prefix. */
function channels(keys: number, copies = 1, prefix = (_k: number) => '', from = 1): Channel[] {
  const out: Channel[] = [];
  const q = [' HD', ' FHD', ' SD'];
  let n = from;
  for (let k = 0; k < keys; k++) {
    for (let c = 0; c < copies; c++, n++) out.push(ch(n, `k${k}`, `${prefix(k)}Test Sport ${k}${q[c] ?? ''}`));
  }
  return out;
}
const S0: MatchSettings = { followed: [], pinned: [], hidden: [], categories: [] };
async function tiles(r: SportsIndexRecord, index: ChannelIndex, s: Partial<MatchSettings> = {}, now = NOW2) {
  const sc = new SportsController({ storage: new MemoryStorage(), now: () => now });
  const view = await sc.view('s', r, index, 0);
  return { sc, view, ...matchTiles(view, now, { ...S0, ...s }, sc.aliases()) };
}

describe('SportsController v2: Matches in your guide', () => {
  test('one match on 24 guide channels with 3 playlist copies each: one event, breadth 24, ranks first (fixture 1)', async () => {
    const progs: P[] = Array.from({ length: 24 }, (_, k) => ({ key: `k${k}`, title: 'Northbridge FC v Eastport', cats: ['Football'] }));
    progs.push({ key: 'k24', title: 'Lakeshore v Pinecrest', cats: ['Football'], startMin: 30 });
    const index = new ChannelIndex(channels(25, 3));
    const r = await tiles(v2(progs), index);
    expect(r.row.map((t) => t.title)).toEqual(['Northbridge FC v Eastport']);
    expect(r.all.map((t) => t.title)).toContain('Lakeshore v Pinecrest');
    expect(r.row[0]!.channelCount).toBe(72);
    expect(r.row[0]!.onAir).toBe(true);
    const folded = new ChannelIndex(channels(25, 3), undefined, undefined, { fold: true });
    const f = await tiles(v2(progs), folded);
    expect(f.row[0]!.channelCount).toBe(24);
    expect(f.view.events.find((e) => e.title === 'Northbridge FC v Eastport')!.airings).toHaveLength(24);
  });

  test('prefixed and suffixed feeds join one group with the competition kept (fixtures 2–3)', async () => {
    const progs: P[] = [
      { key: 'k0', title: 'Northbridge FC v Eastport', cats: ['Football'] },
      { key: 'k1', title: 'Northern Cup - Northbridge FC v Eastport', cats: ['Football'] },
      { key: 'k2', title: 'Northern Cup | Northbridge FC v Eastport', cats: ['Football'] },
      { key: 'k3', title: 'Northbridge FC v Eastport - Live', cats: ['Football'] },
      { key: 'k4', title: 'Northbridge FC v Eastport, Round 12', cats: ['Football'] },
      { key: 'k5', title: 'Northbridge FC v Eastport (R)', cats: ['Football'] },
    ];
    const r = await tiles(v2(progs), new ChannelIndex(channels(6)));
    expect(r.all).toHaveLength(1);
    expect(r.all[0]).toMatchObject({ title: 'Northbridge FC v Eastport', competition: 'Northern Cup', channelCount: 5 });
  });

  test('non-sport titles with separators, a studio show and short or tagged slots are not matches (fixtures 4–8, 11)', async () => {
    const progs: P[] = [
      { key: 'k0', title: 'LIVE: Evening News - Weekend Edition' },
      { key: 'k1', title: '(L) Quiz Night - The Final' },
      { key: 'k2', title: 'LIVE Artist x Artist' },
      { key: 'k3', title: 'LIVE: Matchday Studio', cats: ['Football'], lenMin: 180 },
      { key: 'k4', title: 'Northbridge FC - Eastport (Wdh.)', cats: ['Football'] },
      { key: 'k5', title: 'Northbridge FC v Eastport: Höjdpunkter', cats: ['Football'] },
      { key: 'k6', title: 'Northbridge FC v Eastport - Resumen', cats: ['Football'] },
      { key: 'k7', title: 'Northbridge FC v Eastport - Rediffusion', cats: ['Football'] },
      { key: 'k8', title: 'Northbridge FC v Eastport', cats: ['Football'], desc: 'Wiederholung vom Samstag' },
      { key: 'k9', title: 'Harbour City v Kingsgate', cats: ['Football'], lenMin: 50 },
    ];
    const r = await tiles(v2(progs), new ChannelIndex(channels(10)));
    expect(r.all.map((t) => t.title)).toEqual([]);
    const live50 = await tiles(v2([{ key: 'k0', title: 'Harbour City v Kingsgate', cats: ['Football'], lenMin: 50, live: true }]), new ChannelIndex(channels(1)));
    expect(live50.all).toHaveLength(1);
  });

  test('a build-up show before the match never stretches its start (fixture 7)', async () => {
    const progs: P[] = [
      { key: 'k0', title: 'Northbridge v Eastport: Build-up', live: true, startMin: 60, lenMin: 60, cats: ['Football'] },
      { key: 'k0', title: 'Northbridge FC v Eastport', cats: ['Football'], startMin: 120 },
      { key: 'k1', title: 'Northbridge FC v Eastport', cats: ['Football'], startMin: 120 },
    ];
    const r = await tiles(v2(progs), new ChannelIndex(channels(2)));
    expect(r.all).toHaveLength(1);
    expect(r.all[0]!.start).toBe(T + 120 * 60_000);
  });

  test('the same pair again later on one key is a re-air (fixture 9)', async () => {
    const progs: P[] = Array.from({ length: 12 }, (_, k) => ({ key: `k${k}`, title: 'Northbridge FC v Eastport', cats: ['Football'], startMin: 60, live: true }));
    progs.push({ key: 'k12', title: 'Northbridge FC v Eastport', cats: ['Football'], startMin: 270 });
    const r = await tiles(v2(progs), new ChannelIndex(channels(13)));
    expect(r.all).toHaveLength(1);
    expect(r.all[0]!.channelCount).toBe(12);
  });

  test('pinned and hidden competitions; competition chips from the guide (fixture 17)', async () => {
    const progs: P[] = [
      ...Array.from({ length: 8 }, (_, k) => ({ key: `k${k}`, title: 'Northbridge FC v Eastport', cats: ['Football'] })),
      { key: 'k8', title: 'Lakeshore v Pinecrest', cats: ['Football'], sub: 'Test Cup: Round 3', startMin: 60 },
      { key: 'k9', title: 'Harbour City v Kingsgate', cats: ['Football'], sub: 'Test Cup: Round 3', startMin: 90 },
    ];
    const index = new ChannelIndex(channels(10));
    const base = await tiles(v2(progs), index);
    expect(base.all[0]!.title).toBe('Northbridge FC v Eastport');
    const pinned = await tiles(v2(progs), index, { pinned: ['test cup'] });
    expect(pinned.row.map((t) => t.title).slice(0, 2)).toEqual(['Lakeshore v Pinecrest', 'Harbour City v Kingsgate']);
    const hidden = await tiles(v2(progs), index, { hidden: ['test cup'] });
    expect(hidden.all.map((t) => t.title)).toEqual(['Northbridge FC v Eastport']);
    expect(base.sc.filters(base.view).competitions).toEqual([{ id: 'test cup', label: 'Test Cup' }]);
  });

  test("category chips use the guide's own text; picking one filters (fixture 16)", async () => {
    const progs: P[] = [
      { key: 'k0', title: 'Northbridge FC v Eastport', cats: ['Fotboll'] },
      { key: 'k1', title: 'Lakeshore v Pinecrest', cats: ['Ishockey'] },
    ];
    const r = await tiles(v2(progs), new ChannelIndex(channels(2)));
    expect(r.sc.filters(r.view).categories).toEqual([{ id: 'fotboll', label: 'Fotboll' }, { id: 'ishockey', label: 'Ishockey' }]);
    const f = await tiles(v2(progs), new ChannelIndex(channels(2)), { categories: ['fotboll'] });
    expect(f.all.map((t) => t.title)).toEqual(['Northbridge FC v Eastport']);
    expect(f.filtered).toBe(true);
    expect(r.filtered).toBe(false);
  });

  test('a stored category this guide does not offer is ignored: every match shows, unfiltered', async () => {
    const progs: P[] = [
      { key: 'k0', title: 'Northbridge FC v Eastport', cats: ['Fotboll'] },
      { key: 'k1', title: 'Lakeshore v Pinecrest', cats: ['Ishockey'] },
    ];
    const stale = await tiles(v2(progs), new ChannelIndex(channels(2)), { categories: ['handboll'] });
    expect(stale.all.map((t) => t.title).sort()).toEqual(['Lakeshore v Pinecrest', 'Northbridge FC v Eastport']);
    expect(stale.filtered).toBe(false);
    const none = await tiles(v2(progs.map((p) => ({ ...p, cats: ['Sport'] }))), new ChannelIndex(channels(2)), { categories: ['fotboll'] });
    expect(none.all).toHaveLength(2);
    expect(none.filtered).toBe(false);
    const mixed = await tiles(v2(progs), new ChannelIndex(channels(2)), { categories: ['handboll', 'ishockey'] });
    expect(mixed.all.map((t) => t.title)).toEqual(['Lakeshore v Pinecrest']);
    expect(mixed.filtered).toBe(true);
  });

  test('category chip ids survive the setting: inner double spaces collapse and match again', async () => {
    const progs: P[] = [
      { key: 'k0', title: 'Northbridge FC v Eastport', cats: ['Fotboll'] },
      { key: 'k1', title: 'Lakeshore v Pinecrest', cats: ['Ice  Hockey'] },
    ];
    const r = await tiles(v2(progs), new ChannelIndex(channels(2)));
    const chip = r.sc.filters(r.view).categories.find((c) => c.label === 'Ice  Hockey')!;
    expect(chip.id).toBe('ice hockey');
    const f = await tiles(v2(progs), new ChannelIndex(channels(2)), { categories: [chip.id] });
    expect(f.all.map((t) => t.title)).toEqual(['Lakeshore v Pinecrest']);
  });

  test('competitions per category: the guide prefix names the competition; pinned first, hidden out', async () => {
    const progs: P[] = [
      { key: 'k0', title: 'Test Cup: Northbridge FC v Eastport', cats: ['Football'] },
      { key: 'k1', title: 'Test Cup: Lakeshore v Pinecrest', cats: ['Football'], startMin: 30 },
      { key: 'k2', title: 'Northern Cup: Harbour City v Kingsgate', cats: ['Football'], startMin: 60 },
      { key: 'k3', title: 'Northern Cup: Westvale v Southmere', cats: ['Football'], startMin: 90 },
      { key: 'k4', title: 'Ice Series: Rivermouth v Kingsbay', cats: ['Ice Hockey'], startMin: 20 },
      { key: 'k5', title: 'Ice Series: Greenford v Oakridge', cats: ['Ice Hockey'], startMin: 40 },
    ];
    const r = await tiles(v2(progs), new ChannelIndex(channels(6)));
    expect(r.sc.competitions(r.view, 'football', [], []).chips.map((c) => c.label).sort()).toEqual(['Northern Cup', 'Test Cup']);
    expect(r.sc.competitions(r.view, 'ice hockey', [], []).chips.map((c) => c.label)).toEqual(['Ice Series']);
    const pinned = r.sc.competitions(r.view, 'football', ['northern cup'], ['test cup']);
    expect(pinned.chips).toEqual([{ id: 'northern cup', label: 'Northern Cup', pinned: true }]);
  });

  test('a small match on one key stays in See all; on a chosen-country or single-country guide it shows (fixture 12)', async () => {
    const big = (n: number, title: string, startMin: number): P[] => Array.from({ length: n }, (_, k) => ({ key: `k${k}`, title, cats: ['Football'], startMin }));
    const progs: P[] = [
      ...big(24, 'Northbridge FC v Eastport', 0), ...big(20, 'Harbour City v Westvale', 60), ...big(16, 'Kingsgate v Rivermouth Rovers', 90),
      ...big(12, 'Southmere v Lakeshore', 120),
      { key: 'k30', title: 'Player One v Player Two', cats: ['Sport'], live: true, startMin: 10, lenMin: 60 },
    ];
    const multi = await tiles(v2(progs), new ChannelIndex(channels(31, 1, (k) => (k % 2 ? 'UK: ' : 'SE: '))));
    expect(multi.row.map((t) => t.title)).not.toContain('Player One v Player Two');
    expect(multi.all.map((t) => t.title)).toContain('Player One v Player Two');
    const single = await tiles(v2(progs), new ChannelIndex(channels(31, 1, () => 'SE: ')));
    expect(single.row.map((t) => t.title)).toContain('Player One v Player Two');
    // No prefixes at all is unknown, not single-country: the cut-off (25 %, at least 1) still applies.
    const unknown = await tiles(v2(progs), new ChannelIndex(channels(31)));
    expect(unknown.view.countryScope).toBe('unknown');
    expect(unknown.row.map((t) => t.title)).not.toContain('Player One v Player Two');
    expect(unknown.row).toHaveLength(4);
    const chosen = await tiles(v2(progs), new ChannelIndex(channels(31, 1, (k) => (k === 30 ? 'SE: ' : 'UK: '))), { countries: ['SE'] });
    expect(chosen.row.map((t) => t.title)).toContain('Player One v Player Two');
  });

  test('a v1 record (no v, cats or flags) still yields tiles with the old rules (fixture 18)', async () => {
    const index = new ChannelIndex([ch(1, 'e1'), ch(2, 'e2')]);
    const old = rec([cand('e1', 'Northbridge FC', 'Eastport', 0), cand('e2', 'Lakeshore', 'Pinecrest', 3)]);
    const r = await tiles(old, index, {}, NOW);
    expect(r.all.map((t) => t.title)).toEqual(['Northbridge FC v Eastport', 'Lakeshore v Pinecrest']);
    expect(r.row).toHaveLength(2);
    expect(r.sc.filters(r.view)).toEqual({ competitions: [], categories: [] });
  });

  test('performance: 20k candidates over 300 keys with 5 copies each group and rank under 300 ms; ranking alone under 10 ms (fixture 19)', async () => {
    const b = new SportsIndexBuilder(NOW2);
    const teams = Array.from({ length: 400 }, (_, i) => `Team ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}`);
    for (let i = 0; i < 20_000; i++) {
      const key = `k${i % 300}`;
      const m = Math.floor(i / 300);
      const start = T + (((m * 37) % (34 * 60)) - 12 * 60) * 60_000;
      b.add({ epgId: key, title: `${teams[(m * 2) % 400]} v ${teams[(m * 2 + 1) % 400]}`, start, stop: start + 115 * 60_000 }, { categories: ['Football'] }, key);
    }
    const slack = process.env.CI ? 3 : 1;
    const record = b.record(1, NOW2);
    for (const fold of [false, true]) {
      // Combining folds the copies of a guide channel into one row: channelsForEpgKey then returns one channel per row.
      const index = new ChannelIndex([...channels(300, 3), ...channels(300, 2, () => '', 2000)], undefined, undefined, { fold });
      const sc = new SportsController({ storage: new MemoryStorage(), now: () => NOW2 });
      const t0 = performance.now();
      const view = await sc.view('s', record, index, 0);
      matchTiles(view, NOW2, S0, sc.aliases());
      expect(performance.now() - t0).toBeLessThan(300 * slack);
      const t1 = performance.now();
      matchTiles(view, NOW2, S0, sc.aliases());
      expect(performance.now() - t1).toBeLessThan(10 * slack);
    }
  });
});
