import type { SyncKind } from './keys.ts';
import type { SyncRef } from './ref.ts';

/** VOD progress register value (§6.2: last writer wins on the whole register, never furthest-wins). */
export interface ProgressValue {
  /** Position (ms). */
  p: number;
  /** Duration (ms), 0 when unknown. */
  d: number;
  /** Watched. */
  w: boolean;
  /** Episodes: series sid, season, episode, and the next episode when known. */
  s?: { id: string; se: number; ep: number; n?: { id: string; se: number; ep: number } };
}

export interface TracksValue { a?: string; s?: string }

/** Only these values can be synced: flags, short strings, string arrays (orders), progress and tracks. Never objects of the catalogue. */
export type SyncValue = boolean | string | null | string[] | ProgressValue | TracksValue;

/**
 * One synced register (decoded form). What `ref` names depends on the kind:
 * - `vp`, `vf`, `vt`: `sid` = item sid; `pk` = title group key (movies) or `<series key>|S<s>E<e>` (episodes).
 * - `vk`, `vs`: `sid` = `movie` or `series`; `pk` = title group key.
 * - `hc`, `cn`: `sid` = channel sid. `hg`, `gn`, `co`, `so`: `sid` = group id.
 * - `lm`: `sid` = `<listId>|<channel sid>`. `lq`, `ln`: `sid` = list id. `lo`, `go`, `ne`: `sid` = ''.
 * - `st`: `sfp` = '' (not tied to a source), `sid` = setting name.
 */
export interface SyncRecord {
  k: SyncKind;
  ref: SyncRef;
  /** HLC stamp of the write. */
  t: string;
  v: SyncValue;
}

/**
 * The register a record writes. VOD progress is keyed by title group (`pk`) with the version secondary, so a resume
 * on one version and a later one on another are one register (§6.2, §3.2); everything else by its `sid`.
 */
export function registerKey(r: SyncRecord): string {
  const { sfp, sid, pk } = r.ref;
  const id = r.k === 'vp' && pk ? `#${pk}` : (r.k === 'vk' || r.k === 'vs') ? `${sid}|${pk ?? ''}` : sid;
  return `${sfp}\n${r.k}\n${id}`;
}
