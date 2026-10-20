import { MAX_PROGRAMME_MS } from '../storage.ts';

/**
 * Meta key of the longest programme stored by a source's last guide import. Programme reads look back only that
 * far before their window (instead of `MAX_PROGRAMME_MS`), so a now/next page deserialises far fewer records.
 */
export const epgLongestKey = (id: string): string => `epgLongest:${id}`;

/** Written with the generation switch; a record of another generation is stale (a crash, or an older import). */
export interface EpgLongestRecord {
  gen: number;
  ms: number;
}

/** The look-back for reads of generation `gen`: the recorded longest programme, else (and at most) 24 hours. */
export function lookBackFor(rec: unknown, gen: number): number {
  if (!rec || typeof rec !== 'object') return MAX_PROGRAMME_MS;
  const { gen: g, ms } = rec as Partial<EpgLongestRecord>;
  if (g !== gen || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return MAX_PROGRAMME_MS;
  return Math.min(ms, MAX_PROGRAMME_MS);
}
