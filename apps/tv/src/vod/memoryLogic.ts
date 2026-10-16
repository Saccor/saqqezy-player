/** Small bounded memories (focus positions kept across visits). Pure: no Solid, no Lightning. */

/** Stores `value` under `key` as the most recent entry; the least recently used entries go beyond `max`. */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** The entry under `key` (made the most recent), or a new one from `make` when there is none. */
export function lruGet<K, V>(map: Map<K, V>, key: K, make: () => V, max: number): V {
  const v = map.has(key) ? (map.get(key) as V) : make();
  lruSet(map, key, v, max);
  return v;
}
