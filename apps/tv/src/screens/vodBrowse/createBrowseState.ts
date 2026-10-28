/**
 * Movies or Series browse's state: the kind, the active source and its focus memory (kept across visits per source
 * and kind), the home, rows and categories shown (a later visit draws them at once), the focus by identity and the
 * dwelled title the strip follows. Create it inside the screen component: its signals, memos and effects belong to
 * the screen. Not unit-tested: the pure rules live in browseLogic.ts.
 */
import { createEffect, createMemo, createSignal } from 'solid-js';
import type { MovieView, SeriesView, VodCategoryView, VodHome, VodTile } from '@iptv/app-api';
import { lruGet } from '@iptv/core';
import { dwellSignal } from '../../shell/dwell.ts';
import type { ScreenEntry } from '../../shell/router.ts';
import { initState } from '../../state/appState.ts';
import { cellAt, warmRows, type BrowseFocus, type FocusMemory, type RowModel } from '../../vod/browseLogic.ts';
import type { BrowseArea } from '../../vod/browseNavLogic.ts';
import { catalogueCategories } from '../../vod/categoryPicker.ts';
import { KIND_COPY } from '../../vod/kindCopy.ts';
import type { VodKind } from '../../vod/tabLogic.ts';

/** Per source and kind focus memories kept (least recently used go). */
const MEMORY_MAX = 20;

/**
 * The focus by identity (row id, tile id) and the last column per row id; and the last home, rows and categories
 * shown, so a later visit draws them at once.
 */
interface BrowseMemory { focus: FocusMemory; cols: Map<string, number>; home?: VodHome; rows?: RowModel[]; cats?: VodCategoryView[] }
/** Kept across visits (per source and kind) so Back from the detail or the grid returns to the same poster. */
const memories = new Map<string, BrowseMemory>();
const memoryFor = (key: string): BrowseMemory =>
  lruGet(memories, key, () => ({ focus: { row: 0, col: 0 }, cols: new Map() }), MEMORY_MAX);

export function createBrowseState(entry: ScreenEntry) {
  const params = entry.params as { kind?: VodKind; focus?: 'rail' | 'content' };
  const kind: VodKind = params.kind ?? 'movie';
  const copy = KIND_COPY[kind];
  const startOnRail = params.focus === 'rail';
  delete params.focus;

  const [sourceId, setSourceId] = createSignal<string | undefined>(initState()?.activeSourceId);
  const memKey = () => `${sourceId() ?? ''}:${kind}`;
  let memory = memoryFor(memKey());
  // The last visit's rows draw at once (loaded rows marked stale, so the ones on screen are read again); `load` then
  // merges the fresh home over them.
  const warmStart = memory.home !== undefined && (memory.rows?.length ?? 0) > 0;
  const [home, setHome] = createSignal<VodHome | undefined>(memory.home);
  const [rows, setRows] = createSignal<RowModel[]>(warmRows(memory.rows));
  const [focus, setFocus] = createSignal<BrowseFocus>({ row: memory.focus.row, col: memory.focus.col });
  const [area, setArea] = createSignal<BrowseArea>(startOnRail ? 'rail' : 'rows');
  const [hero, setHero] = createSignal<MovieView | SeriesView | undefined>(undefined);
  /** The grid's categories (the header's picker), read apart from the home (they may wait for the catalogue). */
  const [cats, setCats] = createSignal<VodCategoryView[]>(memory.cats ?? []);
  // What this visit shows is what the next one starts from (never an error: that one reads again).
  createEffect(() => {
    const h = home();
    if (h === undefined || h.status === 'error') return;
    memory.home = h;
    memory.rows = rows();
    memory.cats = cats();
  });
  const categories = createMemo(() => catalogueCategories(cats()));
  const hasHeader = () => categories().length > 0;

  const focusedCell = () => {
    const r = rows()[focus().row];
    return r ? cellAt(r, focus().col) : undefined;
  };
  const focusedTile = (): VodTile | undefined => {
    const c = focusedCell();
    return c?.kind === 'tile' ? c.tile : undefined;
  };
  /** The title the strip, the backdrop and the detail follow: the focused one, once focus rests. */
  const stripTile = dwellSignal(() => focusedTile());
  /**
   * Stores the focus by identity. A row that is still loading keeps the poster remembered for it (found again once
   * its items arrive); a row entered while loading remembers its last column.
   */
  const remember = () => {
    const f = focus();
    const r = rows()[f.row];
    if (r && !r.loaded) {
      memory.focus = r.id === memory.focus.rowId ? { ...memory.focus, row: f.row } : { row: f.row, col: memory.cols.get(r.id) ?? f.col, rowId: r.id };
      return;
    }
    const t = focusedTile();
    memory.focus = { row: f.row, col: f.col, ...(r ? { rowId: r.id } : {}), ...(t ? { tileId: t.id } : {}) };
  };

  return {
    kind, copy, startOnRail, warmStart, sourceId, setSourceId,
    /** The focus memory of the active source and kind (it changes with a source switch: read it each time). */
    memory: () => memory,
    /** Another source became active: its memory is the one used from now on. */
    switchMemory: () => { memory = memoryFor(memKey()); },
    home, setHome, rows, setRows, focus, setFocus, area, setArea, hero, setHero, cats, setCats,
    categories, hasHeader, focusedCell, focusedTile, stripTile, remember,
    status: () => home()?.status,
  };
}

export type BrowseState = ReturnType<typeof createBrowseState>;
