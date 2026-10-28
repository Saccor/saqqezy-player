/**
 * Movies or Series browse's "All categories ▾" sheet: other countries fold into one row (spec
 * 2026-10-22-your-countries-flags); a category opens the grid on it. Back goes up a level, else closes to the header.
 * Not unit-tested: the pure rules live in foldPickerLogic.ts.
 */
import { Show } from '@lightningtv/solid';
import type { ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { VodCategoryView } from '@iptv/app-api';
import { flagFor } from '../../assets/flags/index.ts';
import { Sheet } from '../../components/Sheet.tsx';
import { fromPickerRow } from '../../components/sheetLogic.ts';
import { TOP_LEVEL, effectiveLevel as foldEffectiveLevel, foldPick, foldView, levelRowId, levelUp, type FoldLevel } from '../../components/foldPickerLogic.ts';
import { screenOverlayOpen } from '../../shell/logic.ts';
import { router } from '../../shell/router.ts';
import { settings } from '../../state/appState.ts';
import { grouped, type KIND_COPY } from '../../vod/kindCopy.ts';
import type { VodKind } from '../../vod/tabLogic.ts';
import type { PickerRow } from '../homeMenuLogic.ts';

const CATEGORIES_ID = 'browse-categories';

export function createCategorySheet(d: {
  alive: () => boolean;
  kind: VodKind;
  copy: (typeof KIND_COPY)[VodKind];
  categories: () => readonly VodCategoryView[];
  hasHeader: () => boolean;
  /** The poster menu is open (the sheet does not open over it). */
  menuOpen: () => boolean;
  /** Back from the top level: focus on the header. */
  focusHeader: () => void;
}) {
  const { alive, kind, categories } = d;
  const [picking, setPicking] = createSignal(false);
  const [pickerLevel, setPickerLevel] = createSignal<FoldLevel>(TOP_LEVEL);
  const [pickerFocusId, setPickerFocusId] = createSignal<string | undefined>(undefined);
  let pickerNode: ElementNode | undefined;
  let removePicker: (() => void) | undefined;
  const effectiveLevel = (): FoldLevel => foldEffectiveLevel(pickerLevel(), categories());
  // Built only while the picker is open: a library can have 1,000+ categories.
  const pickerView = createMemo(() => {
    if (!picking()) return undefined;
    const r = settings()?.regions;
    return foldView(categories(), effectiveLevel(), {
      title: d.copy.categoriesTitle, picked: r !== undefined && r.mode !== 'off' && r.codes.length > 0, focusId: pickerFocusId(),
      label: (c) => `${c.name} · ${grouped(c.count)}`, flagOf: flagFor,
      onlyCount: r?.mode === 'only' ? r.codes.length : 0,
    });
  });
  const openCategories = () => {
    if (picking() || !d.hasHeader() || screenOverlayOpen() || d.menuOpen()) return;
    setPickerLevel(TOP_LEVEL);
    setPickerFocusId(undefined);
    setPicking(true);
    removePicker = router.pushOverlay(CATEGORIES_ID, closeCategories);
    queueMicrotask(() => { if (alive()) pickerNode?.setFocus(); });
  };
  /** Back on the picker: up one level (focus on the row that opened it), or closed from the top level. */
  function closeCategories() {
    removePicker = undefined;
    const level = effectiveLevel();
    const up = levelUp(level);
    if (up) {
      setPickerFocusId(levelRowId(level));
      setPickerLevel(up);
      removePicker = router.pushOverlay(CATEGORIES_ID, closeCategories);
      return;
    }
    setPicking(false);
    queueMicrotask(() => { if (alive()) d.focusHeader(); });
  }
  /** OK: a level opens in place; a category opens the grid on it (the screen leaves, so nothing is refocused). */
  const pickCategory = (row: PickerRow) => {
    const act = foldPick(effectiveLevel(), row);
    if (act.kind === 'level') {
      setPickerFocusId(undefined);
      setPickerLevel(act.level);
      return;
    }
    if (act.kind === 'none') return;
    removePicker?.();
    removePicker = undefined;
    setPicking(false);
    setPickerLevel(TOP_LEVEL);
    if (act.kind === 'choose') router.push('settings', { page: 'countries' });
    else router.push('vodGrid', { kind, categoryId: act.id });
  };

  const CategoryView = () => (
    <Show when={pickerView()}>
      {(view) => {
        const rows = createMemo(() => view().rows.map(fromPickerRow));
        return (
          <Sheet ref={(el) => { pickerNode = el; }} title={view().title} rows={rows()} backLayerId={CATEGORIES_ID}
            initial={view().initial} resetKey={view().key} onSelect={(_, i) => { const r = view().rows[i]; if (r) pickCategory(r); }} />
        );
      }}
    </Show>
  );

  return {
    openCategories, View: CategoryView,
    /** Unmount: the sheet's back layer goes (without its close handler). */
    cleanup: () => { removePicker?.(); },
  };
}
