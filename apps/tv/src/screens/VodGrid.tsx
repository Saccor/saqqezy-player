import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { VodCategoryView, VodTile } from '@iptv/app-api';
import { VOD_ROW_CONTINUE, VOD_ROW_RECENT } from '@iptv/app-api';
import type { VodSort } from '@iptv/core';
import { api } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { Button } from '../components/Button.tsx';
import { GroupList } from '../components/GroupList.tsx';
import { PosterTile } from '../components/PosterTile.tsx';
import { renderRange, scrollTopFor } from '../components/virtualWindow.ts';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { createDebounce } from '../playback/debounce.ts';
import { BOTTOM_ROW_Y } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { initState } from '../state/appState.ts';
import {
  GRID_COLS, GRID_PAGE, GRID_VIEW_ROWS, SORT_LABELS, gridCellAt, gridMove, gridPage, keepFailedPages, loadSort, nextSort, pagesFor, saveSort, sortsFor,
  type GridGeometry,
} from '../vod/gridLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { KIND_COPY } from '../vod/kindCopy.ts';
import { lruSet } from '../vod/memoryLogic.ts';
import { TAB_SWITCH_MS, type VodKind } from '../vod/tabLogic.ts';

const RAIL_X = LAYOUT.safeX;
const RAIL_Y = 158;
const RAIL_W = 360;
// Ends a gap above the bottom row: in pointer mode the shell's Back button (978–1026) would cover its last name.
const RAIL_H = BOTTOM_ROW_Y - LAYOUT.gap - RAIL_Y;
const GRID_X = RAIL_X + RAIL_W + 48;
const GRID_W = LAYOUT.width - LAYOUT.safeX - GRID_X;
const CELL_GAP = 24;
const CELL_W = Math.floor((GRID_W - CELL_GAP * (GRID_COLS - 1)) / GRID_COLS);
const CELL_H = Math.round(CELL_W * 1.5);
const ROW_PITCH = CELL_H + 88;
const GRID_Y = 246;
const HEAD_Y = 158;
const SORT_W = 300;
/** The header's width: up to a gap before the Sort button. */
const HEAD_W = LAYOUT.width - LAYOUT.safeX - SORT_W - LAYOUT.gap - GRID_X;
/**
 * The grid node covers the grid only (not the whole screen), so its pointer target never overlaps the rail or the sort
 * button. It reaches PAD past the tiles on the left and top so a focused tile's scale and ring are not clipped.
 */
const PAD = 16;
/** Tile, then the title line and the year line under it. */
const GEO: GridGeometry = { pad: PAD, cellW: CELL_W, gap: CELL_GAP, rowPitch: ROW_PITCH, hitH: CELL_H + 44 + FONT.small };

type Area = 'rail' | 'sort' | 'grid' | 'retry';

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

/** Category grid: the rail of categories, a sort button and a 7-column poster grid with titles and years. */
export function VodGridScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { kind?: VodKind; categoryId?: string };
  const kind: VodKind = params.kind ?? 'movie';
  const copy = KIND_COPY[kind];

  const [cats, setCats] = createSignal<VodCategoryView[]>([]);
  const [catIndex, setCatIndex] = createSignal(0);
  /** The rail's highlighted entry (moves at once); the grid follows after TAB_SWITCH_MS. */
  const [railSel, setRailSel] = createSignal(0);
  const [sort, setSort] = createSignal<VodSort>('title');
  const [total, setTotal] = createSignal(0);
  const [pages, setPages] = createSignal(new Map<number, VodTile[]>());
  const [focus, setFocus] = createSignal(0);
  const [area, setArea] = createSignal<Area>('grid');
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  const [failed, setFailed] = createSignal(false);
  let railNode: ElementNode | undefined;
  let sortNode: ElementNode | undefined;
  let gridNode: ElementNode | undefined;
  let retryNode: ElementNode | undefined;
  let alive = true;
  let lastTopRow = 0;
  /** Bumped per category/sort change: answers for an older one are dropped. */
  let gen = 0;
  /** Pages being fetched, keyed `gen:page`, so a dropped (stale or failed) page is asked for again later. */
  const inflight = new Set<string>();

  const cat = () => cats()[catIndex()];
  const memKey = () => `${initState()?.activeSourceId ?? ''}:${kind}:${cat()?.id ?? ''}:${sort()}`;
  const remember = () => { if (cat()) lruSet(memories, memKey(), { focus: focus(), top: topRow() }, MEMORY_MAX); };
  const sorts = () => sortsFor(cats().some((c) => c.id === VOD_ROW_RECENT));
  const tileAt = (i: number) => pages().get(Math.floor(i / GRID_PAGE))?.[i % GRID_PAGE];
  const topRow = createMemo(() => {
    lastTopRow = scrollTopFor(Math.floor(focus() / GRID_COLS), lastTopRow, GRID_VIEW_ROWS, Math.ceil(total() / GRID_COLS));
    return lastTopRow;
  });
  const indices = createMemo(() => {
    const r = renderRange(topRow(), GRID_VIEW_ROWS + 1, Math.ceil(total() / GRID_COLS), 1);
    const out: number[] = [];
    for (let row = r.from; row < r.to; row++) for (let c = 0; c < GRID_COLS; c++) if (row * GRID_COLS + c < total()) out.push(row * GRID_COLS + c);
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

  const focusArea = (a: Area) => {
    if (a === 'grid' && total() === 0) a = 'rail';
    if (a === 'retry' && !retryNode) a = 'rail';
    setArea(a);
    (a === 'rail' ? railNode : a === 'sort' ? sortNode : a === 'retry' ? retryNode : gridNode)?.setFocus();
    return true;
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
    if (alive && myGen === gen && area() === 'grid' && total() === 0 && noOverlay()) focusArea('rail');
  };

  /**
   * Re-reads the current category after a change made here (a poster-menu action): the grid stays as it is, with the
   * same focused index (clamped to the new total) and the same scroll, until the fresh pages around it have arrived.
   */
  const reload = async () => {
    const myGen = ++gen;
    inflight.clear();
    // The rail counts (Continue watching, Favourites) may have changed too. The pseudo-categories are always listed, so
    // indexes stay put.
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
    if (alive && myGen === gen && area() === 'grid' && total() === 0 && noOverlay()) focusArea('rail');
  };

  const commitCat = (i: number) => {
    if (i === catIndex()) return Promise.resolve();
    setCatIndex(i);
    return reset();
  };
  const pickCat = createDebounce<number>(TAB_SWITCH_MS, (i) => { void commitCat(i); });

  const rightTarget = (): Area => (total() > 0 ? 'grid' : failed() ? 'retry' : 'sort');

  /** Right from the rail: a category chosen a moment ago is applied first, so the grid never shows the old one. */
  const railRight = () => {
    if (pickCat.pending()) {
      pickCat.cancel();
      void commitCat(railSel()).then(() => { if (alive && area() === 'rail' && noOverlay()) focusArea(rightTarget()); });
      return true;
    }
    return focusArea(rightTarget());
  };

  const moveGrid = (key: 'up' | 'down' | 'left' | 'right') => {
    const r = gridMove(focus(), key, total());
    if (r === 'rail') return focusArea('rail');
    if (r === 'header') return focusArea('sort');
    setFocus(r);
    setHover(undefined);
    remember();
    ensurePages();
    return true;
  };
  const page = (dir: 1 | -1) => {
    setFocus(gridPage(focus(), dir, total()));
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
  const cycleSort = () => {
    const s = nextSort(sort(), sorts());
    setSort(s);
    saveSort(kind, s, store());
    void reset();
  };

  /** Focus goes to the grid: a pending category pick is dropped and the rail shows the category the grid has. */
  const settleRail = () => {
    pickCat.cancel();
    setRailSel(catIndex());
  };

  // Pointer: a click opens the tile, a right click opens its menu, the wheel moves a row (never out of the grid).
  const cellAt = (p: Point) => gridCellAt(p.x, p.y, topRow(), GEO, total());
  usePointerTarget({
    node: () => gridNode,
    enabled: () => total() > 0,
    onHover: (p) => setHover(p ? cellAt(p) : undefined),
    subAt: cellAt,
    onClick: (p) => {
      const i = cellAt(p);
      if (i === undefined || !tileAt(i)) return;
      settleRail();
      setFocus(i);
      focusArea('grid');
      open();
    },
    onContextMenu: (p) => {
      const i = cellAt(p);
      if (i === undefined || !tileAt(i)) return;
      settleRail();
      setFocus(i);
      focusArea('grid');
      openMenu();
    },
    onWheel: (dy) => {
      if (dy === 0) return true;
      const r = gridMove(focus(), dy > 0 ? 'down' : 'up', total());
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
        if (noOverlay()) focusArea(area() === 'retry' ? 'retry' : 'rail');
        return;
      }
      if (!alive) return;
      const i = Math.max(0, cs.findIndex((c) => c.id === params.categoryId));
      batch(() => {
        setCats(cs);
        setSort(loadSort(kind, sortsFor(cs.some((c) => c.id === VOD_ROW_RECENT)), store()));
        setCatIndex(i);
        setRailSel(i);
      });
      await reset();
      if (alive && noOverlay()) focusArea(total() > 0 ? 'grid' : failed() ? 'retry' : 'rail');
  };
  onMount(() => { void start(); });
  /** Try again: re-reads the categories when there are none, else the current category. */
  const retry = () => {
    focusArea('rail');
    void (cats().length === 0 ? start() : reset()).then(() => {
      if (alive && area() === 'rail' && total() > 0 && noOverlay()) focusArea('grid');
    });
  };
  onCleanup(() => {
    alive = false;
    gen++;
    inflight.clear();
    pickCat.cancel();
  });

  const x = (i: number) => PAD + (i % GRID_COLS) * (CELL_W + CELL_GAP);
  const y = (i: number) => PAD + (Math.floor(i / GRID_COLS) - topRow()) * ROW_PITCH;

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={() => { router.back(); return true; }} onLeft={() => focusArea('rail')}>
      <GroupList ref={(el) => { railNode = el; }} x={RAIL_X} y={RAIL_Y} width={RAIL_W} height={RAIL_H}
        groups={cats()} selected={railSel()} onSelect={(i) => { setRailSel(i); pickCat.schedule(i); }}
        onRight={railRight}
        onFocusChanged={(f) => { if (f) setArea('rail'); }}
        onRowClick={(i) => { pickCat.cancel(); setRailSel(i); focusArea('rail'); void commitCat(i); }} />
      {/* Stops before the Sort button (long names such as "Movies | 4K | …" ran under it). */}
      <Text x={GRID_X} y={HEAD_Y} width={HEAD_W} maxWidth={HEAD_W} contain="width" maxLines={1}
        fontSize={FONT.heading} color={COLORS.text}>{cat()?.name ?? ''}</Text>
      <Text x={GRID_X} y={HEAD_Y + 44} fontSize={FONT.small} color={COLORS.muted}>{total() === 1 ? '1 title' : `${total()} titles`}</Text>
      <ActionBar ref={(el) => { sortNode = el; }} x={LAYOUT.width - LAYOUT.safeX - 300} y={HEAD_Y - 6}
        actions={[{ id: 'sort', label: `Sort: ${SORT_LABELS[sort()]}`, width: 300 }]} onAction={cycleSort}
        onLeft={() => focusArea('rail')} onDown={() => focusArea('grid')} onFocusChanged={(f) => { if (f) setArea('sort'); }} />
      <View ref={(el) => { gridNode = el; }} x={GRID_X - PAD} y={GRID_Y - PAD} width={GRID_W + PAD * 2} height={LAYOUT.height - (GRID_Y - PAD)} clipping
        onFocusChanged={(f: boolean) => { if (f) { setArea('grid'); settleRail(); } }}
        onUp={() => moveGrid('up')} onDown={() => moveGrid('down')} onLeft={() => moveGrid('left')} onRight={() => moveGrid('right')}
        onChannelUp={() => page(-1)} onChannelDown={() => page(1)} onEnter={open} onMenu={openMenu} onLongOk={openMenu}>
        <For each={indices()}>{(i) => (
          <View x={x(i)} y={y(i)} width={CELL_W} height={ROW_PITCH}>
            <PosterTile x={0} y={0} w={CELL_W} h={CELL_H} tile={tileAt(i)} lit={area() === 'grid' && focus() === i}
              hover={pointerMode() && hover() === i} />
            <Text y={CELL_H + 12} width={CELL_W} maxWidth={CELL_W} contain="width" maxLines={1} fontSize={FONT.small}
              color={focus() === i && area() === 'grid' ? COLORS.text : COLORS.muted}>{tileAt(i)?.title ?? ''}</Text>
            <Text y={CELL_H + 44} width={CELL_W} maxWidth={CELL_W} contain="width" maxLines={1} fontSize={FONT.small}
              color={COLORS.muted}>{tileAt(i)?.year ? String(tileAt(i)?.year) : ''}</Text>
          </View>
        )}</For>
      </View>
      <Show when={failed()}>
        <Text x={GRID_X} y={GRID_Y} fontSize={FONT.body} color={COLORS.muted}>{copy.loadError}</Text>
        <Button ref={(el) => { retryNode = el; onCleanup(() => { if (retryNode === el) retryNode = undefined; }); }} x={GRID_X} y={GRID_Y + 80} label="Try again" onPress={retry}
          onUp={() => focusArea('sort')} />
      </Show>
      <Show when={!failed() && total() === 0 && cats().length > 0}>
        <Text x={GRID_X} y={GRID_Y} fontSize={FONT.body} color={COLORS.muted}>{'Nothing here yet.'}</Text>
      </Show>
      <menu.View />
    </View>
  );
}
