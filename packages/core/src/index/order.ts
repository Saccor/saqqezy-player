import type { SortMode } from '../layout/types.ts';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * The order of a group's channels, shared by the TV (`ChannelIndex`) and the companion so the two cannot drift:
 * the manual order first (ids not in `src`, and repeats, are skipped), then the rest by the sort mode.
 * - `provider`: `src` order. `number`: by channel number (stable). `name`: by `nameOf`, case-insensitive and numeric.
 * - `srcByNumber`: `src` is already in number order, so `number` mode needs no sort.
 * Returns `src` itself when nothing reorders it.
 */
export function orderGroupChannels<T extends { id: string; number: number }>(
  src: readonly T[],
  mode: SortMode,
  manual: readonly string[] | undefined,
  nameOf: (c: T) => string,
  srcByNumber = false,
): T[] {
  let rest = src as T[];
  if (mode === 'number') { if (!srcByNumber) rest = [...src].sort((a, b) => a.number - b.number); }
  else if (mode === 'name') rest = [...src].sort((a, b) => collator.compare(nameOf(a), nameOf(b)));
  if (!manual || manual.length === 0) return rest;
  const byId = new Map(src.map((c) => [c.id, c]));
  const first: T[] = [];
  const taken = new Set<string>();
  for (const id of manual) {
    const c = byId.get(id);
    if (c && !taken.has(id)) { first.push(c); taken.add(id); }
  }
  if (first.length === 0) return rest;
  return first.concat(rest.filter((c) => !taken.has(c.id)));
}
