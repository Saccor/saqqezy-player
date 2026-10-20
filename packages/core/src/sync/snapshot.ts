import { GROUP_FAV } from '../constants.ts';
import { emptyLayout, type Layout, type LayoutOp, type SortMode } from '../layout/types.ts';
import { DEFAULT_SETTINGS, type AppSettings } from '../settings.ts';
import type { VodKind, VodUserRecord, VodUserState } from '../vod/types.ts';
import { encodeHlc, hlcWall, isHlc } from './hlc.ts';
import { SYNC_KIND, clockKey, pairKey, parseClockKey, type SyncKind } from './keys.ts';
import { SYNCED_SETTINGS } from './payload.ts';
import { fromSid, toSid } from './ref.ts';
import { registerKey, type ProgressValue, type SyncRecord, type SyncValue, type TracksValue } from './types.ts';

/**
 * The bridge between this device's user state and sync records (S1 backup and restore; S2 reuses it).
 *
 * Export reads only the synced set of §6.3: the layout's lists, hidden items, renames, orders, sorts and `hideNoEpg`;
 * VOD progress, favourites, tracks, version picks and splits; the synced settings. Never `recent`, last channel,
 * device-tuned settings, sources, credentials, channels, catalogues or programmes: none of them is an input here.
 *
 * State that no clock stamped (written before S0, or settings changed before they were stamped) is either left out
 * (`skip`: the local side of a merge, so anything restored wins over it) or carried with a synthetic stamp (node
 * `000000`; wall time 0, or a VOD record's `updatedAt`), which any real write beats. Synthetic stamps are never
 * adopted as clocks.
 */

/** The node id of synthetic stamps (no device has it: `newNodeId` never yields six zeros in practice). */
export const SYNTHETIC_NODE = '000000';
/** The settings clocks' `syncMeta` scope (settings belong to no source). */
export const SETTINGS_SCOPE = '#settings';

export const isSyntheticStamp = (t: string): boolean => t.endsWith(SYNTHETIC_NODE);
const synthetic = (wall = 0): string => encodeHlc({ wall: Math.max(0, Math.floor(wall)), counter: 0, node: SYNTHETIC_NODE });

export interface ExportOptions {
  /** `synthetic`: unstamped state goes out with a synthetic stamp (a backup). `skip`: it is left out (merge input). */
  unstamped: 'synthetic' | 'skip';
}

/** Everything export needs to know about one source. Ids are this device's stored ids. */
export interface SourceState {
  sourceId: string;
  /** The source's fingerprint under the key in use (backup or sync). */
  sfp: string;
  layout: Layout;
  /** The source's clocks: clock key → stamp. */
  clocks: ReadonlyMap<string, string>;
  vodUser: readonly VodUserRecord[];
  picks: Readonly<Record<VodKind, Readonly<Record<string, string>>>>;
  splits: Readonly<Record<VodKind, ReadonlySet<string>>>;
}

const VOD_KINDS: readonly VodKind[] = ['movie', 'series'];
/** A list's group id prefix (sorts and channel orders of a list are keyed `list:<id>`). */
const LIST_PREFIX = 'list:';
const K = SYNC_KIND;

/** The records of one source's synced state. */
export function exportSource(s: SourceState, opts: ExportOptions): SyncRecord[] {
  const out: SyncRecord[] = [];
  const sid = (id: string) => toSid(s.sourceId, id);
  /** Emits a record for a register that holds a value now. */
  const put = (k: SyncKind, key: string, refSid: string, v: SyncValue, opt: { pk?: string; wall?: number } = {}) => {
    const t = s.clocks.get(clockKey(k, key));
    // Unstamped state that only holds the empty layout's default says nothing worth restoring.
    if (t === undefined && (opts.unstamped === 'skip' || isDefault(k, key, v))) return;
    const ref: SyncRecord['ref'] = { sfp: s.sfp, sid: refSid };
    if (opt.pk !== undefined) ref.pk = opt.pk;
    out.push({ k, ref, t: t ?? synthetic(opt.wall), v });
  };
  /** Clocks of `k` whose register no longer holds a value: tombstones (`false` or `null`). */
  const tombstones = (k: SyncKind, present: (key: string) => boolean, toRef: (key: string) => { sid: string; pk?: string } | undefined, v: false | null) => {
    for (const [ck, t] of s.clocks) {
      const parsed = parseClockKey(ck);
      if (!parsed || parsed.kind !== k || present(parsed.key)) continue;
      const r = toRef(parsed.key);
      if (!r) continue;
      const ref: SyncRecord['ref'] = { sfp: s.sfp, sid: r.sid };
      if (r.pk !== undefined) ref.pk = r.pk;
      out.push({ k, ref, t, v });
    }
  };
  const l = s.layout;

  // Hidden channels and groups (element sets).
  const hiddenC = new Set(l.hiddenChannels);
  for (const id of hiddenC) put(K.hiddenChannel, id, sid(id), true);
  tombstones(K.hiddenChannel, (key) => hiddenC.has(key), (key) => ({ sid: sid(key) }), false);
  const hiddenG = new Set(l.hiddenGroups);
  for (const id of hiddenG) put(K.hiddenGroup, id, id, true);
  tombstones(K.hiddenGroup, (key) => hiddenG.has(key), (key) => ({ sid: key }), false);

  // Lists: names (null = deleted), members (element set), channel order, list order.
  const lists = new Map(l.lists.map((x) => [x.id, x]));
  const memberKeys = new Set<string>();
  for (const list of l.lists) {
    put(K.listName, list.id, list.id, list.name);
    put(K.listChannels, list.id, list.id, list.channelIds.map(sid));
    for (const ch of list.channelIds) {
      const key = pairKey(list.id, ch);
      memberKeys.add(key);
      put(K.listMember, key, pairKey(list.id, sid(ch)), true);
    }
  }
  tombstones(K.listName, (key) => lists.has(key), (key) => ({ sid: key }), null);
  tombstones(K.listMember, (key) => memberKeys.has(key), (key) => {
    const bar = key.indexOf('|');
    return bar > 0 ? { sid: pairKey(key.slice(0, bar), sid(key.slice(bar + 1))) } : undefined;
  }, false);
  put(K.listOrder, '', '', l.lists.map((x) => x.id));

  // Renames (LWW maps, null = rename removed).
  for (const [id, name] of Object.entries(l.channelNames)) put(K.channelName, id, sid(id), name);
  tombstones(K.channelName, (key) => key in l.channelNames, (key) => ({ sid: sid(key) }), null);
  for (const [id, name] of Object.entries(l.groupNames)) put(K.groupName, id, id, name);
  tombstones(K.groupName, (key) => key in l.groupNames, (key) => ({ sid: key }), null);

  // Orders and sorts.
  put(K.groupOrder, '', '', l.groupOrder.slice());
  for (const [target, ids] of Object.entries(l.channelOrder)) put(K.channelOrder, target, target, ids.map(sid));
  tombstones(K.channelOrder, (key) => key in l.channelOrder, (key) => ({ sid: key }), null);
  for (const [target, mode] of Object.entries(l.sort)) put(K.sort, target, target, mode);
  put(K.hideNoEpg, '', '', l.hideNoEpg);

  // VOD user state.
  for (const { itemId, state } of s.vodUser) {
    const id = sid(itemId);
    const p = progressValue(s.sourceId, state);
    if (p.p > 0 || p.w || p.s || s.clocks.has(clockKey(K.progress, itemId))) put(K.progress, itemId, id, p, { wall: state.updatedAt });
    if (state.favourite || s.clocks.has(clockKey(K.favourite, itemId))) put(K.favourite, itemId, id, state.favourite);
    const tr: TracksValue = {};
    if (state.audio) tr.a = state.audio;
    if (state.subtitle) tr.s = state.subtitle;
    if (tr.a || tr.s || s.clocks.has(clockKey(K.tracks, itemId))) put(K.tracks, itemId, id, tr);
  }
  for (const kind of VOD_KINDS) {
    for (const [key, itemId] of Object.entries(s.picks[kind])) put(K.pick, pairKey(kind, key), kind, sid(itemId), { pk: key });
    const splits = s.splits[kind];
    for (const key of splits) put(K.split, pairKey(kind, key), kind, true, { pk: key });
  }
  tombstones(K.split, (key) => {
    const bar = key.indexOf('|');
    return bar > 0 && (s.splits[key.slice(0, bar) as VodKind]?.has(key.slice(bar + 1)) ?? false);
  }, (key) => {
    const bar = key.indexOf('|');
    const kind = key.slice(0, bar);
    return bar > 0 && (kind === 'movie' || kind === 'series') ? { sid: kind, pk: key.slice(bar + 1) } : undefined;
  }, false);
  return out;
}

const EMPTY = emptyLayout();
/** The register holds what a fresh layout holds (no lists, no order, Favourites empty, `hideNoEpg` off). */
function isDefault(k: SyncKind, key: string, v: SyncValue): boolean {
  switch (k) {
    case K.listOrder: return JSON.stringify(v) === JSON.stringify(EMPTY.lists.map((x) => x.id));
    case K.listName: return key === GROUP_FAV && v === EMPTY.lists[0]!.name;
    case K.listChannels: return key === GROUP_FAV && Array.isArray(v) && v.length === 0;
    case K.groupOrder: return Array.isArray(v) && v.length === 0;
    case K.hideNoEpg: return v === EMPTY.hideNoEpg;
    default: return false;
  }
}

function progressValue(sourceId: string, s: VodUserState): ProgressValue {
  const out: ProgressValue = { p: Math.max(0, Math.floor(s.position)), d: Math.max(0, Math.floor(s.duration)), w: s.watched };
  if (s.series) {
    out.s = { id: toSid(sourceId, s.series.id), se: s.series.season, ep: s.series.episode };
    if (s.series.next) out.s.n = { id: toSid(sourceId, s.series.next.id), se: s.series.next.season, ep: s.series.next.episode };
  }
  return out;
}

/** The synced settings (§6.3 subset), stamped from the settings clocks (`st:<name>`). */
export function exportSettings(settings: AppSettings, clocks: ReadonlyMap<string, string>, opts: ExportOptions): SyncRecord[] {
  const out: SyncRecord[] = [];
  const rec = settings as unknown as Record<string, unknown>;
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  for (const name of SYNCED_SETTINGS) {
    if (!(name in rec)) continue;
    const t = clocks.get(clockKey(K.setting, name));
    const v = rec[name];
    // Unstamped defaults are left out, like the empty layout's.
    if (t === undefined && (opts.unstamped === 'skip' || JSON.stringify(v) === JSON.stringify(defaults[name]))) continue;
    out.push({ k: K.setting, ref: { sfp: '', sid: name }, t: t ?? synthetic(), v: (Array.isArray(v) ? v.slice() : v) as SyncValue });
  }
  return out;
}

/** Records by register (`registerKey`): the local side of `mergeRecords`. */
export function registerMap(records: readonly SyncRecord[]): Map<string, SyncRecord> {
  const out = new Map<string, SyncRecord>();
  for (const r of records) out.set(registerKey(r), r);
  return out;
}

// ---------- restore ----------

/** A VOD user-state change of one item: each present part replaces that part of the stored state. */
export interface VodRestore {
  itemId: string;
  progress?: { position: number; duration: number; watched: boolean; updatedAt: number; series?: VodUserState['series'] };
  favourite?: boolean;
  tracks?: TracksValue;
}

export interface StampEntry { key: string; t: string }

export interface SourceRestorePlan {
  /** Layout ops in dependency order (lists before members, members before orders). */
  ops: LayoutOp[];
  vod: VodRestore[];
  picks: { kind: VodKind; key: string; itemId: string }[];
  splits: { kind: VodKind; key: string; on: boolean }[];
  /** Clocks to adopt (real stamps only), by this device's clock keys. */
  stamps: StampEntry[];
}

/** Applies a VOD restore to stored state. */
export function applyVodRestore(prev: VodUserState | undefined, r: VodRestore): VodUserState {
  const s: VodUserState = { ...(prev ?? { position: 0, duration: 0, watched: false, favourite: false, updatedAt: 0 }) };
  if (r.progress) {
    s.position = r.progress.position;
    s.duration = r.progress.duration;
    s.watched = r.progress.watched;
    s.updatedAt = r.progress.updatedAt;
    if (r.progress.series) s.series = r.progress.series;
    else delete s.series;
  }
  if (r.favourite !== undefined) s.favourite = r.favourite;
  if (r.tracks) {
    if (r.tracks.a) s.audio = r.tracks.a;
    else delete s.audio;
    if (r.tracks.s) s.subtitle = r.tracks.s;
    else delete s.subtitle;
  }
  return s;
}

/**
 * Turns the winning records of one source (`mergeRecords(...).apply`, refs already matched to `sourceId` by
 * fingerprint) into changes on this device: layout ops (validated and capped by the reducer when applied), VOD
 * writes, picks, splits and the clocks to adopt.
 */
export function planSourceRestore(sourceId: string, layout: Layout, winners: readonly SyncRecord[]): SourceRestorePlan {
  const plan: SourceRestorePlan = { ops: [], vod: [], picks: [], splits: [], stamps: [] };
  const local = (refSid: string) => fromSid(sourceId, refSid);
  const by = new Map<SyncKind, SyncRecord[]>();
  for (const r of winners) {
    const list = by.get(r.k);
    if (list) list.push(r);
    else by.set(r.k, [r]);
  }
  const of = (k: SyncKind) => by.get(k) ?? [];
  const stamp = (k: SyncKind, key: string, t: string) => { if (!isSyntheticStamp(t) && isHlc(t)) plan.stamps.push({ key: clockKey(k, key), t }); };
  const ops = plan.ops;

  // 1. Lists: create, rename, delete.
  const lists = new Map(layout.lists.map((x) => [x.id, x.channelIds.slice()]));
  for (const r of of(K.listName)) {
    const id = r.ref.sid;
    stamp(K.listName, id, r.t);
    if (typeof r.v === 'string') {
      if (lists.has(id)) ops.push({ op: 'renameList', listId: id, name: r.v });
      else {
        ops.push({ op: 'createList', id, name: r.v });
        lists.set(id, []);
      }
    } else if (r.v === null && lists.has(id) && id !== GROUP_FAV) {
      ops.push({ op: 'deleteList', listId: id });
      lists.delete(id);
    }
  }
  // 2. Members.
  const adds = new Map<string, string[]>();
  const removes = new Map<string, string[]>();
  for (const r of of(K.listMember)) {
    const bar = r.ref.sid.indexOf('|');
    const listId = r.ref.sid.slice(0, bar);
    const ch = local(r.ref.sid.slice(bar + 1));
    stamp(K.listMember, pairKey(listId, ch), r.t);
    const members = lists.get(listId);
    if (!members) continue;
    const target = r.v === true ? adds : removes;
    const arr = target.get(listId);
    if (arr) arr.push(ch);
    else target.set(listId, [ch]);
    if (r.v === true) { if (!members.includes(ch)) members.push(ch); }
    else lists.set(listId, members.filter((x) => x !== ch));
  }
  for (const [listId, ids] of removes) ops.push({ op: 'removeFromList', listId, channelIds: ids });
  for (const [listId, ids] of adds) ops.push({ op: 'addToList', listId, channelIds: ids });
  // 3. Channel order inside a list: the restored order for its members, other members after them.
  for (const r of of(K.listChannels)) {
    stamp(K.listChannels, r.ref.sid, r.t);
    const members = lists.get(r.ref.sid);
    if (!members || !Array.isArray(r.v)) continue;
    const want = (r.v as string[]).map(local).filter((id) => members.includes(id));
    const order = [...new Set([...want, ...members])];
    if (order.length && order.join('\n') !== members.join('\n')) {
      ops.push({ op: 'removeFromList', listId: r.ref.sid, channelIds: members.slice() });
      ops.push({ op: 'addToList', listId: r.ref.sid, channelIds: order });
    }
  }
  // 4. List order (Favourites stays first).
  for (const r of of(K.listOrder)) {
    stamp(K.listOrder, '', r.t);
    if (!Array.isArray(r.v)) continue;
    const present = [...lists.keys()];
    const order = [...new Set([...(r.v as string[]).filter((id) => lists.has(id)), ...present])].filter((id) => id !== GROUP_FAV);
    order.forEach((listId, i) => ops.push({ op: 'moveList', listId, toIndex: i + 1 }));
  }
  // 5. Hidden channels and groups.
  const flags = (k: SyncKind, toLocal: (s: string) => string, hide: 'hideChannels' | 'hideGroups', show: 'unhideChannels' | 'unhideGroups') => {
    const on: string[] = [];
    const off: string[] = [];
    for (const r of of(k)) {
      const id = toLocal(r.ref.sid);
      stamp(k, id, r.t);
      (r.v === true ? on : off).push(id);
    }
    if (on.length) ops.push({ op: hide, ids: on });
    if (off.length) ops.push({ op: show, ids: off });
  };
  flags(K.hiddenChannel, local, 'hideChannels', 'unhideChannels');
  flags(K.hiddenGroup, (x) => x, 'hideGroups', 'unhideGroups');
  // 6. Renames.
  for (const r of of(K.channelName)) {
    const id = local(r.ref.sid);
    stamp(K.channelName, id, r.t);
    ops.push({ op: 'renameChannel', id, name: typeof r.v === 'string' ? r.v : null });
  }
  for (const r of of(K.groupName)) {
    stamp(K.groupName, r.ref.sid, r.t);
    ops.push({ op: 'renameGroup', id: r.ref.sid, name: typeof r.v === 'string' ? r.v : null });
  }
  // 7. Orders, sorts, hideNoEpg.
  for (const r of of(K.groupOrder)) {
    stamp(K.groupOrder, '', r.t);
    if (Array.isArray(r.v)) ops.push({ op: 'setGroupOrder', ids: (r.v as string[]).slice() });
  }
  for (const r of of(K.channelOrder)) {
    stamp(K.channelOrder, r.ref.sid, r.t);
    // A deleted list's order went with the list.
    if (r.ref.sid.startsWith(LIST_PREFIX) && !lists.has(r.ref.sid.slice(LIST_PREFIX.length))) continue;
    ops.push({ op: 'setChannelOrder', groupId: r.ref.sid, ids: Array.isArray(r.v) ? (r.v as string[]).map(local) : null });
  }
  for (const r of of(K.sort)) {
    stamp(K.sort, r.ref.sid, r.t);
    if (r.ref.sid.startsWith(LIST_PREFIX) && !lists.has(r.ref.sid.slice(LIST_PREFIX.length))) continue;
    if (typeof r.v === 'string') ops.push({ op: 'setSort', groupId: r.ref.sid, mode: r.v as SortMode });
  }
  for (const r of of(K.hideNoEpg)) {
    stamp(K.hideNoEpg, '', r.t);
    if (typeof r.v === 'boolean') ops.push({ op: 'setHideNoEpg', value: r.v });
  }

  // 8. VOD: one change per item.
  const vod = new Map<string, VodRestore>();
  const item = (id: string) => {
    let v = vod.get(id);
    if (!v) vod.set(id, (v = { itemId: id }));
    return v;
  };
  for (const r of of(K.progress)) {
    const id = local(r.ref.sid);
    stamp(K.progress, id, r.t);
    const p = r.v as ProgressValue;
    const progress: NonNullable<VodRestore['progress']> = { position: p.p, duration: p.d, watched: p.w, updatedAt: hlcWall(r.t) };
    if (p.s) {
      progress.series = { id: local(p.s.id), season: p.s.se, episode: p.s.ep };
      if (p.s.n) progress.series.next = { id: local(p.s.n.id), season: p.s.n.se, episode: p.s.n.ep };
    }
    item(id).progress = progress;
  }
  for (const r of of(K.favourite)) {
    const id = local(r.ref.sid);
    stamp(K.favourite, id, r.t);
    item(id).favourite = r.v === true;
  }
  for (const r of of(K.tracks)) {
    const id = local(r.ref.sid);
    stamp(K.tracks, id, r.t);
    item(id).tracks = { ...(r.v as TracksValue) };
  }
  plan.vod = [...vod.values()];
  for (const r of of(K.pick)) {
    const kind = r.ref.sid as VodKind;
    if (r.ref.pk === undefined || typeof r.v !== 'string') continue;
    stamp(K.pick, pairKey(kind, r.ref.pk), r.t);
    plan.picks.push({ kind, key: r.ref.pk, itemId: local(r.v) });
  }
  for (const r of of(K.split)) {
    const kind = r.ref.sid as VodKind;
    if (r.ref.pk === undefined) continue;
    stamp(K.split, pairKey(kind, r.ref.pk), r.t);
    plan.splits.push({ kind, key: r.ref.pk, on: r.v === true });
  }
  return plan;
}

/** The winning settings records as one patch of the synced subset, plus the clocks to adopt. */
export function planSettingsRestore(winners: readonly SyncRecord[]): { patch: Partial<AppSettings>; stamps: StampEntry[] } {
  const patch: Record<string, unknown> = {};
  const stamps: StampEntry[] = [];
  for (const r of winners) {
    if (r.k !== K.setting || r.ref.sfp !== '' || !SYNCED_SETTINGS.has(r.ref.sid)) continue;
    patch[r.ref.sid] = Array.isArray(r.v) ? r.v.slice() : r.v;
    if (!isSyntheticStamp(r.t)) stamps.push({ key: clockKey(K.setting, r.ref.sid), t: r.t });
  }
  return { patch: patch as Partial<AppSettings>, stamps };
}
