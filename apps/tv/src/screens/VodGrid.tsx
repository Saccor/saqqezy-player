import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { VodCategoryView, VodTile } from '@iptv/app-api';
import { VOD_ROW_CONTINUE, VOD_ROW_RECENT } from '@iptv/app-api';
import type { VodSort } from '@iptv/core';
import { api } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { GroupList } from '../components/GroupList.tsx';
import { PosterTile } from '../components/PosterTile.tsx';
import { renderRange, scrollTopFor } from '../components/virtualWindow.ts';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { createDebounce } from '../playback/debounce.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import {
  GRID_COLS, GRID_PAGE, GRID_VIEW_ROWS, SORT_LABELS, gridCellAt, gridMove, gridPage, loadSort, nextSort, pagesFor, saveSort, sortsFor,
  type GridGeometry,
} from '../vod/gridLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { TAB_SWITCH_MS } from '../vod/tabLogic.ts';

const RAIL_X = LAYOUT.safeX;
const RAIL_Y = 158;
const RAIL_W = 360;
const RAIL_H = LAYOUT.height - RAIL_Y - LAYOUT.safeY;
const GRID_X = RAIL_X + RAIL_W + 48;
const GRID_W = LAYOUT.width - LAYOUT.safeX - GRID_X;
const CELL_GAP = 24;
const CELL_W = Math.floor((GRID_W - CELL_GAP * (GRID_COLS - 1)) / GRID_COLS);
const CELL_H = Math.round(CELL_W * 1.5);
const ROW_PITCH = CELL_H + 88;
const GRID_Y = 246;
const HEAD_Y = 158;
/**
 * The grid node covers the grid only (not the whole screen), so its pointer target never overlaps the rail or the sort
 * button. It reaches PAD past the tiles on the left and top so a focused tile's scale and ring are not clipped.
 */
const PAD = 16;
const GEO: GridGeometry = { pad: PAD, cellW: CELL_W, gap: CELL_GAP, rowPitch: ROW_PITCH };

type Area = 'rail' | 'sort' | 'grid';

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
  const params = props.entry.params as { kind?: 'movie'; categoryId?: string };
  const kind = params.kind ?? 'movie';

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
  let alive = true;
  let lastTopRow = 0;
  /** Bumped per category/sort change: answers for an older one are dropped. */
  let gen = 0;
  /** Pages being fetched, keyed `gen:page`, so a dropped (stale or failed) page is asked for again later. */
  const inflight = new Set<string>();

  const cat = () => cats()[catIndex()];
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
      console.warn('Movies page failed', errName(err));
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
    setArea(a);
    (a === 'rail' ? railNode : a === 'sort' ? sortNode : gridNode)?.setFocus();
    return true;
  };

  /** Reloads the first page of the current category and sort. */
  const reset = async () => {
    const myGen = ++gen;
    inflight.clear();
    lastTopRow = 0;
    batch(() => {
      setFocus(0);
      setPages(new Map());
      setTotal(0);
      setFailed(false);
    });
    const id = cat()?.id;
    if (!id) return;
    try {
      const first = await api.getVodSlice(kind, id, sort(), 0, GRID_PAGE);
      if (!alive || myGen !== gen) return;
      batch(() => {
        setTotal(first.total);
        setPages(new Map([[0, first.rows]]));
      });
    } catch (err) {
      if (!alive || myGen !== gen) return;
      console.warn('Movies load failed', errName(err));
      setFailed(true);
    }
    // The focused grid may have just become empty (a removed title, a failed load): never leave focus on nothing.
    if (alive && myGen === gen && area() === 'grid' && total() === 0 && noOverlay()) focusArea('rail');
  };

  const commitCat = (i: number) => {
    if (i === catIndex()) return Promise.resolve();
    setCatIndex(i);
    return reset();
  };
  const pickCat = createDebounce<number>(TAB_SWITCH_MS, (i) => { void commitCat(i); });

  /** Right from the rail: a category chosen a moment ago is applied first, so the grid never shows the old one. */
  const railRight = () => {
    if (pickCat.pending()) {
      pickCat.cancel();
      void commitCat(railSel()).then(() => { if (alive && area() === 'rail' && noOverlay()) focusArea(total() > 0 ? 'grid' : 'sort'); });
      return true;
    }
    return focusArea(total() > 0 ? 'grid' : 'sort');
  };

  const moveGrid = (key: 'up' | 'down' | 'left' | 'right') => {
    const r = gridMove(focus(), key, total());
    if (r === 'rail') return focusArea('rail');
    if (r === 'header') return focusArea('sort');
    setFocus(r);
    ensurePages();
    return true;
  };
  const page = (dir: 1 | -1) => {
    setFocus(gridPage(focus(), dir, total()));
    ensurePages();
    return true;
  };
  const open = () => {
    const t = tileAt(focus());
    if (t) router.push('movieDetail', { id: t.id, tile: t });
    return true;
  };
  const menu = createPosterMenu({ refocus: () => focusArea(area()), onChanged: () => void reset() });
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
      const r = gridMove(focus(), dy > 0 ? 'down' : 'up', total());
      if (typeof r === 'number' && r !== focus()) {
        setFocus(r);
        ensurePages();
      }
      return true;
    },
  });

  onMount(() => {
    void (async () => {
      let cs: VodCategoryView[];
      try {
        cs = await api.getVodCategories(kind);
      } catch (err) {
        if (!alive) return;
        console.warn('Movie categories failed', errName(err));
        setFailed(true);
        focusArea('rail');
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
      if (alive && noOverlay()) focusArea(total() > 0 ? 'grid' : 'rail');
    })();
  });
  onCleanup(() => {
    alive = false;
    gen++;
    inflight.clear();
    pickCat.cancel();
  });

  const x = (i: number) => PAD + (i % GRID_COLS) * (CELL_W + CELL_GAP);
  const y = (i: number) => PAD + (Math.floor(i / GRID_COLS) - topRow()) * ROW_PITCH;

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={() => { router.back(); return true; }}>
      <GroupList ref={(el) => { railNode = el; }} x={RAIL_X} y={RAIL_Y} width={RAIL_W} height={RAIL_H}
        groups={cats()} selected={railSel()} onSelect={(i) => { setRailSel(i); pickCat.schedule(i); }}
        onRight={railRight}
        onRowClick={(i) => { pickCat.cancel(); setRailSel(i); void commitCat(i); }} />
      <Text x={GRID_X} y={HEAD_Y} fontSize={FONT.heading} color={COLORS.text}>{cat()?.name ?? ''}</Text>
      <Text x={GRID_X} y={HEAD_Y + 44} fontSize={FONT.small} color={COLORS.muted}>{total() === 1 ? '1 title' : `${total()} titles`}</Text>
      <ActionBar ref={(el) => { sortNode = el; }} x={LAYOUT.width - LAYOUT.safeX - 300} y={HEAD_Y - 6}
        actions={[{ id: 'sort', label: `Sort: ${SORT_LABELS[sort()]}`, width: 300 }]} onAction={cycleSort}
        onLeft={() => focusArea('rail')} onDown={() => focusArea('grid')} onFocusChanged={(f) => { if (f) setArea('sort'); }} />
      <View ref={(el) => { gridNode = el; }} x={GRID_X - PAD} y={GRID_Y - PAD} width={GRID_W + PAD * 2} height={LAYOUT.height - (GRID_Y - PAD)} clipping
        onFocusChanged={(f: boolean) => { if (f) setArea('grid'); }}
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
        <Text x={GRID_X} y={GRID_Y} fontSize={FONT.body} color={COLORS.muted}>{'Movies could not be loaded.'}</Text>
      </Show>
      <Show when={!failed() && total() === 0 && cats().length > 0}>
        <Text x={GRID_X} y={GRID_Y} fontSize={FONT.body} color={COLORS.muted}>{'Nothing here yet.'}</Text>
      </Show>
      <menu.View />
    </View>
  );
}
