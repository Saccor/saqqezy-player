/** Bounded least-recently-used memories on a plain `Map` (insertion order is recency order). */

/**
 * Stores `value` under `key` as the most recent entry; the least recently used entries beyond `max` are dropped,
 * each handed to `onEvict` first when given.
 */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number, onEvict?: (key: K, value: V) => void): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.entries().next();
    if (oldest.done) break;
    map.delete(oldest.value[0]);
    onEvict?.(oldest.value[0], oldest.value[1]);
  }
}

/** The entry under `key` (made the most recent), or a new one from `make` when there is none. */
export function lruGet<K, V>(map: Map<K, V>, key: K, make: () => V, max: number): V {
  const v = map.has(key) ? (map.get(key) as V) : make();
  lruSet(map, key, v, max);
  return v;
}
