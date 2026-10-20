import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { VodCategoryView, VodTile } from '@iptv/app-api';
import { VOD_ROW_CONTINUE, VOD_ROW_RECENT } from '@iptv/app-api';
import type { VodSort } from '@iptv/core';
import { api } from '../api.ts';
import { Button } from '../components/Button.tsx';
import { DropdownHeader } from '../components/DropdownHeader.tsx';
import { ListPicker } from '../components/ListPicker.tsx';
import { PosterTile } from '../components/PosterTile.tsx';
import { ScrollIndicator } from '../components/ScrollIndicator.tsx';
import { renderRange, scrollTopFor } from '../components/virtualWindow.ts';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { dwellSignal } from '../shell/dwell.ts';
import { Rail } from '../shell/Rail.tsx';
import { belowTab } from '../shell/railLogic.ts';
import { goRailNested } from '../shell/railNav.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { initState, settings } from '../state/appState.ts';
import type { PickerRow } from './homeMenuLogic.ts';
import { categoryRows, pickedSort, sortRows } from '../vod/categoryPicker.ts';
import {
  GRID_PAGE, GRID_VIEW_ROWS, GRID_Y, gridCellAt, gridLayout, gridMove, gridPage, keepFailedPages, loadSort, pagesFor, renderedRows, saveSort, sortsFor,
  type GridGeometry,
} from '../vod/gridLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { KIND_COPY } from '../vod/kindCopy.ts';
import { lruSet } from '../vod/memoryLogic.ts';
import { metaLine } from '../vod/posterLogic.ts';
import { joinMeta, tileStatus } from '../vod/stripLogic.ts';
import type { VodKind } from '../vod/tabLogic.ts';

/**
 * Layout (1080p design space, UI revamp "Movies library"): the category header at the top left, the focused title and
 * its meta at the top right, an 8-column poster grid from (160, 150) with three full rows and a fourth peeking in, and
 * a scroll indicator at the right edge.
 */
const GRID_X = LAYOUT.contentX;
const GRID_W = LAYOUT.contentW;
const CELL_GAP = 24;
const HEAD_Y = LAYOUT.safeY;
/**
 * The grid node covers the grid only (not the whole screen), so its pointer target never overlaps the rail or the
 * header. It reaches PAD past the tiles on the left and top so a focused tile's scale and ring are not clipped.
 */
const PAD = 16;
const SCROLL_X = 1860;
const SCROLL_H = LAYOUT.height - LAYOUT.safeY - GRID_Y; // 876
/** The focused title and meta at the top right: two right-aligned lines in a box ending at the grid's right edge. */
const INFO_W = 760;
/** The category header ends at least this far left of the info box. */
const HEAD_INFO_GAP = 24;
const HEAD_PAD_X = 20; // DropdownHeader draws its pill this far left of x
const HEAD_MAX_W = GRID_W - INFO_W - HEAD_INFO_GAP + HEAD_PAD_X;
const META_DY = 36;
const CATEGORIES_ID = 'grid-categories';

type Area = 'rail' | 'header' | 'grid' | 'retry';

interface GridMemory { focus: number; top: number }
/** Kept across visits so Back from the detail returns to the same poster; the 20 most recently used (source, kind, category, sort). */
const memories = new Map<string, GridMemory>();
const MEMORY_MAX = 20;

const store = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

/**
 * Library grid: the app rail, a "Category ▾" header (its picker lists the categories, then the sorts), the focused
 * title and meta at the top right, and an 8-column poster grid (titles show on focus, not under the tiles).
 */
export function VodGridScreen(props: { entry: ScreenEntry }) {
  /** `sort`: open on this order (Start's Top rated "View all"); the remembered sort is left as it was. */
  const params = props.entry.params as { kind?: VodKind; categoryId?: string; sort?: VodSort };
  const kind: VodKind = params.kind ?? 'movie';
  const copy = KIND_COPY[kind];
  /**
   * The grid is pushed over Movies/Series browse or Start: the rail shows that screen's tab, and a tab choice pops the
   * grid first, then moves as that screen would.
   */
  const lower = router.below();
  const below = belowTab(lower?.screen, (lower?.params as { kind?: VodKind } | undefined)?.kind, kind);

  const [cats, setCats] = createSignal<VodCategoryView[]>([]);
  const [catIndex, setCatIndex] = createSignal(0);
  const [sort, setSort] = createSignal<VodSort>('title');
  const [total, setTotal] = createSignal(0);
  const [pages, setPages] = createSignal(new Map<number, VodTile[]>());
  const [focus, setFocus] = createSignal(0);
  const [area, setArea] = createSignal<Area>('grid');
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  const [failed, setFailed] = createSignal(false);
  let railNode: ElementNode | undefined;
  let headerNode: ElementNode | undefined;
  let gridNode: ElementNode | undefined;
  let retryNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let alive = true;
  let lastTopRow = 0;
  /** Standard 8 or Compact 10 per row; everything below follows it. */
  const posterSize = () => settings()?.posterSize ?? 'standard';
  const layout = () => gridLayout(posterSize());
  const geo = (): GridGeometry => ({ pad: PAD, cellW: layout().cellW, gap: CELL_GAP, rowPitch: layout().rowPitch, hitH: layout().cellH });
  const rowCount = () => Math.ceil(total() / layout().cols);
  /** Bumped per category/sort change: answers for an older one are dropped. */
  let gen = 0;
  /** Pages being fetched, keyed `gen:page`, so a dropped (stale or failed) page is asked for again later. */
  const inflight = new Set<string>();
  /**
   * The grid was asked for while it had no titles (a load in flight), so focus went to a fallback; once titles arrive
   * the grid takes it. Every focus move made through `focusArea` (all key moves) sets it afresh.
   */
  let wantGrid = false;

  const cat = () => cats()[catIndex()];
  const memKey = () => `${initState()?.activeSourceId ?? ''}:${kind}:${cat()?.id ?? ''}:${sort()}`;
  const remember = () => { if (cat()) lruSet(memories, memKey(), { focus: focus(), top: topRow() }, MEMORY_MAX); };
  const sorts = () => sortsFor(cats().some((c) => c.id === VOD_ROW_RECENT));
  const tileAt = (i: number) => pages().get(Math.floor(i / GRID_PAGE))?.[i % GRID_PAGE];
  const topRow = createMemo(() => {
    lastTopRow = scrollTopFor(Math.floor(focus() / layout().cols), lastTopRow, GRID_VIEW_ROWS, rowCount());
    return lastTopRow;
  });
  const indices = createMemo(() => {
    // No buffer rows, and a peeking row only when enough of it shows (`renderedRows`): every drawn row is a row of
    // natural-size poster textures on 1 GB TVs.
    const cols = layout().cols;
    const r = renderRange(topRow(), renderedRows(posterSize()), rowCount(), 0);
    const out: number[] = [];
    for (let row = r.from; row < r.to; row++) for (let c = 0; c < cols; c++) if (row * cols + c < total()) out.push(row * cols + c);
    return out;
  });

  const fetchPage = async (p: number, myGen: number) => {
    const id = cat()?.id;
    if (!id) return;
    const key = `${myGen}:${p}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    try {
      const slice = await api.getVodSlice(kind, id, sort(), p * GRID_PAGE, GRID_PAGE);
      if (!alive || myGen !== gen) return;
      batch(() => {
        setTotal(slice.total);
        setPages((cur) => new Map(cur).set(p, slice.rows));
      });
    } catch (err) {
      console.warn('VOD page failed', errName(err));
    } finally {
      inflight.delete(key);
    }
  };

  /** Fetches the pages behind the rendered tiles that are not here yet. A failed page is asked for again on the next move. */
  const ensurePages = () => {
    const n = total();
    const ix = indices();
    if (n <= 0 || ix.length === 0) return;
    const myGen = gen;
    const from = Math.max(0, Math.min(n - 1, ix[0]!));
    const to = Math.max(0, Math.min(n - 1, ix[ix.length - 1]!));
    for (const p of pagesFor(from, to)) if (!pages().has(p)) void fetchPage(p, myGen);
  };

  const noOverlay = () => router.topOverlay() === undefined && !menu.isOpen();

  /** 'grid' falls back to Try again (error), then the header; the header to Try again, then the rail. */
  const focusArea = (a: Area) => {
    const asked = a;
    if (a === 'grid' && total() === 0) a = failed() && retryNode ? 'retry' : 'header';
    if (a === 'header' && !headerNode) a = retryNode ? 'retry' : 'rail';
    if (a === 'retry' && !retryNode) a = 'rail';
    wantGrid = asked === 'grid' && a !== 'grid';
    setArea(a);
    (a === 'rail' ? railNode : a === 'header' ? headerNode : a === 'retry' ? retryNode : gridNode)?.setFocus();
    return true;
  };
  /** After a load: the grid when it was asked for, and never focus left on an empty grid. */
  const settleFocus = () => {
    if (!noOverlay()) return;
    // A failed load lands on the new Try again button (focusArea falls back to it); area 'retry' never rests on a dead node.
    if ((wantGrid && (total() > 0 || failed())) || (area() === 'grid' && total() === 0) || area() === 'retry') focusArea('grid');
  };

  /** Reloads the first page of the current category and sort. */
  const reset = async () => {
    const myGen = ++gen;
    inflight.clear();
    const mem = memories.get(memKey());
    lastTopRow = 0;
    batch(() => {
      setFocus(0);
      setPages(new Map());
      setTotal(0);
      setFailed(false);
      setHover(undefined);
    });
    const id = cat()?.id;
    if (!id) return;
    try {
      // A remembered position: load the page it lives on first.
      const want = mem ? Math.floor(mem.focus / GRID_PAGE) : 0;
      const first = await api.getVodSlice(kind, id, sort(), want * GRID_PAGE, GRID_PAGE);
      if (!alive || myGen !== gen) return;
      const restore = mem !== undefined && first.total > 0;
      const idx = restore ? Math.min(mem.focus, first.total - 1) : 0;
      // The total shrank so the clamped index left that page: start at the top instead.
      const ok = restore && Math.floor(idx / GRID_PAGE) === want;
      batch(() => {
        lastTopRow = ok ? mem.top : 0;
        setTotal(first.total);
        setPages(new Map([[want, first.rows]]));
        setFocus(ok ? idx : 0);
      });
      ensurePages();
    } catch (err) {
      if (!alive || myGen !== gen) return;
      console.warn('VOD load failed', errName(err));
      setFailed(true);
    }
    // The focused grid may have just become empty (a removed title, a failed load): never leave focus on nothing.
    if (alive && myGen === gen) settleFocus();
  };

  /**
   * Re-reads the current category after a change made here (a poster-menu action): the grid stays as it is, with the
   * same focused index (clamped to the new total) and the same scroll, until the fresh pages around it have arrived.
   */
  const reload = async () => {
    const myGen = ++gen;
    inflight.clear();
    // The picker's counts (Continue watching, Favourites) may have changed too. The pseudo-categories are always
    // listed, so indexes stay put.
    void api.getVodCategories(kind).then((cs) => { if (alive) setCats(cs); }).catch(() => undefined);
    const id = cat()?.id;
    if (!id) return;
    const keep = focus();
    const oldIx = indices();
    try {
      const probePage = Math.floor(keep / GRID_PAGE);
      const probe = await api.getVodSlice(kind, id, sort(), probePage * GRID_PAGE, GRID_PAGE);
      if (!alive || myGen !== gen) return;
      const n = probe.total;
      let fresh = new Map<number, VodTile[]>([[probePage, probe.rows]]);
      const idx = n > 0 ? Math.min(keep, n - 1) : 0;
      if (n > 0) {
        const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
        const want = new Set(pagesFor(clamp(oldIx[0] ?? idx), clamp(oldIx[oldIx.length - 1] ?? idx)));
        want.add(Math.floor(idx / GRID_PAGE));
        const others = [...want].filter((p) => p * GRID_PAGE < n && p !== probePage);
        // One failed page must not throw the others away: it keeps its old rows.
        const results = await Promise.allSettled(others.map((p) => api.getVodSlice(kind, id, sort(), p * GRID_PAGE, GRID_PAGE)));
        if (!alive || myGen !== gen) return;
        const failedPages: number[] = [];
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') fresh.set(others[i]!, r.value.rows);
          else failedPages.push(others[i]!);
        });
        fresh = keepFailedPages(fresh, failedPages, pages(), n, GRID_PAGE);
      }
      batch(() => {
        if (n === 0) lastTopRow = 0;
        setTotal(n);
        setPages(n === 0 ? new Map() : fresh);
        setFocus(idx);
        setHover(undefined);
      });
      remember();
      ensurePages();
    } catch (err) {
      if (!alive || myGen !== gen) return;
      console.warn('VOD reload failed', errName(err));
    }
    if (alive && myGen === gen) settleFocus();
  };

  const commitCat = (i: number) => {
    if (i === catIndex()) return Promise.resolve();
    setCatIndex(i);
    return reset();
  };

  const moveGrid = (key: 'up' | 'down' | 'left' | 'right') => {
    const r = gridMove(focus(), key, total(), layout().cols);
    if (r === 'rail') return focusArea('rail');
    if (r === 'header') return focusArea('header');
    setFocus(r);
    setHover(undefined);
    remember();
    ensurePages();
    return true;
  };
  const page = (dir: 1 | -1) => {
    setFocus(gridPage(focus(), dir, total(), layout().cols));
    setHover(undefined);
    remember();
    ensurePages();
    return true;
  };
  const open = () => {
    const t = tileAt(focus());
    remember();
    if (t) router.push(copy.detailRoute, { id: t.id, tile: t });
    return true;
  };
  const menu = createPosterMenu({ refocus: () => focusArea(area()), onChanged: () => void reload() });
  const openMenu = () => {
    const t = tileAt(focus());
    if (t) menu.open(t, cat()?.id === VOD_ROW_CONTINUE);
    return true;
  };

  // ---- category and sort picker ----
  const [picking, setPicking] = createSignal(false);
  let removePicker: (() => void) | undefined;
  /** Every category the grid has (Continue watching, Favourites and Recently added included), then the sorts. */
  const pickerRows = (): PickerRow[] => [...categoryRows(cats(), cat()?.id), ...sortRows(sorts(), sort())];
  const openPicker = () => {
    if (picking() || cats().length === 0 || !noOverlay()) return;
    setPicking(true);
    removePicker = router.pushOverlay(CATEGORIES_ID, closePicker);
    queueMicrotask(() => { if (alive) pickerNode?.setFocus(); });
  };
  /** Back on the picker: focus returns to the header. */
  function closePicker() {
    removePicker = undefined;
    setPicking(false);
    queueMicrotask(() => { if (alive) focusArea('header'); });
  }
  /** A sort re-sorts (and is remembered); a category opens on it. Then the grid takes the focus, once it has titles. */
  const pick = (row: PickerRow) => {
    removePicker?.();
    removePicker = undefined;
    setPicking(false);
    const s = pickedSort(row);
    if (s) {
      if (s !== sort()) {
        setSort(s);
        saveSort(kind, s, store());
        void reset();
      }
    } else if (row.kind === 'list') {
      const i = cats().findIndex((c) => c.id === row.id);
      if (i >= 0) void commitCat(i);
    }
    queueMicrotask(() => { if (alive) focusArea('grid'); });
  };

  // Pointer: a click opens the tile, a right click opens its menu, the wheel moves a row (never out of the grid).
  const cellAt = (p: Point) => gridCellAt(p.x, p.y, topRow(), geo(), total(), layout().cols);
  usePointerTarget({
    node: () => gridNode,
    enabled: () => total() > 0,
    onHover: (p) => setHover(p ? cellAt(p) : undefined),
    subAt: cellAt,
    onClick: (p) => {
      const i = cellAt(p);
      if (i === undefined || !tileAt(i)) return;
      setFocus(i);
      focusArea('grid');
      open();
    },
    onContextMenu: (p) => {
      const i = cellAt(p);
      if (i === undefined || !tileAt(i)) return;
      setFocus(i);
      focusArea('grid');
      openMenu();
    },
    onWheel: (dy) => {
      if (dy === 0) return true;
      const r = gridMove(focus(), dy > 0 ? 'down' : 'up', total(), layout().cols);
      if (typeof r === 'number' && r !== focus()) {
        setFocus(r);
        remember();
        ensurePages();
      }
      setHover(undefined);
      return true;
    },
  });

  const start = async () => {
      setFailed(false);
      let cs: VodCategoryView[];
      try {
        cs = await api.getVodCategories(kind);
      } catch (err) {
        if (!alive) return;
        console.warn('VOD categories failed', errName(err));
        setFailed(true);
        settleFocus();
        return;
      }
      if (!alive) return;
      const i = Math.max(0, cs.findIndex((c) => c.id === params.categoryId));
      batch(() => {
        setCats(cs);
        const sorts = sortsFor(cs.some((c) => c.id === VOD_ROW_RECENT));
        setSort(params.sort && sorts.includes(params.sort) ? params.sort : loadSort(kind, sorts, store()));
        setCatIndex(i);
      });
      await reset();
      if (alive && noOverlay()) focusArea('grid');
  };
  onMount(() => { void start(); });
  /** Try again: re-reads the categories when there are none, else the current category. */
  const retry = () => {
    // The button goes while loading: clear `failed` first so the fallback is the header (not the unmounting button);
    // wantGrid stays set, so the grid takes the focus when titles arrive and a new failure lands on the new button.
    setFailed(false);
    focusArea('grid');
    void (cats().length === 0 ? start() : reset());
  };
  onCleanup(() => {
    alive = false;
    gen++;
    inflight.clear();
    removePicker?.();
  });

  const x = (i: number) => PAD + (i % layout().cols) * (layout().cellW + CELL_GAP);
  const y = (i: number) => PAD + (Math.floor(i / layout().cols) - topRow()) * layout().rowPitch;

  /** The focused title and its meta, once focus rests. */
  const shown = dwellSignal(() => tileAt(focus()));
  const infoTitle = () => shown()?.title ?? '';
  const infoMeta = () => {
    const t = shown();
    return t ? joinMeta(metaLine({ year: t.year, rating: t.rating }), tileStatus(t)) : '';
  };
  /** Back from the grid or the header goes to the rail; Back on the rail returns to where the grid was opened from. */
  const back = () => {
    if (area() !== 'rail') return focusArea('rail');
    router.back();
    return true;
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={back}>
      <Rail ref={(el) => { railNode = el; }} active={below} onSelect={(t) => { if (noOverlay()) goRailNested(below, t, () => router.back({ focusRail: true })); }}
        onRight={() => focusArea(total() > 0 ? 'grid' : 'header')} onFocusChanged={(f) => { if (f) setArea('rail'); }} />
      <Show when={cats().length > 0}>
        <DropdownHeader ref={(el) => { headerNode = el; onCleanup(() => { if (headerNode === el) headerNode = undefined; }); }}
          x={GRID_X} y={HEAD_Y} label={cat()?.name ?? ''} maxWidth={HEAD_MAX_W} onPress={openPicker}
          onDown={() => focusArea('grid')} onLeft={() => focusArea('rail')} onFocusChanged={(f) => { if (f) setArea('header'); }} />
      </Show>
      <Text x={GRID_X + GRID_W - INFO_W} y={HEAD_Y + 2} width={INFO_W} maxWidth={INFO_W} contain="width" textAlign="right" maxLines={1}
        fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{infoTitle()}</Text>
      <Text x={GRID_X + GRID_W - INFO_W} y={HEAD_Y + META_DY} width={INFO_W} maxWidth={INFO_W} contain="width" textAlign="right" maxLines={1}
        fontSize={TYPE.meta} color={COLORS.muted}>{infoMeta()}</Text>
      <View ref={(el) => { gridNode = el; }} x={GRID_X - PAD} y={GRID_Y - PAD} width={GRID_W + PAD * 2} height={LAYOUT.height - (GRID_Y - PAD)} clipping
        onFocusChanged={(f: boolean) => { if (f) setArea('grid'); }}
        onUp={() => moveGrid('up')} onDown={() => moveGrid('down')} onLeft={() => moveGrid('left')} onRight={() => moveGrid('right')}
        onChannelUp={() => page(-1)} onChannelDown={() => page(1)} onEnter={open} onMenu={openMenu} onLongOk={openMenu}>
        <For each={indices()}>{(i) => (
          <PosterTile x={x(i)} y={y(i)} w={layout().cellW} h={layout().cellH} tile={tileAt(i)} lit={area() === 'grid' && focus() === i}
            hover={pointerMode() && hover() === i} />
        )}</For>
      </View>
      <ScrollIndicator x={SCROLL_X} y={GRID_Y} height={SCROLL_H} total={rowCount()} visible={GRID_VIEW_ROWS} first={topRow()} />
      <Show when={failed()}>
        <Text x={GRID_X} y={GRID_Y} fontSize={TYPE.body} color={COLORS.muted}>{copy.loadError}</Text>
        <Button ref={(el) => { retryNode = el; onCleanup(() => { if (retryNode === el) retryNode = undefined; }); }} x={GRID_X} y={GRID_Y + 80} label="Try again" onPress={retry}
          onUp={() => focusArea('header')} />
      </Show>
      <Show when={!failed() && total() === 0 && cats().length > 0}>
        <Text x={GRID_X} y={GRID_Y} fontSize={TYPE.body} color={COLORS.muted}>{'Nothing here yet.'}</Text>
      </Show>
      <View zIndex={5}><menu.View /></View>
      <Show when={picking()}>
        <ListPicker ref={(el) => { pickerNode = el; }} title={copy.categoriesTitle} rows={pickerRows()}
          onPick={pick} hint="Ok picks · Back closes" />
      </Show>
    </View>
  );
}
