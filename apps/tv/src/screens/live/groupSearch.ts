import type { FoldEntry, FoldView } from '../../components/foldPickerLogic.ts';
import { LIVE_COPY } from '../../copy.ts';
import type { PickerRow } from '../homeMenuLogic.ts';

/**
 * Search in Live TV's Groups picker: a row on top of the first level opens the keyboard; while a query is typed the
 * picker lists every folder whose name has all its words (folded countries too), so a long list needs no scrolling.
 */

export const GROUP_SEARCH_ROW_ID = 'search:groups';

/** Lower case without accents, so "cafe" finds "Café". */
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The folders whose name contains every word of `query` (none for an empty query), in list order. */
export function groupMatches(entries: readonly FoldEntry[], query: string): FoldEntry[] {
  const words = fold(query).split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [];
  return entries.filter((e) => {
    const name = fold(e.name);
    return words.every((w) => name.includes(w));
  });
}

export const isGroupSearchRow = (r: PickerRow): boolean => r.kind === 'list' && r.id === GROUP_SEARCH_ROW_ID;

/** The picker's first level with the search row on top; with a query, the matching folders instead of the level. */
export function withGroupSearch(
  view: FoldView, entries: readonly FoldEntry[], query: string,
  o: { label: (e: FoldEntry) => string; currentId?: string },
): FoldView {
  const q = query.trim();
  if (q === '') {
    const search: PickerRow = { kind: 'list', id: GROUP_SEARCH_ROW_ID, label: LIVE_COPY.groupSearch.row, checked: false };
    return { ...view, rows: [search, ...view.rows], initial: view.initial + 1 };
  }
  const found = groupMatches(entries, q);
  const search: PickerRow = { kind: 'list', id: GROUP_SEARCH_ROW_ID, label: LIVE_COPY.groupSearch.found(q, found.length), checked: false };
  const rows: PickerRow[] = found.length > 0
    ? found.map((e) => ({ kind: 'list', id: e.id, label: o.label(e), checked: e.id === o.currentId }))
    : [{ kind: 'heading', label: LIVE_COPY.groupSearch.none }];
  return { title: view.title, rows: [search, ...rows], initial: found.length > 0 ? 1 : 0, key: `search:${q}` };
}
