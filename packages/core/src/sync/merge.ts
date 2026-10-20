import { clampRemote, compareHlc, decodeHlc, encodeHlc, hlcWall } from './hlc.ts';
import type { SyncKind } from './keys.ts';
import { registerKey, type SyncRecord } from './types.ts';

/** Removals are kept this long so a device that was offline still learns about them (§6.2). */
export const TOMBSTONE_TTL_MS = 90 * 24 * 3600_000;

/** Element sets: membership flags, `false` = removed. */
const ELEMENT_KINDS: ReadonlySet<SyncKind> = new Set<SyncKind>(['vf', 'vs', 'hc', 'hg', 'lm']);
/** Maps and optional registers: `null` = cleared (rename removed, list deleted, provider order, pick forgotten). */
const MAP_KINDS: ReadonlySet<SyncKind> = new Set<SyncKind>(['cn', 'gn', 'ln', 'co', 'vk']);

/** A removal kept only as a tombstone (an element set's `false`, a map's `null`). */
export function isTombstone(r: Pick<SyncRecord, 'k' | 'v'>): boolean {
  return (ELEMENT_KINDS.has(r.k) && r.v === false) || (MAP_KINDS.has(r.k) && r.v === null);
}

/** A stamped value. */
export interface Stamped<T> { t: string; v: T }

/** `b` wins over `a`: a strictly later stamp. Equal stamps (only the same write) keep `a`. */
export const wins = (b: { t: string } | undefined, a: { t: string } | undefined): boolean =>
  b !== undefined && compareHlc(b.t, a?.t) > 0;

/**
 * A remote stamp with its wall time capped at `now + 24 h` (§6.2), so a device with a clock far ahead cannot win every
 * later merge. Malformed stamps come back undefined (the record is dropped).
 */
export function clampStamp(t: string, now: number): string | undefined {
  const h = decodeHlc(t);
  return h ? encodeHlc(clampRemote(h, now)) : undefined;
}

/** Last writer wins for one register (progress, favourite, tracks, version pick, split, a setting, an order). */
export function lwwRegister<T>(local: Stamped<T> | undefined, remote: Stamped<T> | undefined): Stamped<T> | undefined {
  return wins(remote, local) ? remote : local;
}

/** Whole-array LWW (group order, channel order, list order): the newer array replaces the other, never interleaved. */
export const mergeOrder: <T extends readonly string[] | null>(local: Stamped<T> | undefined, remote: Stamped<T> | undefined) => Stamped<T> | undefined = lwwRegister;

/**
 * LWW element set (hidden channels and groups, list membership, favourites, splits): per element, the newer stamp
 * decides whether it is in (`true`) or out (`false`, a tombstone). Returns a new map; inputs are not changed.
 */
export function mergeElementSet(
  local: ReadonlyMap<string, Stamped<boolean>>, remote: ReadonlyMap<string, Stamped<boolean>>,
): Map<string, Stamped<boolean>> {
  const out = new Map(local);
  for (const [id, r] of remote) if (wins(r, out.get(id))) out.set(id, r);
  return out;
}

/** The members of an element set. */
export function members(set: ReadonlyMap<string, Stamped<boolean>>): string[] {
  const out: string[] = [];
  for (const [id, s] of set) if (s.v) out.push(id);
  return out;
}

/** LWW map (channel and group renames): per key, the newer stamp; `null` = rename removed (a tombstone). */
export function mergeLwwMap(
  local: ReadonlyMap<string, Stamped<string | null>>, remote: ReadonlyMap<string, Stamped<string | null>>,
): Map<string, Stamped<string | null>> {
  const out = new Map(local);
  for (const [k, r] of remote) if (wins(r, out.get(k))) out.set(k, r);
  return out;
}

/** Drops tombstones older than `TOMBSTONE_TTL_MS`. Returns a new map. */
export function pruneTombstones<T>(set: ReadonlyMap<string, Stamped<T>>, now: number, isRemoved: (v: T) => boolean): Map<string, Stamped<T>> {
  const out = new Map<string, Stamped<T>>();
  for (const [k, s] of set) if (!(isRemoved(s.v) && hlcWall(s.t) < now - TOMBSTONE_TTL_MS)) out.set(k, s);
  return out;
}

/** Tombstone records older than `TOMBSTONE_TTL_MS`: safe to forget. */
export const expiredTombstone = (r: SyncRecord, now: number): boolean => isTombstone(r) && hlcWall(r.t) < now - TOMBSTONE_TTL_MS;

export interface MergeResult {
  /** Remote records that win and must be applied here (stamps clamped), one per register. */
  apply: SyncRecord[];
  /** Local registers after the merge, by `registerKey`. */
  state: Map<string, SyncRecord>;
}

/**
 * Merges remote records into the local registers (`registerKey` → record). Remote stamps are clamped to
 * `now + 24 h` first; malformed ones are dropped. Each register keeps its newest write; `apply` lists the remote
 * winners. Progress is a register like any other: the newer write wins even with an earlier position (re-watching and
 * mark unwatched must sync), never the furthest position.
 */
export function mergeRecords(local: ReadonlyMap<string, SyncRecord>, remote: readonly SyncRecord[], now: number): MergeResult {
  const state = new Map(local);
  const winners = new Map<string, SyncRecord>();
  for (const r of remote) {
    const t = clampStamp(r.t, now);
    if (!t) continue;
    const rec = t === r.t ? r : { ...r, t };
    const key = registerKey(rec);
    if (!wins(rec, state.get(key))) continue;
    state.set(key, rec);
    winners.set(key, rec);
  }
  return { apply: [...winners.values()], state };
}
