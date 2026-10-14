import { GROUP_ALL, GROUP_FAV, GROUP_RECENT } from '../constants.ts';
import { epgKey } from '../epg/window.ts';
import { emptyLayout, FAV_LIST_ID, type Layout, type SortMode } from '../layout/types.ts';
import { isUserFlags, layoutFromFlags, type UserFlags } from '../layout/migrate.ts';
import { searchKey } from '../text/searchKey.ts';
import { orderGroupChannels } from './order.ts';
import type { Channel, GroupInfo } from '../types.ts';

export type { UserFlags } from '../layout/migrate.ts';

export interface ProviderGroupInfo {
  id: string;
  /** Display name (the user's override, or the provider name). */
  name: string;
  providerName: string;
  /** Every channel in the playlist group, hidden ones included. */
  count: number;
  hidden: boolean;
}

const GROUP_PREFIX = 'g:';
const LIST_PREFIX = 'list:';
/** `src` holds display channels, so the name sort uses the user's renames. */
const channelName = (c: Channel): string => c.name;

/** Layout-independent data, computed once per playlist and shared by `withLayout` rebuilds. */
interface Base {
  channels: Channel[];
  byId: Map<string, Channel>;
  /** Provider group ids in first-appearance order. */
  providerOrder: string[];
  members: Map<string, Channel[]>;
  /** All channels ordered by number (stable), so `number` sort is a filter in this order, never a per-build sort. */
  byNumber: Channel[];
  /** Lazily computed number-ordered members per provider group. */
  membersByNumber: Map<string, Channel[]>;
  /** Normalised original names. */
  keys: Map<string, string>;
  epgCoverage: Set<string> | undefined;
  /** Lazily computed ids whose epgKey is not covered. */
  noEpg?: Set<string>;
  /** Lazily built: playlist channels by epgKey, in number order. */
  byEpgKey?: Map<string, Channel[]>;
}

function groupIdOf(c: Channel): string {
  return GROUP_PREFIX + c.group;
}

function listGroupId(listId: string): string {
  return listId === FAV_LIST_ID ? GROUP_FAV : LIST_PREFIX + listId;
}

/** Internal constructor seed: the previous index whose base and unchanged caches the new index reuses. */
interface Seed { prev: ChannelIndex }

function noEpgIds(base: Base, coverage: Set<string>): Set<string> {
  if (!base.noEpg) {
    const s = new Set<string>();
    for (const c of base.channels) if (!coverage.has(epgKey(c))) s.add(c.id);
    base.noEpg = s;
  }
  return base.noEpg;
}

function buildBase(channels: Channel[], epgCoverage: Set<string> | undefined): Base {
  const byId = new Map<string, Channel>();
  const providerOrder: string[] = [];
  const members = new Map<string, Channel[]>();
  const keys = new Map<string, string>();
  for (const c of channels) {
    byId.set(c.id, c);
    keys.set(c.id, searchKey(c.name));
    const gid = groupIdOf(c);
    let m = members.get(gid);
    if (!m) {
      m = [];
      members.set(gid, m);
      providerOrder.push(gid);
    }
    m.push(c);
  }
  const byNumber = [...channels].sort((a, b) => a.number - b.number);
  return { channels, byId, providerOrder, members, byNumber, membersByNumber: new Map(), keys, epgCoverage };
}

/**
 * The browsable view of one source's channels under a user layout. `withLayout` reuses cached groups from the
 * previous index; that reuse relies on layouts being copy-on-write (an unchanged part keeps its object identity,
 * so identity comparison tells what changed), so never mutate a layout in place.
 */
export class ChannelIndex {
  private readonly base: Base;
  private readonly lay: Layout;
  /** Display copies of renamed channels; unrenamed channels are returned as-is. */
  private readonly renamed: Map<string, Channel>;
  /** Normalised display names of renamed channels. */
  private readonly renamedKeys: Map<string, string>;
  private readonly hiddenCh: Set<string>;
  private readonly hiddenGr: Set<string>;
  private readonly noEpg: Set<string> | undefined;
  private readonly visibleCache = new Map<string, Channel[]>();

  /**
   * @param layout the user's layout; a v1 `UserFlags` object is converted with `layoutFromFlags`.
   *   The index keeps and shallow-freezes the layout object it is given.
   * @param epgCoverage epgKeys with guide data; needed for `layout.hideNoEpg` to have any effect.
   * @param seed internal: used by `withLayout` only.
   */
  constructor(channels: Channel[], layout?: Layout | UserFlags, epgCoverage?: Set<string>, seed?: Seed) {
    const prev = seed?.prev;
    this.base = prev && prev.base.channels === channels && prev.base.epgCoverage === epgCoverage
      ? prev.base
      : buildBase(channels, epgCoverage);
    const lay = layout === undefined ? emptyLayout() : isUserFlags(layout) ? layoutFromFlags(layout) : layout;
    this.lay = Object.freeze(lay);
    const old = prev && prev.base === this.base ? prev : undefined;
    const pl = old?.lay;
    const sameHiddenCh = pl !== undefined && pl.hiddenChannels === lay.hiddenChannels;
    const sameHiddenGr = pl !== undefined && pl.hiddenGroups === lay.hiddenGroups;
    const sameNames = pl !== undefined && pl.channelNames === lay.channelNames;
    this.hiddenCh = sameHiddenCh ? old!.hiddenCh : new Set(lay.hiddenChannels);
    this.hiddenGr = sameHiddenGr ? old!.hiddenGr : new Set(lay.hiddenGroups);
    if (sameNames) {
      this.renamed = old!.renamed;
      this.renamedKeys = old!.renamedKeys;
    } else {
      this.renamed = new Map();
      this.renamedKeys = new Map();
      for (const [id, name] of Object.entries(lay.channelNames)) {
        const c = this.base.byId.get(id);
        if (!c || c.name === name) continue;
        this.renamed.set(id, { ...c, name });
        this.renamedKeys.set(id, searchKey(name));
      }
    }
    this.noEpg = lay.hideNoEpg && epgCoverage ? noEpgIds(this.base, epgCoverage) : undefined;

    // Carry over cached groups whose inputs did not change (layout fields are copy-on-write, so
    // unchanged fields keep their identity). Membership inputs shared by every group:
    if (old && pl && sameHiddenCh && sameHiddenGr && sameNames && pl.hideNoEpg === lay.hideNoEpg) {
      const listsSame = pl.lists === lay.lists;
      const recentSame = pl.recent === lay.recent;
      for (const [gid, v] of old.visibleCache) {
        if (gid === GROUP_RECENT) {
          if (!recentSame) continue;
        } else if (gid === GROUP_FAV || gid.startsWith(LIST_PREFIX)) {
          if (!listsSame) continue;
        }
        if (gid !== GROUP_RECENT
          && (pl.sort[gid] !== lay.sort[gid] || pl.channelOrder[gid] !== lay.channelOrder[gid])) continue;
        this.visibleCache.set(gid, v);
      }
    }
  }

  /** Same playlist and EPG coverage, different layout; reuses the playlist-derived data and unaffected cached groups. */
  withLayout(layout: Layout): ChannelIndex {
    return new ChannelIndex(this.base.channels, layout, this.base.epgCoverage, { prev: this });
  }

  // ---------- internals ----------

  private display(c: Channel): Channel {
    return this.renamed.get(c.id) ?? c;
  }

  /** Visible in provider groups, `all`, search and number lookup. */
  private shown(c: Channel): boolean {
    return !this.hiddenCh.has(c.id) && !this.hiddenGr.has(groupIdOf(c)) && !(this.noEpg?.has(c.id) ?? false);
  }

  private sortModeFor(groupId: string): SortMode {
    return this.lay.sort[groupId] ?? (groupId === GROUP_ALL ? 'number' : 'provider');
  }

  /**
   * Applies manual order (restricted to `src`) and the sort mode. `src` is already display channels.
   * `byNumber`: `src` is already in number order, so `number` mode needs no sort.
   */
  private order(groupId: string, src: Channel[], byNumber = false): Channel[] {
    return orderGroupChannels(src, this.sortModeFor(groupId), this.lay.channelOrder[groupId], channelName, byNumber);
  }

  private resolveListed(ids: readonly string[]): Channel[] {
    const out: Channel[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const c = this.base.byId.get(id);
      if (c && !seen.has(id) && !this.hiddenCh.has(id)) { out.push(this.display(c)); seen.add(id); }
    }
    return out;
  }

  private compute(groupId: string): Channel[] {
    if (groupId === GROUP_ALL) {
      const mode = this.sortModeFor(GROUP_ALL);
      const src = mode === 'number' ? this.base.byNumber : this.base.channels;
      return this.order(GROUP_ALL, src.filter((c) => this.shown(c)).map((c) => this.display(c)), mode === 'number');
    }
    if (groupId === GROUP_RECENT) {
      // Follows the same visibility rules as `all`; only user lists are exempt from group and no-EPG hiding.
      return this.resolveListed(this.lay.recent).filter((c) => this.shown(c));
    }
    if (groupId === GROUP_FAV || groupId.startsWith(LIST_PREFIX)) {
      const list = this.lay.lists.find((l) => listGroupId(l.id) === groupId);
      return list ? this.order(groupId, this.resolveListed(list.channelIds)) : [];
    }
    const m = this.base.members.get(groupId);
    if (!m || this.hiddenGr.has(groupId)) return [];
    const mode = this.sortModeFor(groupId);
    const src = mode === 'number' ? this.membersByNumber(groupId, m) : m;
    return this.order(groupId, src.filter((c) => this.shown(c)).map((c) => this.display(c)), mode === 'number');
  }

  private membersByNumber(groupId: string, m: Channel[]): Channel[] {
    let sorted = this.base.membersByNumber.get(groupId);
    if (!sorted) {
      sorted = [...m].sort((a, b) => a.number - b.number);
      this.base.membersByNumber.set(groupId, sorted);
    }
    return sorted;
  }

  private visible(groupId: string): Channel[] {
    let v = this.visibleCache.get(groupId);
    if (!v) {
      v = this.compute(groupId);
      this.visibleCache.set(groupId, v);
    }
    return v;
  }

  /** Provider group ids: `groupOrder` ids that exist first, then the rest in provider order. */
  private orderedProviderGroups(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const gid of this.lay.groupOrder) {
      if (this.base.members.has(gid) && !seen.has(gid)) { out.push(gid); seen.add(gid); }
    }
    for (const gid of this.base.providerOrder) if (!seen.has(gid)) out.push(gid);
    return out;
  }

  private groupName(gid: string): string {
    return this.lay.groupNames[gid] ?? gid.slice(GROUP_PREFIX.length);
  }

  // ---------- queries ----------

  groups(): GroupInfo[] {
    const out: GroupInfo[] = [];
    for (const l of this.lay.lists) {
      const id = listGroupId(l.id);
      out.push({ id, name: l.name, count: this.visible(id).length });
    }
    const recentCount = this.visible(GROUP_RECENT).length;
    if (recentCount > 0) out.push({ id: GROUP_RECENT, name: 'Recently watched', count: recentCount });
    out.push({ id: GROUP_ALL, name: 'All channels', count: this.visible(GROUP_ALL).length });
    for (const gid of this.orderedProviderGroups()) {
      const count = this.visible(gid).length;
      if (count > 0) out.push({ id: gid, name: this.groupName(gid), count });
    }
    return out;
  }

  /** Hidden provider groups that exist in this playlist, with their non-hidden channel counts (for Settings). */
  hiddenGroupInfos(): GroupInfo[] {
    const out: GroupInfo[] = [];
    for (const gid of this.orderedProviderGroups()) {
      if (!this.hiddenGr.has(gid)) continue;
      const m = this.base.members.get(gid) ?? [];
      out.push({ id: gid, name: this.groupName(gid), count: m.filter((c) => !this.hiddenCh.has(c.id)).length });
    }
    return out;
  }

  /** Every provider group, hidden or not (for the companion). */
  allProviderGroups(): ProviderGroupInfo[] {
    return this.orderedProviderGroups().map((gid) => ({
      id: gid,
      name: this.groupName(gid),
      providerName: gid.slice(GROUP_PREFIX.length),
      count: this.base.members.get(gid)?.length ?? 0,
      hidden: this.hiddenGr.has(gid),
    }));
  }

  groupSize(groupId: string): number {
    return this.visible(groupId).length;
  }

  slice(groupId: string, offset: number, count: number): Channel[] {
    return this.visible(groupId).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, count));
  }

  indexOf(groupId: string, channelId: string): number {
    return this.visible(groupId).findIndex((c) => c.id === channelId);
  }

  get(id: string): Channel | undefined {
    const c = this.base.byId.get(id);
    return c && this.display(c);
  }

  displayName(id: string): string | undefined {
    return this.get(id)?.name;
  }

  byNumber(n: number): Channel | undefined {
    return this.visible(GROUP_ALL).find((c) => c.number === n);
  }

  /** Visible display channels whose playlist epgKey is `key`, in number order (programme search). */
  channelsForEpgKey(key: string): Channel[] {
    if (!this.base.byEpgKey) {
      const m = new Map<string, Channel[]>();
      for (const c of this.base.byNumber) {
        const k = epgKey(c);
        const list = m.get(k);
        if (list) list.push(c);
        else m.set(k, [c]);
      }
      this.base.byEpgKey = m;
    }
    return (this.base.byEpgKey.get(key) ?? []).filter((c) => this.shown(c)).map((c) => this.display(c));
  }

  neighbour(groupId: string, channelId: string, delta: number): Channel | undefined {
    const list = this.visible(groupId);
    const i = list.findIndex((c) => c.id === channelId);
    if (i === -1 || list.length === 0) return undefined;
    const j = (((i + delta) % list.length) + list.length) % list.length;
    return list[j];
  }

  /** Matches the display name, with the original name as a fallback key. */
  search(query: string, limit: number): Channel[] {
    const q = searchKey(query);
    if (!q) return [];
    const prefix: Channel[] = [];
    const contains: Channel[] = [];
    for (const c of this.visible(GROUP_ALL)) {
      const orig = this.base.keys.get(c.id)!;
      const disp = this.renamedKeys.get(c.id);
      if (orig.startsWith(q) || (disp !== undefined && disp.startsWith(q))) prefix.push(c);
      else if (orig.includes(q) || (disp !== undefined && disp.includes(q))) contains.push(c);
      if (prefix.length >= limit) break;
    }
    return [...prefix, ...contains].slice(0, limit);
  }

  /** The layout this index was built with: a frozen (shallow) snapshot. Change it with `applyOps`, which returns a new layout. */
  layout(): Layout {
    return this.lay;
  }

  /** Individually hidden channels in this playlist, by number. */
  hiddenChannels(): Channel[] {
    return this.base.channels
      .filter((c) => this.hiddenCh.has(c.id))
      .sort((a, b) => a.number - b.number)
      .map((c) => this.display(c));
  }

  /** @deprecated v1 compatibility only; maps from the layout. Use `layout()`. */
  flags(): UserFlags {
    const fav = this.lay.lists.find((l) => l.id === FAV_LIST_ID);
    return { favourites: [...(fav?.channelIds ?? [])], hidden: [...this.lay.hiddenChannels], recent: [...this.lay.recent] };
  }
}
