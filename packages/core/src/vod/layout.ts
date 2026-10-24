import { MAX_ID_LEN, MAX_IDS, MAX_OPS_PER_BATCH } from '../layout/types.ts';
import { codeIndexOf, foldActive, pickRank, splitFold } from '../index/countryFold.ts';
import type { RegionState } from '../index/channelIndex.ts';
import type { RegionMode } from '../settings.ts';
import { SYNC_KIND, clockKey, pairKey } from '../sync/keys.ts';
import { detectRegions, isSure, regionKeys, type GroupRegion } from '../text/regions.ts';
import type { VodCategory, VodKind, VodList } from './types.ts';

/**
 * The user's movie or series category layout for one source and kind (report 2026-10-20 §2.2): the same pattern as
 * the live `Layout` (copy-on-write, `applyVodOps`), and the same region rule (hidden > shown > region).
 */
export interface VodLayout {
  /** Edit counter: +1 per applied batch. */
  version: number;
  hiddenCategories: string[];
  /** Categories the user moved, first, in this order; the rest follow in provider order. */
  categoryOrder: string[];
  /** Shown on purpose: beats the region rule. */
  shownCategories: string[];
}

export type VodLayoutOp =
  | { op: 'hideCategories'; ids: string[] }
  | { op: 'unhideCategories'; ids: string[] }
  | { op: 'showCategories'; ids: string[] }
  | { op: 'unshowCategories'; ids: string[] }
  | { op: 'setCategoryOrder'; ids: string[] };

export interface VodApplyResult {
  layout: VodLayout;
  changed: boolean;
  rejected: { index: number; reason: string }[];
  /** Sync clock keys of what changed (`ch`/`cs`: `<kind>|<id>`, `cq`: kind). */
  touched: string[];
}

export const vodLayoutKey = (kind: VodKind, sourceId: string): string => `vodLayout:${kind}:${sourceId}`;

export function emptyVodLayout(): VodLayout {
  return { version: 0, hiddenCategories: [], categoryOrder: [], shownCategories: [] };
}

const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_ID_LEN;
function idList(x: unknown): x is string[] {
  if (!Array.isArray(x) || x.length > MAX_IDS) return false;
  for (let i = 0; i < x.length; i++) if (!isId(x[i])) return false;
  return true;
}
const OPS: readonly string[] = ['hideCategories', 'unhideCategories', 'showCategories', 'unshowCategories', 'setCategoryOrder'];

export function isVodLayoutOp(x: unknown): x is VodLayoutOp {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return typeof o['op'] === 'string' && OPS.includes(o['op']) && idList(o['ids']) && Object.keys(o).length === 2;
}

export function isVodLayoutOpBatch(x: unknown): x is VodLayoutOp[] {
  return Array.isArray(x) && x.length <= MAX_OPS_PER_BATCH && x.every(isVodLayoutOp);
}

const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];

/** `cur` plus the unseen `ids` (null: nothing new), or 'cap'. */
function added(cur: readonly string[], ids: readonly string[]): string[] | 'cap' | null {
  const seen = new Set(cur);
  const add = dedupe(ids).filter((id) => !seen.has(id));
  if (!add.length) return null;
  return cur.length + add.length > MAX_IDS ? 'cap' : [...cur, ...add];
}

function removed(cur: readonly string[], ids: readonly string[]): string[] | null {
  const drop = new Set(ids);
  const next = cur.filter((x) => !drop.has(x));
  return next.length === cur.length ? null : next;
}

/** Pure: applies `ops` to a copy of `layout` (never mutated). Rejected ops are reported and skipped. */
export function applyVodOps(layout: VodLayout, kind: VodKind, ops: readonly VodLayoutOp[]): VodApplyResult {
  const work: VodLayout = { ...layout };
  const rejected: VodApplyResult['rejected'] = [];
  const touched = new Set<string>();
  const flip = (k: typeof SYNC_KIND.hiddenCategory | typeof SYNC_KIND.shownCategory, before: readonly string[], after: readonly string[]) => {
    const a = new Set(before);
    const b = new Set(after);
    for (const id of new Set([...before, ...after])) if (a.has(id) !== b.has(id)) touched.add(clockKey(k, pairKey(kind, id)));
  };
  ops.forEach((op, index) => {
    if (!isVodLayoutOp(op)) { rejected.push({ index, reason: 'unknown op' }); return; }
    const hid = work.hiddenCategories;
    const shown = work.shownCategories;
    switch (op.op) {
      case 'hideCategories': {
        const h = added(hid, op.ids);
        if (h === 'cap') { rejected.push({ index, reason: 'too many entries' }); return; }
        if (h) work.hiddenCategories = h;
        const s = removed(shown, op.ids);
        if (s) work.shownCategories = s;
        break;
      }
      case 'unhideCategories': {
        const h = removed(hid, op.ids);
        if (h) work.hiddenCategories = h;
        break;
      }
      case 'showCategories': {
        const s = added(shown, op.ids);
        if (s === 'cap') { rejected.push({ index, reason: 'too many entries' }); return; }
        if (s) work.shownCategories = s;
        const h = removed(hid, op.ids);
        if (h) work.hiddenCategories = h;
        break;
      }
      case 'unshowCategories': {
        const s = removed(shown, op.ids);
        if (s) work.shownCategories = s;
        break;
      }
      case 'setCategoryOrder': {
        const next = dedupe(op.ids);
        if (next.length !== work.categoryOrder.length || next.some((v, i) => v !== work.categoryOrder[i])) {
          work.categoryOrder = next;
          touched.add(clockKey(SYNC_KIND.categoryOrder, kind));
        }
        break;
      }
    }
    flip(SYNC_KIND.hiddenCategory, hid, work.hiddenCategories);
    flip(SYNC_KIND.shownCategory, shown, work.shownCategories);
  });
  const changed = work.hiddenCategories !== layout.hiddenCategories || work.shownCategories !== layout.shownCategories
    || work.categoryOrder !== layout.categoryOrder;
  if (!changed) return { layout: { ...layout }, changed: false, rejected, touched: [] };
  work.version = layout.version + 1;
  return { layout: work, changed: true, rejected, touched: [...touched] };
}

function cleanIds(x: unknown): string[] {
  return Array.isArray(x) ? dedupe(x.slice(0, MAX_IDS * 2).filter(isId)).slice(0, MAX_IDS) : [];
}

/** Repairs a stored or received layout; unknown shapes give an empty one. */
export function normalizeVodLayout(x: unknown): VodLayout {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return emptyVodLayout();
  const o = x as Record<string, unknown>;
  const v = o['version'];
  return {
    version: typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0,
    hiddenCategories: cleanIds(o['hiddenCategories']),
    categoryOrder: cleanIds(o['categoryOrder']),
    shownCategories: cleanIds(o['shownCategories']),
  };
}

// ---------- regions ----------

/** Titles per category read for the member vote: enough for a majority, bounded for 200k-item catalogues. */
const MEMBER_SAMPLE = 40;

/** Detected regions of a catalogue's provider categories (names, plus a sample of titles for the member vote). */
export function detectVodRegions(list: VodList): Record<string, GroupRegion> {
  const members = new Map<string, string[]>();
  for (const c of list.categories) members.set(c.id, []);
  for (const it of list.items) {
    const m = members.get(it.categoryId);
    if (m && m.length < MEMBER_SAMPLE) m.push(it.title);
  }
  return detectRegions(list.categories.map((c) => ({ id: c.id, name: c.name, members: members.get(c.id)! })));
}

export interface VodRegionView {
  detected: Readonly<Record<string, GroupRegion>>;
  codes: readonly string[];
  mode: RegionMode;
  /** Fold other countries' categories under "Other countries" (the `foldCountries` setting). Absent: no fold. */
  fold?: boolean;
}

/** What a catalogue shows: visible category ids in order, the effective hidden set, and the rule's state. */
export interface VodCategoryView {
  order: string[];
  hidden: ReadonlySet<string>;
  /** Hidden by the region rule only. */
  regionHidden: ReadonlySet<string>;
  /** Region keys per category (sure detections only). */
  keysOf: ReadonlyMap<string, readonly string[]>;
  /** Categories of a chosen country (empty while the rule is off). */
  chosen: ReadonlySet<string>;
  state: RegionState;
  /** The first `yours` ids of `order` are the user's: moved by hand (`categoryOrder`), then chosen countries' by pick order. */
  yours: number;
  /** Categories folded under another country, by the region key they fold under (they follow `yours` in country order). */
  foldOf: ReadonlyMap<string, string>;
}

/**
 * The region rule over categories: user hidden > user shown > rule (`only` hides other countries' categories; ones
 * with no sure detection stay). Order: the user's `categoryOrder`, then (rule on) chosen countries' categories by pick
 * order, then, while the fold is active, other countries' categories in country order (`foldOf`), then the rest, in
 * provider order. No category matching the chosen codes: the rule is off and `state.stale` is set.
 */
export function vodCategoryView(categories: readonly VodCategory[], layout: VodLayout, regions?: VodRegionView): VodCategoryView {
  const requested = regions?.mode ?? 'off';
  const codes = new Set(regions?.codes ?? []);
  const keysOf = new Map<string, readonly string[]>();
  const chosen = new Set<string>();
  for (const c of categories) {
    const d = regions?.detected[c.id];
    const keys = d && isSure(d) ? regionKeys(d) : [];
    keysOf.set(c.id, keys);
    if (keys.some((k) => codes.has(k))) chosen.add(c.id);
  }
  const stale = requested !== 'off' && codes.size > 0 && chosen.size === 0;
  const on = requested !== 'off' && codes.size > 0 && !stale;
  if (!on) chosen.clear();
  const state: RegionState = { mode: on ? requested : 'off', requested, stale };
  const userHidden = new Set(layout.hiddenCategories);
  const shown = new Set(layout.shownCategories);
  const regionHidden = new Set<string>();
  if (on && requested === 'only') {
    for (const [id, keys] of keysOf) if (keys.length && !chosen.has(id) && !shown.has(id) && !userHidden.has(id)) regionHidden.add(id);
  }
  const hidden = new Set([...userHidden, ...regionHidden]);
  const known = new Set(categories.map((c) => c.id));
  const order: string[] = [];
  const seen = new Set<string>();
  const take = (id: string) => { if (known.has(id) && !seen.has(id)) { seen.add(id); if (!hidden.has(id)) order.push(id); } };
  for (const id of layout.categoryOrder) take(id);
  if (on) {
    const index = codeIndexOf(regions!.codes);
    const picked = categories
      .filter((c) => chosen.has(c.id) && !seen.has(c.id))
      .map((c, i) => ({ id: c.id, rank: pickRank(keysOf.get(c.id) ?? [], index), i }))
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.i - b.i));
    for (const p of picked) take(p.id);
  }
  const yours = order.length;
  const tail: string[] = [];
  for (const c of categories) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (!hidden.has(c.id)) tail.push(c.id);
  }
  const distinct = new Set<string>();
  for (const id of order) for (const k of keysOf.get(id) ?? []) distinct.add(k);
  for (const id of tail) for (const k of keysOf.get(id) ?? []) distinct.add(k);
  const foldOf = new Map<string, string>();
  if (foldActive(regions?.fold === true, state.mode, distinct.size)) {
    const split = splitFold(tail, (id) => keysOf.get(id) ?? []);
    for (const { item, key } of split.country) { order.push(item); foldOf.set(item, key); }
    for (const id of split.rest) order.push(id);
  } else {
    for (const id of tail) order.push(id);
  }
  return { order, hidden, regionHidden, keysOf, chosen, state, yours, foldOf };
}
