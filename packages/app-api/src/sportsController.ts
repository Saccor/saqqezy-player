/** Sports in your guide: the active source's candidates on the user's visible channels, grouped (spec §5.4). */
import {
  applyShift, groupEvents, isFollowed, type ChannelIndex, type GroupInput, type SportsGroup, type SportsIndexRecord, type Storage,
} from '@iptv/core';
import type { SportsEventTile } from './types.ts';

export interface EventAiring { channelId: string; start: number; stop: number }

const ALIASES_KEY = 'sportsAliases';
const ALIASES_MAX = 2000;
const BACK_MS = 3 * 3600_000;
const AHEAD_MS = 24 * 3600_000;
/** The now-3h..now+24h window is applied when grouping, so the cache is rebuilt at least this often to let new events enter it. */
const REGROUP_MS = 30 * 60_000;

export class SportsController {
  private cache: { sourceId: string; builtAt: number; built: number; gen: number; mapping: number; offset: number; events: SportsGroup<EventAiring>[] } | undefined;
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

  /**
   * `mappingVersion` changes only when the candidate-to-channel mapping can (a new index, hidden channels or groups,
   * hide-without-guide); recents, favourites and renames do not, so a zap never regroups.
   */
  async events(sourceId: string, rec: SportsIndexRecord | undefined, index: ChannelIndex, offsetHours: number, mappingVersion = 0): Promise<SportsGroup<EventAiring>[]> {
    const aliases = await this.loadAliases();
    if (!rec) return [];
    const c = this.cache;
    if (!c || c.sourceId !== sourceId || c.built !== rec.built || c.gen !== rec.gen || c.mapping !== mappingVersion || c.offset !== offsetHours || this.deps.now() - c.builtAt >= REGROUP_MS) {
      const now = this.deps.now();
      const items: GroupInput<EventAiring>[] = [];
      for (const cand of rec.candidates) {
        for (const channel of index.channelsForEpgKey(cand.epgKey)) {
          const shifted = applyShift({ epgId: '', title: '', start: cand.start, stop: cand.stop }, offsetHours + (channel.epgShift ?? 0));
          if (shifted.stop <= now - BACK_MS || shifted.start >= now + AHEAD_MS) continue;
          const it: GroupInput<EventAiring> = {
            nt: cand.nt, title: cand.title, start: shifted.start, stop: shifted.stop, live: cand.live,
            airing: { channelId: channel.id, start: shifted.start, stop: shifted.stop },
          };
          if (cand.ns) it.ns = cand.ns;
          if (cand.sides) it.sides = cand.sides;
          if (cand.subTitle) it.subTitle = cand.subTitle;
          if (cand.icon) it.icon = cand.icon;
          items.push(it);
        }
      }
      const { events, learned } = groupEvents(items, aliases, (a) => a.channelId);
      this.cache = { sourceId, builtAt: now, built: rec.built, gen: rec.gen, mapping: mappingVersion, offset: offsetHours, events };
      await this.learn(learned);
    }
    const now = this.deps.now();
    return this.cache!.events.filter((e) => e.stop > now && e.airings.length > 0);
  }
}

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
