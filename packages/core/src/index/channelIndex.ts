import { GROUP_ALL, GROUP_FAV, GROUP_RECENT } from '../constants.ts';
import { epgKey } from '../epg/window.ts';
import { emptyLayout, FAV_LIST_ID, type Layout, type SortMode } from '../layout/types.ts';
import { isUserFlags, layoutFromFlags, type UserFlags } from '../layout/migrate.ts';
import { foldChannels, type ChannelFolds } from '../live/fold.ts';
import { compileQuery, nameMatchScore, nameKeys, NO_MATCH, type CompiledQuery, type NameKeys } from '../text/searchMatch.ts';
import type { GroupRegion } from '../text/regions.ts';
import { foldActive, splitFold } from './countryFold.ts';
import { regionRule, sureRegionKeys, type RegionRule, type RegionState } from './regionRule.ts';

export type { RegionState } from './regionRule.ts';
import type { RegionMode } from '../settings.ts';
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
  /** Hidden by the user (`hiddenGroups`). */
  hidden: boolean;
  /** Hidden by the region rule (Show only these), not by the user. */
  regionHidden: boolean;
  /** Shown on purpose (`shownGroups`), over the region rule. */
  shown: boolean;
  /** The group's region keys the rule uses: the user's override, else a sure detection; [] when none. */
  regions: string[];
}

/** Your countries as the index applies them (report 2026-10-20 §2.2). */
export interface ChannelRegionView {
  /** Detected regions per group id (the cached record's `groups`). */
  detected: Readonly<Record<string, GroupRegion>>;
  codes: readonly string[];
  mode: RegionMode;
  /** Fold other countries' groups under "Other countries" (the `foldCountries` setting). Absent: no fold. */
  fold?: boolean;
}



const GROUP_PREFIX = 'g:';
const LIST_PREFIX = 'list:';
/** `src` holds display channels, so the name sort uses the user's renames. */
const channelName = (c: Channel): string => c.name;
const NO_CHANNELS: readonly Channel[] = Object.freeze([]);

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
  /** Match keys of each channel's original (playlist) name, by channel id; built on the first `search()`. */
  keys?: Map<string, NameKeys>;
  epgCoverage: Set<string> | undefined;
  /** Lazily computed ids whose epgKey is not covered. */
  noEpg?: Set<string>;
  /** Lazily built: playlist channels by epgKey, in number order. */
  byEpgKey?: Map<string, Channel[]>;
  /** Lazily built: playlist channels by number. */
  byNum?: Map<number, Channel>;
  /** Built by the first index with `fold` on. */
  fold?: FoldBase;
}

/** The folds of one playlist (spec 2026-10-19-live-grouping §3), shared by every index built on the same base. */
interface FoldBase {
  folds: ChannelFolds;
  /** Channel id → its fold index. */
  foldIndexOf: Map<string, number>;
  /** Channel id → its playlist position. */
  pos: Map<string, number>;
  /** Per fold: its members (playlist order) and its lead (the row's id and number). */
  members: Channel[][];
  leads: Channel[];
}

function buildFold(base: Base): FoldBase {
  const folds = foldChannels(base.channels);
  const foldIndexOf = new Map<string, number>();
  const pos = new Map<string, number>();
  base.channels.forEach((c, i) => {
    foldIndexOf.set(c.id, folds.foldOf[i]!);
    pos.set(c.id, i);
  });
  return {
    folds, foldIndexOf, pos,
    members: folds.folds.map((f) => f.members.map((i) => base.channels[i]!)),
    leads: folds.folds.map((f) => base.channels[f.lead]!),
  };
}

export interface ChannelIndexOptions {
  /** One row per live channel: duplicates of a channel fold into its row (spec 2026-10-19-live-grouping). */
  fold?: boolean;
  /** Your countries: put first or show only these. Without it (or with mode 'off') nothing changes. */
  regions?: ChannelRegionView;
}

const NO_KEYS: readonly string[] = [];
/** Sure keys per detected record, computed once per record object. */
const sureKeysCache = new WeakMap<object, Record<string, string[]>>();

function regionData(base: Base, lay: Layout, view: ChannelRegionView | undefined): RegionRule {
  if (!view) return regionRule(base.providerOrder, lay, undefined);
  let keys = sureKeysCache.get(view.detected);
  if (!keys) sureKeysCache.set(view.detected, (keys = sureRegionKeys(view.detected)));
  return regionRule(base.providerOrder, lay, { keys, codes: view.codes, mode: view.mode });
}

function groupIdOf(c: Channel): string {
  return GROUP_PREFIX + c.group;
}

function listGroupId(listId: string): string {
  return listId === FAV_LIST_ID ? GROUP_FAV : LIST_PREFIX + listId;
}

/** Internal constructor options: the previous index whose base and unchanged caches the new index reuses. */
interface InternalOptions extends ChannelIndexOptions { prev?: ChannelIndex }

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
  for (const c of channels) {
    byId.set(c.id, c);
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
  return { channels, byId, providerOrder, members, byNumber, membersByNumber: new Map(), epgCoverage };
}

/** Search keys of the original names, built once per base on the first search (a cold start never pays for them). */
function searchKeys(base: Base): Map<string, NameKeys> {
  if (!base.keys) {
    const keys = new Map<string, NameKeys>();
    for (const c of base.channels) keys.set(c.id, nameKeys(c.name));
    base.keys = keys;
  }
  return base.keys;
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
  private readonly renamedKeys: Map<string, NameKeys>;
  private readonly hiddenCh: Set<string>;
  /** Effective hidden groups: the user's, plus those the region rule hides (never the shown ones). */
  private readonly hiddenGr: Set<string>;
  /** The user's hidden groups only. */
  private readonly userHiddenGr: Set<string>;
  private readonly regionView: ChannelRegionView | undefined;
  private readonly rd: RegionRule;
  private readonly noEpg: Set<string> | undefined;
  /** Nothing hidden (channels, groups, no-guide) and nothing renamed: every channel shows as it is. */
  private readonly plain: boolean;
  private readonly visibleCache = new Map<string, Channel[]>();
  /** Fold mode only. */
  private readonly fb: FoldBase | undefined;
  /** Fold index → its row (null: no candidate). Depends on hidden channels, hidden groups and names only. */
  private rowCache = new Map<number, Channel | null>();
  /** Row id → match keys of a folded row's name. */
  private readonly rowKeys = new Map<string, NameKeys>();

  /**
   * @param layout the user's layout; a v1 `UserFlags` object is converted with `layoutFromFlags`.
   *   The index keeps and shallow-freezes the layout object it is given.
   * @param epgCoverage epgKeys with guide data; needed for `layout.hideNoEpg` to have any effect.
   * @param opts `fold`: one row per live channel (default off: one row per playlist entry).
   */
  constructor(channels: Channel[], layout?: Layout | UserFlags, epgCoverage?: Set<string>, opts?: ChannelIndexOptions) {
    const prev = (opts as InternalOptions | undefined)?.prev;
    this.base = prev && prev.base.channels === channels && prev.base.epgCoverage === epgCoverage
      ? prev.base
      : buildBase(channels, epgCoverage);
    const lay = layout === undefined ? emptyLayout() : isUserFlags(layout) ? layoutFromFlags(layout) : layout;
    this.lay = Object.freeze(lay);
    const old = prev && prev.base === this.base ? prev : undefined;
    const pl = old?.lay;
    const sameHiddenCh = pl !== undefined && pl.hiddenChannels === lay.hiddenChannels;
    this.regionView = opts?.regions;
    const sameRegions = pl !== undefined && pl.groupRegion === lay.groupRegion && pl.shownGroups === lay.shownGroups
      && old!.regionView === this.regionView;
    const sameUserHidden = pl !== undefined && pl.hiddenGroups === lay.hiddenGroups;
    const sameHiddenGr = sameUserHidden && sameRegions;
    const sameNames = pl !== undefined && pl.channelNames === lay.channelNames;
    this.hiddenCh = sameHiddenCh ? old!.hiddenCh : new Set(lay.hiddenChannels);
    // The effective hidden set, built once here in O(groups): `shown()` stays one set lookup per group.
    this.rd = sameRegions ? old!.rd : regionData(this.base, lay, this.regionView);
    this.userHiddenGr = sameUserHidden ? old!.userHiddenGr : new Set(lay.hiddenGroups);
    if (sameHiddenGr) this.hiddenGr = old!.hiddenGr;
    else if (this.rd.ruleHidden.size === 0) this.hiddenGr = this.userHiddenGr;
    else {
      this.hiddenGr = new Set(this.userHiddenGr);
      for (const gid of this.rd.ruleHidden) this.hiddenGr.add(gid);
    }
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
        this.renamedKeys.set(id, nameKeys(name));
      }
    }
    this.noEpg = lay.hideNoEpg && epgCoverage ? noEpgIds(this.base, epgCoverage) : undefined;
    this.plain = this.hiddenCh.size === 0 && this.hiddenGr.size === 0 && this.renamed.size === 0 && !this.noEpg?.size;
    this.fb = opts?.fold ? (this.base.fold ??= buildFold(this.base)) : undefined;
    if (old && this.fb && old.fb === this.fb && sameHiddenCh && sameHiddenGr && sameNames) this.rowCache = old.rowCache;

    // Carry over cached groups whose inputs did not change (layout fields are copy-on-write, so
    // unchanged fields keep their identity). Membership inputs shared by every group:
    if (old && pl && old.fb === this.fb && sameHiddenCh && sameHiddenGr && sameNames && pl.hideNoEpg === lay.hideNoEpg) {
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
    const opts: InternalOptions = { fold: this.fb !== undefined, prev: this };
    if (this.regionView) opts.regions = this.regionView;
    return new ChannelIndex(this.base.channels, layout, this.base.epgCoverage, opts);
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
    let manual = this.lay.channelOrder[groupId];
    if (this.fb && manual) manual = manual.map((id) => this.rowOf(id) ?? id);
    return orderGroupChannels(src, this.sortModeFor(groupId), manual, channelName, byNumber);
  }

  // ---------- fold mode ----------

  /** Can stream for its row: not hidden, and its group not hidden. */
  private candidate(c: Channel): boolean {
    return !this.hiddenCh.has(c.id) && !this.hiddenGr.has(groupIdOf(c));
  }

  private row(fi: number): Channel | undefined {
    let r = this.rowCache.get(fi);
    if (r === undefined) {
      r = this.buildRow(fi) ?? null;
      this.rowCache.set(fi, r);
    }
    return r ?? undefined;
  }

  /**
   * A copy of the lead named for the channel: the lead's rename, else a member's, else the folded name. The guide id
   * comes from the first member with one when the lead has none. Undefined when no member is a candidate.
   */
  private buildRow(fi: number): Channel | undefined {
    const fb = this.fb!;
    const members = fb.members[fi]!;
    const lead = fb.leads[fi]!;
    if (members.length === 1) return this.candidate(lead) ? this.display(lead) : undefined;
    let count = 0;
    let quality = 4;
    for (const m of members) {
      if (!this.candidate(m)) continue;
      count++;
      quality = Math.min(quality, fb.folds.memberQuality[fb.pos.get(m.id)!]!);
    }
    if (count === 0) return undefined;
    let name = this.renamed.get(lead.id)?.name;
    if (name === undefined) {
      for (const m of members) {
        const r = this.renamed.get(m.id);
        if (r) { name = r.name; break; }
      }
    }
    const row: Channel = { ...lead, name: name ?? fb.folds.folds[fi]!.display, quality };
    if (!lead.epgId) {
      const g = members.find((m) => m.epgId);
      if (g) {
        row.epgId = g.epgId!;
        if (g.epgShift !== undefined) row.epgShift = g.epgShift;
        else delete row.epgShift;
      }
    }
    if (count > 1) row.sources = count;
    return row;
  }

  /** The member whose playlist data the guide uses: the first with a guide id, else the lead. */
  private guideMember(fi: number): Channel {
    const fb = this.fb!;
    return fb.members[fi]!.find((m) => m.epgId) ?? fb.leads[fi]!;
  }

  /** The row as provider groups and All show it: hide-no-guide tests the row's guide, not each member's. */
  private shownRow(fi: number): Channel | undefined {
    const r = this.row(fi);
    if (!r || !this.noEpg) return r;
    return this.noEpg.has(this.guideMember(fi).id) ? undefined : r;
  }

  /** Rows of `src` (playlist channels) in `src` order, each once, at its first candidate. */
  private rowsOf(src: readonly Channel[]): Channel[] {
    const fb = this.fb!;
    const out: Channel[] = [];
    const seen = new Set<number>();
    for (const c of src) {
      if (!this.candidate(c)) continue;
      const fi = fb.foldIndexOf.get(c.id)!;
      if (seen.has(fi)) continue;
      seen.add(fi);
      const r = this.shownRow(fi);
      if (r) out.push(r);
    }
    return out;
  }

  /** Rows of stored ids (lists, recents), each once, at its first id. */
  private rowsOfIds(ids: readonly string[], shownOnly: boolean): Channel[] {
    const fb = this.fb!;
    const out: Channel[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      const fi = fb.foldIndexOf.get(id);
      if (fi === undefined || seen.has(fi)) continue;
      seen.add(fi);
      const r = shownOnly ? this.shownRow(fi) : this.listRow(fi);
      if (r) out.push(r);
    }
    return out;
  }

  /** In user lists a single channel keeps today's rule (only its own hiding counts); a folded row needs a candidate. */
  private listRow(fi: number): Channel | undefined {
    const fb = this.fb!;
    if (fb.members[fi]!.length > 1) return this.row(fi);
    const c = fb.leads[fi]!;
    return this.hiddenCh.has(c.id) ? undefined : this.display(c);
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
    if (this.fb) return this.computeFolded(groupId);
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

  private computeFolded(groupId: string): Channel[] {
    if (groupId === GROUP_ALL) {
      const mode = this.sortModeFor(GROUP_ALL);
      return this.order(GROUP_ALL, this.rowsOf(mode === 'number' ? this.base.byNumber : this.base.channels), mode === 'number');
    }
    if (groupId === GROUP_RECENT) return this.rowsOfIds(this.lay.recent, true);
    if (groupId === GROUP_FAV || groupId.startsWith(LIST_PREFIX)) {
      const list = this.lay.lists.find((l) => listGroupId(l.id) === groupId);
      return list ? this.order(groupId, this.rowsOfIds(list.channelIds, false)) : [];
    }
    const m = this.base.members.get(groupId);
    if (!m || this.hiddenGr.has(groupId)) return [];
    const mode = this.sortModeFor(groupId);
    return this.order(groupId, this.rowsOf(mode === 'number' ? this.membersByNumber(groupId, m) : m), mode === 'number');
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

  /**
   * Provider group ids: `groupOrder` ids that exist first, then the rest in provider order. With your countries on,
   * the rest is a stable partition: chosen countries' groups first, by pick order (`rankOf`) then provider order, then
   * the others (the user's order always wins).
   */
  private orderedProviderGroups(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const gid of this.lay.groupOrder) {
      if (this.base.members.has(gid) && !seen.has(gid)) { out.push(gid); seen.add(gid); }
    }
    const chosen = this.rd.state.mode === 'off' ? undefined : this.rd.chosen;
    if (chosen) {
      const picked = this.base.providerOrder.filter((gid) => chosen.has(gid) && !seen.has(gid));
      // Array sort is stable: provider order stays inside a rank. Ranks may be Infinity, so compare, never subtract.
      picked.sort((x, y) => { const rx = this.rd.rankOf(x); const ry = this.rd.rankOf(y); return rx < ry ? -1 : rx > ry ? 1 : 0; });
      for (const gid of picked) { out.push(gid); seen.add(gid); }
    }
    for (const gid of this.base.providerOrder) if (!seen.has(gid)) out.push(gid);
    return out;
  }

  /** Not a group of a chosen country while your countries are on: listed under "Other groups". */
  private isOther(gid: string): boolean {
    return this.rd.state.mode !== 'off' && !this.rd.chosen.has(gid);
  }

  private groupName(gid: string): string {
    return this.lay.groupNames[gid] ?? gid.slice(GROUP_PREFIX.length);
  }

  // ---------- queries ----------

  /**
   * Recently watched, All channels, the lists, then your groups (moved by hand, then chosen countries' in pick order),
   * then, while the fold is active, other countries' groups in country order (each with `fold`), then the rest
   * (spec 2026-10-22-your-countries-flags). The picker opens at the top, so the everyday rows come first. One pass
   * over the groups. Empty groups (all hidden) are left out and count nowhere.
   */
  groups(): GroupInfo[] {
    const out: GroupInfo[] = [];
    const recentCount = this.visible(GROUP_RECENT).length;
    if (recentCount > 0) out.push({ id: GROUP_RECENT, name: 'Recently watched', count: recentCount });
    out.push({ id: GROUP_ALL, name: 'All channels', count: this.visible(GROUP_ALL).length });
    for (const l of this.lay.lists) {
      const id = listGroupId(l.id);
      out.push({ id, name: l.name, count: this.visible(id).length });
    }
    const handMoved = new Set(this.lay.groupOrder);
    const yours: GroupInfo[] = [];
    const tail: GroupInfo[] = [];
    const keys = new Set<string>();
    for (const gid of this.orderedProviderGroups()) {
      const count = this.visible(gid).length;
      if (count === 0) continue;
      const info: GroupInfo = { id: gid, name: this.groupName(gid), count };
      if (this.isOther(gid)) info.other = true;
      for (const k of this.rd.keysOf.get(gid) ?? NO_KEYS) keys.add(k);
      // `chosen` is empty while the rule is off or stale.
      if (handMoved.has(gid) || this.rd.chosen.has(gid)) yours.push(info);
      else tail.push(info);
    }
    for (const g of yours) out.push(g);
    if (!foldActive(this.regionView?.fold === true, this.rd.state.mode, keys.size)) {
      for (const g of tail) out.push(g);
      return out;
    }
    const split = splitFold(tail, (g) => this.rd.keysOf.get(g.id) ?? NO_KEYS);
    for (const { item, key } of split.country) out.push({ ...item, fold: key });
    for (const g of split.rest) out.push(g);
    return out;
  }

  /** Your countries as applied to this source. */
  regionState(): RegionState {
    return this.rd.state;
  }

  /**
   * Your countries in pick order: 0 for a group of the first chosen country, 1 for the second, …; Infinity for every
   * other group, and for every group while the rule is off (spec 2026-10-24 §2.1).
   */
  regionRankOf(groupId: string): number {
    if (this.rd.state.mode === 'off' || !this.regionView) return Number.POSITIVE_INFINITY;
    const keys = this.rd.keysOf.get(groupId);
    if (!keys || keys.length === 0) return Number.POSITIVE_INFINITY;
    let best = Number.POSITIVE_INFINITY;
    for (const k of keys) {
      const i = this.regionView.codes.indexOf(k);
      if (i !== -1 && i < best) best = i;
    }
    return best;
  }

  /** `regionRankOf` of a channel's group; a folded row takes the best rank among its members. */
  countryRankOf(channelId: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (const id of this.memberIds(channelId)) {
      const m = this.base.byId.get(id);
      if (!m) continue;
      const r = this.regionRankOf(groupIdOf(m));
      if (r < best) best = r;
    }
    return best;
  }

  /** Hidden provider groups that exist in this playlist, with their non-hidden channel counts (for Settings). */
  hiddenGroupInfos(): GroupInfo[] {
    const out: GroupInfo[] = [];
    for (const gid of this.orderedProviderGroups()) {
      if (!this.userHiddenGr.has(gid)) continue;
      const m = this.base.members.get(gid) ?? [];
      out.push({ id: gid, name: this.groupName(gid), count: m.filter((c) => !this.hiddenCh.has(c.id)).length });
    }
    return out;
  }

  /** Every provider group, hidden or not (for the companion). */
  allProviderGroups(): ProviderGroupInfo[] {
    const shown = new Set(this.lay.shownGroups);
    return this.orderedProviderGroups().map((gid) => ({
      id: gid,
      name: this.groupName(gid),
      providerName: gid.slice(GROUP_PREFIX.length),
      count: this.base.members.get(gid)?.length ?? 0,
      hidden: this.userHiddenGr.has(gid),
      regionHidden: this.rd.ruleHidden.has(gid),
      shown: shown.has(gid),
      regions: [...(this.rd.keysOf.get(gid) ?? NO_KEYS)],
    }));
  }

  groupSize(groupId: string): number {
    return this.visible(groupId).length;
  }

  slice(groupId: string, offset: number, count: number): Channel[] {
    return this.visible(groupId).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, count));
  }

  indexOf(groupId: string, channelId: string): number {
    const id = this.fb ? this.rowOf(channelId) ?? channelId : channelId;
    return this.visible(groupId).findIndex((c) => c.id === id);
  }

  get(id: string): Channel | undefined {
    const c = this.base.byId.get(id);
    return c && this.display(c);
  }

  displayName(id: string): string | undefined {
    return this.get(id)?.name;
  }

  byNumber(n: number): Channel | undefined {
    if (!this.fb) return this.visible(GROUP_ALL).find((c) => c.number === n);
    // Any stream's number finds its row.
    this.base.byNum ??= new Map(this.base.channels.map((c) => [c.number, c]));
    const c = this.base.byNum.get(n);
    if (!c || !this.candidate(c)) return undefined;
    return this.shownRow(this.fb.foldIndexOf.get(c.id)!);
  }

  /**
   * Visible display channels whose playlist epgKey is `key`, in number order (programme search). With nothing hidden
   * or renamed, the shared per-key array itself: no copy per call (several per search keystroke).
   */
  channelsForEpgKey(key: string): readonly Channel[] {
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
    const all = this.base.byEpgKey.get(key) ?? NO_CHANNELS;
    if (this.fb) return this.rowsOf(all);
    if (this.plain) return all;
    return all.filter((c) => this.shown(c)).map((c) => this.display(c));
  }

  neighbour(groupId: string, channelId: string, delta: number): Channel | undefined {
    const list = this.visible(groupId);
    const id = this.fb ? this.rowOf(channelId) ?? channelId : channelId;
    const i = list.findIndex((c) => c.id === id);
    if (i === -1 || list.length === 0) return undefined;
    const j = (((i + delta) % list.length) + list.length) % list.length;
    return list[j];
  }

  /** The best matches of `query` (see `searchScored`). */
  search(query: string, limit: number): Channel[] {
    return this.searchScored(query).slice(0, Math.max(0, limit)).map((m) => m.channel);
  }

  /**
   * Every visible row matching `query`, best first (`nameMatchScore`: every word in any order, the bare name first), in
   * playlist order within a score. A folded row matches by its row name too, a renamed channel by its new name too.
   * A query that is a channel's number puts that channel first, with score -1.
   */
  searchScored(query: string): { channel: Channel; score: number }[] {
    const q = compileQuery(query);
    if (!q) return [];
    const numbered = /^\d+$/.test(query.trim()) ? this.byNumber(Number(query.trim())) : undefined;
    const keys = searchKeys(this.base);
    const out: { channel: Channel; score: number }[] = [];
    for (const c of this.visible(GROUP_ALL)) {
      if (c === numbered) continue;
      const disp = c.quality !== undefined ? this.rowKey(c) : this.renamedKeys.get(c.id);
      const score = this.scoreOf(keys.get(c.id)!, disp, q);
      if (score !== NO_MATCH) out.push({ channel: c, score });
    }
    out.sort((a, b) => a.score - b.score);
    if (numbered) out.unshift({ channel: numbered, score: -1 });
    return out;
  }

  private scoreOf(orig: NameKeys, disp: NameKeys | undefined, q: CompiledQuery): number {
    const a = nameMatchScore(orig, q);
    return disp === undefined || a === 0 ? a : Math.min(a, nameMatchScore(disp, q));
  }

  /**
   * Search matches that only the region rule hides (catalogue-personalisation §2.2 "Results in hidden groups (n)"):
   * channels of rule-hidden groups, never user-hidden groups or channels; `count` is every match, `channels` the first
   * `limit`, best first (as `searchScored`). Each is the playlist channel (renamed), not a folded row.
   */
  searchRuleHidden(query: string, limit: number): { count: number; channels: Channel[] } {
    const q = compileQuery(query);
    const rule = this.rd.ruleHidden;
    if (!q || rule.size === 0) return { count: 0, channels: [] };
    const keys = searchKeys(this.base);
    const found: { c: Channel; score: number }[] = [];
    for (const c of this.base.channels) {
      const gid = groupIdOf(c);
      if (!rule.has(gid) || this.userHiddenGr.has(gid) || this.hiddenCh.has(c.id) || this.noEpg?.has(c.id)) continue;
      const score = this.scoreOf(keys.get(c.id)!, this.renamedKeys.get(c.id), q);
      if (score !== NO_MATCH) found.push({ c, score });
    }
    found.sort((a, b) => a.score - b.score);
    const channels = found.slice(0, Math.max(0, limit)).map((m) => this.display(m.c));
    return { count: found.length, channels };
  }

  private rowKey(row: Channel): NameKeys {
    let k = this.rowKeys.get(row.id);
    if (k === undefined) {
      k = nameKeys(row.name);
      this.rowKeys.set(row.id, k);
    }
    return k;
  }

  /** True when this index folds duplicate channels into rows. */
  folding(): boolean {
    return this.fb !== undefined;
  }

  /** The row id of any channel id (itself when not folded); undefined for an unknown id. */
  rowOf(id: string): string | undefined {
    if (!this.fb) return this.base.byId.has(id) ? id : undefined;
    const fi = this.fb.foldIndexOf.get(id);
    return fi === undefined ? undefined : this.fb.leads[fi]!.id;
  }

  /**
   * The streams of `id`'s row as display channels (their own names), playlist order: its candidates, else its
   * members that are not hidden. The channel itself when not folding.
   */
  sources(id: string): Channel[] {
    if (!this.fb) {
      const c = this.base.byId.get(id);
      return c ? [this.display(c)] : [];
    }
    const fi = this.fb.foldIndexOf.get(id);
    if (fi === undefined) return [];
    const members = this.fb.members[fi]!;
    let cands = members.filter((m) => this.candidate(m));
    // Your countries on: their streams first, playlist order otherwise (a stable partition).
    if (cands.length > 1 && this.rd.state.mode !== 'off') {
      const mine = cands.filter((m) => this.rd.chosen.has(groupIdOf(m)));
      if (mine.length && mine.length < cands.length) cands = [...mine, ...cands.filter((m) => !this.rd.chosen.has(groupIdOf(m)))];
    }
    return (cands.length ? cands : members.filter((m) => !this.hiddenCh.has(m.id))).map((m) => this.display(m));
  }

  /** `id`'s row as lists show it (its lead named for the row), even when hidden; the channel itself when not folding. */
  rowChannel(id: string): Channel | undefined {
    const fi = this.fb?.foldIndexOf.get(id);
    if (fi === undefined) return this.get(id);
    return this.row(fi) ?? this.display(this.fb!.leads[fi]!);
  }

  /** Every channel id of `id`'s row, hidden ones included, playlist order (`[id]` when not folding). */
  memberIds(id: string): string[] {
    const fi = this.fb?.foldIndexOf.get(id);
    if (fi === undefined) return this.base.byId.has(id) ? [id] : [];
    return this.fb!.members[fi]!.map((m) => m.id);
  }

  /** The fold key of `id`'s row (stable across refreshes; for remembered sources). Undefined when not folding. */
  foldKey(id: string): string | undefined {
    const fi = this.fb?.foldIndexOf.get(id);
    return fi === undefined ? undefined : this.fb!.folds.folds[fi]!.key;
  }

  /**
   * A channel's quality rank and spare-feed tag, from its playlist name, and `chosen` when Your countries is on and
   * its group is one of them (sources play those first). Undefined when not folding.
   */
  memberInfo(id: string): { quality: number; backup: boolean; chosen: boolean } | undefined {
    const at = this.fb?.pos.get(id);
    if (at === undefined) return undefined;
    const f = this.fb!.folds;
    const c = this.base.byId.get(id);
    const chosen = this.rd.state.mode !== 'off' && c !== undefined && this.rd.chosen.has(groupIdOf(c));
    return { quality: f.memberQuality[at]!, backup: f.memberBackup[at] === 1, chosen };
  }

  /**
   * The channel whose playlist data guide lookups use, under `c.id`: for a folded row the first member with a guide
   * id (else the lead); for a renamed channel its playlist original; else `c` itself.
   */
  guideChannel(c: Channel): Channel {
    const fi = this.fb?.foldIndexOf.get(c.id);
    if (fi !== undefined && this.fb!.members[fi]!.length > 1) {
      const g = this.guideMember(fi);
      return g.id === c.id ? g : { ...g, id: c.id };
    }
    return this.renamed.has(c.id) ? this.base.byId.get(c.id) ?? c : c;
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
