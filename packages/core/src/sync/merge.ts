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
