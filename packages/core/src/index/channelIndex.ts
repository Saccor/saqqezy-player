import { GROUP_ALL, GROUP_FAV, GROUP_RECENT } from '../constants.ts';
import { epgKey } from '../epg/window.ts';
import { emptyLayout, FAV_LIST_ID, type Layout, type SortMode } from '../layout/types.ts';
import { isUserFlags, layoutFromFlags, type UserFlags } from '../layout/migrate.ts';
import { normalize } from '../text/normalize.ts';
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
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Layout-independent data, computed once per playlist and shared by `withLayout` rebuilds. */
interface Base {
  channels: Channel[];
  byId: Map<string, Channel>;
  /** Provider group ids in first-appearance order. */
  providerOrder: string[];
  members: Map<string, Channel[]>;
  /** Normalised original names. */
  keys: Map<string, string>;
  epgCoverage: Set<string> | undefined;
  /** Lazily computed ids whose epgKey is not covered. */
  noEpg?: Set<string>;
}

function groupIdOf(c: Channel): string {
  return GROUP_PREFIX + c.group;
}

function listGroupId(listId: string): string {
  return listId === FAV_LIST_ID ? GROUP_FAV : LIST_PREFIX + listId;
}

/** Set synchronously by `withLayout` just before it constructs, so the constructor can share the base. */
let reuseBase: Base | undefined;

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
    keys.set(c.id, normalize(c.name));
    const gid = groupIdOf(c);
    let m = members.get(gid);
    if (!m) {
      m = [];
      members.set(gid, m);
      providerOrder.push(gid);
    }
    m.push(c);
  }
  return { channels, byId, providerOrder, members, keys, epgCoverage };
}

export class ChannelIndex {
  private readonly base: Base;
  private readonly lay: Layout;
  /** Display copies of renamed channels; unrenamed channels are returned as-is. */
  private readonly renamed = new Map<string, Channel>();
  /** Normalised display names of renamed channels. */
  private readonly renamedKeys = new Map<string, string>();
  private readonly hiddenCh: Set<string>;
  private readonly hiddenGr: Set<string>;
  private readonly noEpg: Set<string> | undefined;
  private readonly visibleCache = new Map<string, Channel[]>();

  /**
   * @param layout the user's layout; a v1 `UserFlags` object is converted with `layoutFromFlags`.
   * @param epgCoverage epgKeys with guide data; needed for `layout.hideNoEpg` to have any effect.
   */
  constructor(channels: Channel[], layout?: Layout | UserFlags, epgCoverage?: Set<string>) {
    const shared = reuseBase;
    reuseBase = undefined;
    this.base = shared && shared.channels === channels && shared.epgCoverage === epgCoverage
      ? shared
      : buildBase(channels, epgCoverage);
    this.lay = layout === undefined ? emptyLayout() : isUserFlags(layout) ? layoutFromFlags(layout) : layout;
    this.hiddenCh = new Set(this.lay.hiddenChannels);
    this.hiddenGr = new Set(this.lay.hiddenGroups);
    for (const [id, name] of Object.entries(this.lay.channelNames)) {
      const c = this.base.byId.get(id);
      if (!c || c.name === name) continue;
      this.renamed.set(id, { ...c, name });
      this.renamedKeys.set(id, normalize(name));
    }
    this.noEpg = this.lay.hideNoEpg && epgCoverage ? noEpgIds(this.base, epgCoverage) : undefined;
  }

  /** Same playlist and EPG coverage, different layout; reuses the playlist-derived data. */
  withLayout(layout: Layout): ChannelIndex {
    reuseBase = this.base;
    return new ChannelIndex(this.base.channels, layout, this.base.epgCoverage);
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

  /** Applies manual order (restricted to `src`) and the sort mode. `src` is already display channels. */
  private order(groupId: string, src: Channel[]): Channel[] {
    const mode = this.sortModeFor(groupId);
    let rest = src;
    if (mode === 'number') rest = [...src].sort((a, b) => a.number - b.number);
    else if (mode === 'name') rest = [...src].sort((a, b) => collator.compare(a.name, b.name));
    const manual = this.lay.channelOrder[groupId];
    if (!manual || manual.length === 0) return rest;
    const byId = new Map(src.map((c) => [c.id, c]));
    const first: Channel[] = [];
    const taken = new Set<string>();
    for (const id of manual) {
      const c = byId.get(id);
      if (c && !taken.has(id)) { first.push(c); taken.add(id); }
    }
    if (first.length === 0) return rest;
    return first.concat(rest.filter((c) => !taken.has(c.id)));
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
      return this.order(GROUP_ALL, this.base.channels.filter((c) => this.shown(c)).map((c) => this.display(c)));
    }
    if (groupId === GROUP_RECENT) return this.resolveListed(this.lay.recent);
    if (groupId === GROUP_FAV || groupId.startsWith(LIST_PREFIX)) {
      const list = this.lay.lists.find((l) => listGroupId(l.id) === groupId);
      return list ? this.order(groupId, this.resolveListed(list.channelIds)) : [];
    }
    const m = this.base.members.get(groupId);
    if (!m || this.hiddenGr.has(groupId)) return [];
    return this.order(groupId, m.filter((c) => this.shown(c)).map((c) => this.display(c)));
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

  neighbour(groupId: string, channelId: string, delta: number): Channel | undefined {
    const list = this.visible(groupId);
    const i = list.findIndex((c) => c.id === channelId);
    if (i === -1 || list.length === 0) return undefined;
    const j = (((i + delta) % list.length) + list.length) % list.length;
    return list[j];
  }

  /** Matches the display name, with the original name as a fallback key. */
  search(query: string, limit: number): Channel[] {
    const q = normalize(query);
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

  /** The layout this index was built with. Treat as immutable; change it with `applyOps`. */
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
