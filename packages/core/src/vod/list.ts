import { UNCATEGORIZED } from '../constants.ts';
import { VOD_UNCATEGORIZED, type Episode, type Season, type VodCategory, type VodItem, type VodKind, type VodList } from './types.ts';

export const emptyVodList = (): VodList => ({ items: [], categories: [] });

/**
 * Finishes a fetched or parsed list: items whose category is unknown move to `VOD_UNCATEGORIZED` (mutates them),
 * categories get counts, empty categories are dropped, and the uncategorised one goes last.
 */
export function buildVodList(
  kind: VodKind,
  items: VodItem[],
  categories: VodCategory[],
  extras: { episodes?: Record<string, Episode[]>; truncated?: boolean } = {},
): VodList {
  const known = new Set(categories.map((c) => c.id));
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!known.has(it.categoryId)) it.categoryId = VOD_UNCATEGORIZED;
    counts.set(it.categoryId, (counts.get(it.categoryId) ?? 0) + 1);
  }
  const cats: VodCategory[] = categories
    .map((c) => ({ id: c.id, kind, name: c.name, count: counts.get(c.id) ?? 0 }))
    .filter((c) => c.count > 0);
  const unc = counts.get(VOD_UNCATEGORIZED);
  if (unc && !known.has(VOD_UNCATEGORIZED)) cats.push({ id: VOD_UNCATEGORIZED, kind, name: UNCATEGORIZED, count: unc });
  const list: VodList = { items, categories: cats };
  if (extras.episodes) list.episodes = extras.episodes;
  if (extras.truncated) list.truncated = true;
  return list;
}

/** Groups episodes into seasons, both ascending; equal episode numbers keep their input order. */
export function seasonsOf(episodes: Episode[], names: Map<number, string> = new Map()): Season[] {
  const bySeason = new Map<number, Episode[]>();
  for (const e of episodes) {
    const list = bySeason.get(e.season) ?? [];
    list.push(e);
    bySeason.set(e.season, list);
  }
  return [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, eps]) => ({
      number,
      name: names.get(number) ?? `Season ${number}`,
      episodes: eps.map((e, i) => ({ e, i })).sort((a, b) => a.e.episode - b.e.episode || a.i - b.i).map(({ e }) => e),
    }));
}
