/**
 * Matches in your guide: the active source's candidates on the user's visible channels, grouped and ranked (spec §5.4;
 * design note live-matches-ranking §3). v2 index records group per guide channel (per fold row when combining) and
 * rank with `rankMatches`; v1 records keep the old rules until the next guide refresh.
 */
import {
  MATCHES_ALL_CAP, MATCHES_ROW_CAP, MATCH_FLAGS, SPORTS_INDEX_VERSION, categoryKey, competitionKey, groupEvents, isFollowed,
  isSportCategory, matchFilters, parseChannelName, rankMatches, reairKeys,
  type ChannelIndex, type CountryScope, type GroupInput, type MatchEvent, type MatchFilters, type SportsCandidate, type SportsGroup, type SportsIndexRecord, type Storage,
} from '@iptv/core';
import type { SportsEventTile } from './types.ts';

/** One guide channel (or fold row) airing an event: the playlist channels it maps to, after the guide offset. */
export interface EventAiring {
  channelIds: string[];
  /** Guide key, or the fold row id when combining: what breadth counts. */
  gk: string;
  epgKey: string;
  start: number; stop: number;
  cand?: SportsCandidate;
}

const H = 3600_000;
const ALIASES_KEY = 'sportsAliases';
const ALIASES_MAX = 2000;
/** v1 window. */
const BACK_MS = 3 * H;
const AHEAD_MS = 24 * H;
/** v2 groups over the raw index window, so an earlier airing of a pair marks a later one as a re-air. */
const RAW_BACK_MS = 15 * H;
const RAW_AHEAD_MS = 36 * H;
/** The windows are applied when grouping, so the cache is rebuilt at least this often to let new events enter it. */
const REGROUP_MS = 30 * 60_000;
/** Tagged airings never join a group: a build-up show must not stretch the match (gates G3, G4). */
const DROP_FLAGS = MATCH_FLAGS.rerun | MATCH_FLAGS.replay | MATCH_FLAGS.highlights | MATCH_FLAGS.studio;

/** Per-event data of a v2 view, computed once per regroup. */
interface EventMeta extends Omit<MatchEvent, 'followed' | 'countryBreadth'> {
  /** Distinct playlist channels (fold rows when combining) the picker shows. */
  picker: number;
  /** Country prefixes of its distinct guide channels (one entry per guide channel that has one). */
  countries: string[];
}

export interface SportsView {
  v2: boolean;
  /** Events still on (stop after now), sorted by start. */
  events: SportsGroup<EventAiring>[];
  meta: ReadonlyMap<string, EventMeta>;
  /** Country prefixes on the channels airing events: one, several, or none seen at all (G8 cut-off). */
  countryScope: CountryScope;
  /** Folded category → the guide's own text. */
  labels: ReadonlyMap<string, string>;
}

export interface MatchSettings {
  followed: readonly string[];
  /** Folded competition keys. */
  pinned: readonly string[];
  hidden: readonly string[];
  /** Folded guide categories; empty: all. */
  categories: readonly string[];
  /** Chosen country prefixes ("SE"): Your countries' codes while it is on (AppApi), else none, so K stays 0. */
  countries?: readonly string[];
}

export interface MatchTiles {
  row: SportsEventTile[]; all: SportsEventTile[]; total: number;
  /** A stored category filter applies to this guide (Start then always offers View all, the way back to the chips). */
  filtered: boolean;
}

export class SportsController {
  private cache: { sourceId: string; builtAt: number; built: number; gen: number; mapping: number; offset: number; view: SportsView } | undefined;
  private aliasMap: Map<string, string> | undefined;

  constructor(private readonly deps: { storage: Storage; now: () => number }) {}

  invalidate(): void { this.cache = undefined; }

  aliases(): ReadonlyMap<string, string> { return this.aliasMap ?? new Map(); }

  private async loadAliases(): Promise<Map<string, string>> {
    if (this.aliasMap) return this.aliasMap;
    const raw = await this.deps.storage.getMeta<unknown>(ALIASES_KEY).catch(() => undefined);
    const m = new Map<string, string>();
    if (Array.isArray(raw)) for (const p of raw) if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') m.set(p[0], p[1]);
    return (this.aliasMap = m);
  }

  private async learn(pairs: [string, string][]): Promise<void> {
    if (!pairs.length) return;
    const m = await this.loadAliases();
    for (const [from, to] of pairs) { m.delete(from); m.set(from, to); }
    while (m.size > ALIASES_MAX) m.delete(m.keys().next().value!);
    await this.deps.storage.setMeta(ALIASES_KEY, [...m]).catch(() => undefined);
  }

  /** The grouped events still on (see `view`). */
  async events(sourceId: string, rec: SportsIndexRecord | undefined, index: ChannelIndex, offsetHours: number, mappingVersion = 0): Promise<SportsGroup<EventAiring>[]> {
    return (await this.view(sourceId, rec, index, offsetHours, mappingVersion)).events;
  }

  /**
   * `mappingVersion` changes only when the candidate-to-channel mapping can (a new index, hidden channels or groups,
   * hide-without-guide, combining); recents, favourites and renames do not, so a zap never regroups.
   */
  async view(sourceId: string, rec: SportsIndexRecord | undefined, index: ChannelIndex, offsetHours: number, mappingVersion = 0): Promise<SportsView> {
    const aliases = await this.loadAliases();
    if (!rec) return { v2: false, events: [], meta: new Map(), countryScope: 'unknown', labels: new Map() };
    const c = this.cache;
    if (!c || c.sourceId !== sourceId || c.built !== rec.built || c.gen !== rec.gen || c.mapping !== mappingVersion || c.offset !== offsetHours || this.deps.now() - c.builtAt >= REGROUP_MS) {
      const now = this.deps.now();
      const { view, learned } = rec.v === SPORTS_INDEX_VERSION ? this.buildV2(rec, index, offsetHours, aliases, now) : this.buildV1(rec, index, offsetHours, aliases, now);
      this.cache = { sourceId, builtAt: now, built: rec.built, gen: rec.gen, mapping: mappingVersion, offset: offsetHours, view };
      await this.learn(learned);
    }
    const now = this.deps.now();
    const v = this.cache!.view;
    return { ...v, events: v.events.filter((e) => e.stop > now && e.airings.length > 0) };
  }

  /** Competition and category chips from the user's guide (empty for a v1 record). */
  filters(view: SportsView): MatchFilters { return viewFilters(view); }

  private buildV1(rec: SportsIndexRecord, index: ChannelIndex, offsetHours: number, aliases: ReadonlyMap<string, string>, now: number) {
    const items: GroupInput<EventAiring>[] = [];
    for (const cand of rec.candidates) {
      for (const channel of index.channelsForEpgKey(cand.epgKey)) {
        const ms = (offsetHours + (channel.epgShift ?? 0)) * H;
        const start = cand.start + ms;
        const stop = cand.stop + ms;
        if (stop <= now - BACK_MS || start >= now + AHEAD_MS) continue;
        items.push(groupItem(cand, start, stop, { channelIds: [channel.id], gk: channel.id, epgKey: cand.epgKey, start, stop }));
      }
    }
    const { events, learned } = groupEvents(items, aliases, (a) => a.gk);
    return { view: { v2: false, events, meta: new Map(), countryScope: 'unknown', labels: new Map() } satisfies SportsView, learned };
  }

  private buildV2(rec: SportsIndexRecord, index: ChannelIndex, offsetHours: number, aliases: ReadonlyMap<string, string>, now: number) {
    const folding = index.folding();
    const countryOf = new Map<string, string | undefined>();
    const items: GroupInput<EventAiring>[] = [];
    for (const cand of rec.candidates) {
      if ((cand.flags ?? 0) & DROP_FLAGS) continue;
      const chans = index.channelsForEpgKey(cand.epgKey);
      if (!chans.length) continue;
      // Usually one shift for every copy of a guide channel: one item per guide key, not per playlist copy (R13).
      // When combining, channelsForEpgKey already returns one channel per fold row, so items stay ≈ candidates × rows.
      const byShift = new Map<number, string[]>();
      for (const ch of chans) {
        const s = ch.epgShift ?? 0;
        const ids = byShift.get(s);
        if (ids) ids.push(ch.id); else byShift.set(s, [ch.id]);
        if (!countryOf.has(folding ? ch.id : cand.epgKey)) {
          const name = folding ? index.sources(ch.id)[0]?.name ?? ch.name : ch.name;
          countryOf.set(folding ? ch.id : cand.epgKey, parseChannelName(name).country);
        }
      }
      for (const [shift, ids] of byShift) {
        const ms = (offsetHours + shift) * H;
        const start = cand.start + ms;
        const stop = cand.stop + ms;
        if (stop <= now - RAW_BACK_MS || start >= now + RAW_AHEAD_MS) continue;
        if (folding) {
          for (const id of ids) {
            const gk = index.rowOf(id) ?? id;
            items.push(groupItem(cand, start, stop, { channelIds: [id], gk, epgKey: cand.epgKey, start, stop, cand }));
          }
        } else {
          items.push(groupItem(cand, start, stop, { channelIds: ids, gk: cand.epgKey, epgKey: cand.epgKey, start, stop, cand }));
        }
      }
    }
    const { events, learned } = groupEvents(items, aliases, (a) => `${a.gk}|${a.start}`);
    const reairs = reairKeys(events);

    const catFold = (rec.categories ?? []).map(categoryKey);
    const catSport = catFold.map(isSportCategory);
    const labels = new Map<string, string>();
    (rec.categories ?? []).forEach((t, i) => { if (!labels.has(catFold[i]!)) labels.set(catFold[i]!, t); });
    const sportyKeys = new Set(rec.sportyKeys ?? []);
    const allCountries = new Set<string>();
    const meta = new Map<string, EventMeta>();
    for (const e of events) {
      const gks = new Set<string>();
      const channels = new Set<string>();
      const cats = new Set<string>();
      const comps = new Map<string, { text: string; n: number }>();
      const countries: string[] = [];
      let sportCat = false;
      let strong = false;
      let sporty = false;
      for (const a of e.airings) {
        for (const id of a.channelIds) channels.add(id);
        if (!gks.has(a.gk)) {
          gks.add(a.gk);
          const country = countryOf.get(folding ? a.channelIds[0]! : a.epgKey);
          if (country !== undefined) { countries.push(country); allCountries.add(country); }
        }
        const c = a.cand!;
        for (const ci of c.cats ?? []) {
          const f = catFold[ci];
          if (f === undefined) continue;
          cats.add(f);
          if (catSport[ci]) sportCat = true;
        }
        if (c.sides && !((c.flags ?? 0) & MATCH_FLAGS.weakSep)) strong = true;
        if (sportyKeys.has(a.epgKey)) sporty = true;
        if (c.comp) {
          const k = competitionKey(c.comp);
          const x = comps.get(k);
          if (x) x.n++; else comps.set(k, { text: c.comp, n: 1 });
        }
      }
      let comp: string | undefined;
      let best = 0;
      for (const x of comps.values()) if (x.n > best) { best = x.n; comp = x.text; }
      const m: EventMeta = {
        title: e.title, start: e.start, stop: e.stop, cats: [...cats], sportCat, strong, liveMark: e.live, sporty,
        breadth: gks.size, reair: reairs.has(e.key), picker: channels.size, countries,
      };
      if (e.sides) m.sides = e.sides;
      if (comp !== undefined) m.comp = comp;
      meta.set(e.key, m);
    }
    const countryScope: CountryScope = allCountries.size === 0 ? 'unknown' : allCountries.size === 1 ? 'one' : 'many';
    return { view: { v2: true, events, meta, countryScope, labels } satisfies SportsView, learned };
  }
}

function viewFilters(view: SportsView): MatchFilters {
  if (!view.v2) return { competitions: [], categories: [] };
  const list: { comp?: string; breadth: number; cats: readonly string[] }[] = [];
  for (const e of view.events) {
    const m = view.meta.get(e.key);
    if (!m || m.reair) continue;
    list.push(m.comp === undefined ? { breadth: m.breadth, cats: m.cats } : { comp: m.comp, breadth: m.breadth, cats: m.cats });
  }
  return matchFilters(list, view.labels);
}

/**
 * The stored categories this guide offers as chips now. One from another source or an older guide is ignored, so a
 * filter never hides every match with no chip left to undo it.
 */
export function activeCategories(view: SportsView, stored: readonly string[]): string[] {
  if (!stored.length || !view.v2) return [];
  const chips = new Set(viewFilters(view).categories.map((c) => c.id));
  return stored.filter((c) => chips.has(c));
}

function groupItem(cand: SportsCandidate, start: number, stop: number, airing: EventAiring): GroupInput<EventAiring> {
  const it: GroupInput<EventAiring> = { nt: cand.nt, title: cand.title, start, stop, live: cand.live, airing };
  if (cand.ns) it.ns = cand.ns;
  if (cand.sides) it.sides = cand.sides;
  if (cand.subTitle) it.subTitle = cand.subTitle;
  if (cand.icon) it.icon = cand.icon;
  return it;
}

/** v1 order: followed first, then live now, then start. */
export function eventTiles(events: SportsGroup<EventAiring>[], now: number, followed: readonly string[], aliases: ReadonlyMap<string, string>): SportsEventTile[] {
  const tiles = events.map((e): SportsEventTile => {
    const t: SportsEventTile = { key: e.key, title: e.title, start: e.start, stop: e.stop, channelCount: e.airings.length, followed: isFollowed(e.sides, followed, aliases) };
    if (e.sides) t.sides = e.sides;
    if (e.subTitle) t.subTitle = e.subTitle;
    if (e.icon) t.icon = e.icon;
    return t;
  });
  const airing = (t: SportsEventTile) => t.start <= now && now < t.stop;
  return tiles.sort((a, b) => Number(b.followed) - Number(a.followed) || Number(airing(b)) - Number(airing(a)) || a.start - b.start);
}

/**
 * The Start row (focus set) and See all: v2 ranked by `rankMatches`, v1 in the old order. Only the stored categories
 * this guide still offers filter (`activeCategories`); `filtered` says one does.
 */
export function matchTiles(view: SportsView, now: number, s: MatchSettings, aliases: ReadonlyMap<string, string>): MatchTiles {
  if (!view.v2) {
    const tiles = eventTiles(view.events, now, s.followed, aliases);
    return { row: tiles.slice(0, MATCHES_ROW_CAP), all: tiles.slice(0, MATCHES_ALL_CAP), total: tiles.length, filtered: false };
  }
  const categories = activeCategories(view, s.categories);
  const chosen = new Set(s.countries ?? []);
  const byEvent = new Map<MatchEvent, SportsGroup<EventAiring>>();
  const list: MatchEvent[] = [];
  for (const e of view.events) {
    const m = view.meta.get(e.key);
    if (!m) continue;
    let countryBreadth = 0;
    if (chosen.size) for (const c of m.countries) if (chosen.has(c)) countryBreadth++;
    const me: MatchEvent = { ...m, followed: isFollowed(e.sides, s.followed, aliases), countryBreadth };
    byEvent.set(me, e);
    list.push(me);
  }
  const r = rankMatches(list, { now, pinned: s.pinned, hidden: s.hidden, categories, countryScope: view.countryScope });
  const tile = (x: { event: MatchEvent; onAir: boolean }): SportsEventTile => {
    const e = byEvent.get(x.event)!;
    const m = view.meta.get(e.key)!;
    const t: SportsEventTile = { key: e.key, title: e.title, start: e.start, stop: e.stop, channelCount: m.picker, followed: x.event.followed, onAir: x.onAir };
    if (e.sides) t.sides = e.sides;
    if (e.subTitle) t.subTitle = e.subTitle;
    if (e.icon) t.icon = e.icon;
    if (m.comp !== undefined) t.competition = m.comp;
    return t;
  };
  return { row: r.row.map(tile), all: r.all.map(tile), total: r.total, filtered: categories.length > 0 };
}
