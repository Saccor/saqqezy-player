import type { VodCategoryView } from '@iptv/app-api';
import { VOD_ALL, type VodSort } from '@iptv/core';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { SORT_LABELS } from './gridLogic.ts';
import { grouped } from './kindCopy.ts';

/**
 * The library's categories for the "All categories" picker: everything but the browse rows (Continue watching,
 * Favourites, Recently added: `vod:` ids, rows on browse already), non-empty only, in the worker's order (yours, All,
 * other countries' folded categories, the rest). Empty without a non-empty All.
 */
export function catalogueCategories(cats: readonly VodCategoryView[]): VodCategoryView[] {
  const all = cats.find((c) => c.id === VOD_ALL);
  if (!all || all.count <= 0) return [];
  return cats.filter((c) => !c.id.startsWith('vod:') && c.count > 0);
}

/** Picker rows; the count shows here only (spec §1.4), the current category is checked. */
export function categoryRows(cats: readonly VodCategoryView[], currentId: string | undefined): PickerRow[] {
  return cats.map((c) => ({ kind: 'list', id: c.id, label: `${c.name} · ${grouped(c.count)}`, checked: c.id === currentId }));
}

const SORT_PREFIX = 'sort:';

export function sortRows(sorts: readonly VodSort[], current: VodSort): PickerRow[] {
  return sorts.map((s) => ({ kind: 'list', id: `${SORT_PREFIX}${s}`, label: `Sort: ${SORT_LABELS[s]}`, checked: s === current }));
}

export function pickedSort(row: PickerRow): VodSort | undefined {
  return row.kind === 'list' && row.id.startsWith(SORT_PREFIX) ? (row.id.slice(SORT_PREFIX.length) as VodSort) : undefined;
}
