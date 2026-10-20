import type { VodCategoryView } from '@iptv/app-api';
import { VOD_ALL, type VodSort } from '@iptv/core';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { SORT_LABELS } from './gridLogic.ts';
import { grouped } from './kindCopy.ts';

/** The library's categories from its All entry on (the ones before it are rows on browse already), non-empty only. */
export function catalogueCategories(cats: readonly VodCategoryView[]): VodCategoryView[] {
  const at = cats.findIndex((c) => c.id === VOD_ALL);
  if (at < 0 || cats[at]!.count <= 0) return [];
  return cats.slice(at).filter((c) => c.count > 0);
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
