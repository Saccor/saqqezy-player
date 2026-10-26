import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { MovieView, SeriesView, VodCategoryView, VodHome, VodTile } from '@iptv/app-api';
import { VOD_ROW_CONTINUE, VOD_ROW_ITEMS } from '@iptv/app-api';
import { VOD_ALL } from '@iptv/core';
import { api, onEvent } from '../api.ts';
import { Button } from '../components/Button.tsx';
import { DropdownHeader } from '../components/DropdownHeader.tsx';
import { InfoBlock } from '../components/InfoBlock.tsx';
import { INFO_STRIP } from '../components/infoBlockLogic.ts';
import { Sheet } from '../components/Sheet.tsx';
import { fromPickerRow } from '../components/sheetLogic.ts';
import { flagFor } from '../assets/flags/index.ts';
import { TOP_LEVEL, effectiveLevel as foldEffectiveLevel, foldPick, foldView, levelRowId, levelUp, type FoldLevel } from '../components/foldPickerLogic.ts';
import { posterCache } from '../components/posterCache.ts';
import { Row } from '../components/Row.tsx';
import { useRowColumn } from '../components/rowColumn.ts';
import { parkLiveForScreen } from '../playback/parkLiveForScreen.ts';
import { dwellSignal } from '../shell/dwell.ts';
import { BOTTOM_ROW_Y, screenOverlayOpen } from '../shell/logic.ts';
import { focusRailCollapsed, Rail } from '../shell/Rail.tsx';
import { goRail } from '../shell/railNav.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, RADIUS, STRONG, TYPE } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { initState, settings } from '../state/appState.ts';
import type { PickerRow } from './homeMenuLogic.ts';
import {
  HOME_POLL_MS, catsReloadNeeded, cellAt, createTicket, homePollNeeded, locateFocus, mergeRows, wheelKey, moveBrowse, rowSort, rowsToLoad, skeletonRows, skeletonShown, toRowModels, warmRows,
  type BrowseFocus, type FocusMemory, type RowModel,
} from '../vod/browseLogic.ts';
import { greenOpensGrid, type BrowseArea } from '../vod/browseNavLogic.ts';
import { Backdrop } from '../vod/Backdrop.tsx';
import { catalogueCategories } from '../vod/categoryPicker.ts';
import { heroArt } from '../vod/fadeLogic.ts';
import { lruGet } from '../vod/memoryLogic.ts';
import { createVodLauncher } from '../vod/launch.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { seriesMetaLine } from '../vod/heroLogic.ts';
import { regularSeasonCount } from '../vod/seriesDetailLogic.ts';
import { metaLine, POSTER_H } from '../vod/posterLogic.ts';
import { joinMeta, tileStatus } from '../vod/stripLogic.ts';
import { KIND_COPY, grouped, vodStatusLine } from '../vod/kindCopy.ts';
import { tabOfKind, type VodKind } from '../vod/tabLogic.ts';

/**
 * Layout (1080p design space, UI revamp §2.2), like Start's: the info strip at the top for the focused title, the
 * "All categories ▾" header at the top right, and the poster rows from y 262 at x 160. The focused row sits on top;
 * the next shows in full and a third peeks in (`rowSlots`; the column slides a row at a time, `useRowColumn`).
 */
const ROW_X = LAYOUT.contentX;
const ROW_Y = 262;
const LABEL_H = 42;
const ROW_GAP = 36;
/** A row below the focused one is drawn while at least its title and a strip of it fit on screen. */
const ROW_PEEK = LABEL_H + 20;
/** The rows' clip edge: a row sliding out upwards disappears here, just above the focused row's title. */
const CLIP_Y = ROW_Y - 8;
const ROW_H = LABEL_H + POSTER_H;
/** A row's title line: a long category name (fed by the source's own names) ends inside the safe area. */
const ROW_TITLE_W = LAYOUT.width - LAYOUT.safeX - ROW_X;
const BG = COLORS.background;
/** Per source and kind focus memories kept (least recently used go). */
const MEMORY_MAX = 20;
/** Skeleton rows (first load): where the rows go, ending a gap above the pointer-mode bottom row. */
const SKELETONS = skeletonRows({ x: ROW_X, top: ROW_Y, bottom: BOTTOM_ROW_Y - LAYOUT.gap }, 3, 8);
const CATEGORIES_ID = 'browse-categories';

type Area = BrowseArea;

/**
 * The focus by identity (row id, tile id) and the last column per row id; and the last home, rows and categories
 * shown, so a later visit draws them at once.
 */
interface BrowseMemory { focus: FocusMemory; cols: Map<string, number>; home?: VodHome; rows?: RowModel[]; cats?: VodCategoryView[] }
/** Kept across visits (per source and kind) so Back from the detail or the grid returns to the same poster. */
const memories = new Map<string, BrowseMemory>();
const memoryFor = (key: string): BrowseMemory =>
  lruGet(memories, key, () => ({ focus: { row: 0, col: 0 }, cols: new Map() }), MEMORY_MAX);

/**
 * Movies or Series browse (`params.kind`): the rail, an info strip and backdrop for the focused title, the "All
 * categories ▾" header (its picker opens the grid on a category; Green opens it on All) and poster rows (Continue
 * watching, Favourites, Recently added, categories).
 */
export function VodBrowseScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { kind?: VodKind; focus?: 'rail' | 'content' };
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
  const [area, setArea] = createSignal<Area>(startOnRail ? 'rail' : 'rows');
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
  let railNode: ElementNode | undefined;
  let headerNode: ElementNode | undefined;
  let rowsNode: ElementNode | undefined;
  let errorNode: ElementNode | undefined;
  let wheelNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let alive = true;
  const loading = new Set<string>();
  /** Bumped by every load and source change; results from an older generation are dropped. */
  let gen = 0;
  /** What the user chose; `area` may sit on a fallback (the rail while there are no rows). */
  let preferredArea: Area = startOnRail ? 'rail' : 'rows';
  let restoring = false;
  /**
   * The area a fallback `focusArea` put focus on (the header while there were no rows yet). Focus events can arrive
   * after `restoring` is over, so the event for that move must not turn the fallback into the user's choice.
   */
  let fallbackArea: Area | undefined;
  const choose = (a: Area) => {
    setArea(a);
    if (fallbackArea === a) { fallbackArea = undefined; return; }
    if (!restoring) preferredArea = a;
  };
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

  /** 'rows' falls back to the Try again button (error), then the header, then the rail; 'header' to the rows. */
  const focusArea = (a: Area) => {
    if (!restoring) preferredArea = a;
    fallbackArea = undefined;
    const asked = a;
    if (a === 'header' && !hasHeader()) a = 'rows';
    if (a === 'rows' && rows().length === 0) {
      if (home()?.status === 'error' && errorNode) {
        setArea('rows');
        errorNode.setFocus();
        return true;
      }
      a = hasHeader() ? 'header' : 'rail';
    }
    if (a !== asked) fallbackArea = a;
    setArea(a);
    // A fallback or restored rail stays collapsed, so the screen stays in view.
    if (a === 'rail' && (asked !== 'rail' || restoring)) focusRailCollapsed(railNode);
    else (a === 'rail' ? railNode : a === 'header' ? headerNode : rowsNode)?.setFocus();
    return true;
  };

  // ---- data ----

  /** After a load: put focus back on what the user chose, only when this load may have unmounted the focused view. */
  const restoreFocus = (before: { status: string | undefined; hasRows: boolean; hasHeader: boolean }) => {
    queueMicrotask(() => {
      if (!alive || screenOverlayOpen() || menu.isOpen()) return;
      const changed = before.status !== status() || before.hasRows !== (rows().length > 0) || before.hasHeader !== hasHeader();
      if (!changed) return;
      restoring = true;
      try { focusArea(preferredArea); } finally { restoring = false; }
    });
  };

  // Its own ticket: a home-only poll must never drop a category request in flight.
  const catTickets = createTicket();
  const loadCats = async () => {
    const t = catTickets.next();
    let cs: VodCategoryView[];
    try {
      cs = await api.getVodCategories(kind);
    } catch {
      return; // The header keeps what it had.
    }
    if (!alive || !catTickets.isCurrent(t)) return;
    const before = { status: status(), hasRows: rows().length > 0, hasHeader: hasHeader() };
    setCats(cs);
    restoreFocus(before);
  };

  /** `withCats` false re-reads only the home (the stuck-loading poll). */
  const load = async (withCats = true) => {
    const g = ++gen;
    if (withCats) void loadCats();
    const before = { status: status(), hasRows: rows().length > 0, hasHeader: hasHeader() };
    let h: VodHome | undefined;
    try {
      h = await api.getVodHome(kind);
    } catch (err) {
      if (!alive || g !== gen) return;
      console.warn('VOD load failed', err instanceof Error ? err.name : 'Error');
      batch(() => {
        setHome({ status: 'error', rows: [], truncated: false, error: { name: 'Error', message: copy.loadError } });
        setRows([]);
      });
      restoreFocus(before);
      return;
    }
    if (!alive || g !== gen) return;
    const models = mergeRows(rows(), toRowModels(h));
    // Rows above the focus come and go (Continue watching, Favourites): find the remembered row and poster again.
    batch(() => {
      setHome(h);
      setRows(models);
      setFocus(locateFocus(models, memory.focus));
    });
    if (catsReloadNeeded(before.status, h.status, withCats)) void loadCats();
    remember();
    syncHero();
    void loadNear();
    restoreFocus(before);
  };

  const loadNear = async () => {
    const g = gen;
    const rs = rows();
    // The rows on screen: the focused one, the next in full and a third peeking in.
    for (const i of rowsToLoad(rs, focus().row, 2)) {
      const r = rs[i]!;
      const key = `${g}:${r.id}`;
      if (loading.has(key)) continue;
      loading.add(key);
      try {
        const page = await api.getVodSlice(kind, r.id, rowSort(rs), 0, VOD_ROW_ITEMS);
        if (!alive) return;
        if (g !== gen) { void loadNear(); return; }
        setRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, items: page.rows, total: page.total, loaded: true, stale: false } : x)));
        if (r.id === memory.focus.rowId) {
          // The focused row's items arrived: put focus back on the remembered poster.
          setFocus(locateFocus(rows(), memory.focus));
          remember();
        }
      } catch {
        // Stays a loading cell; a later focus move tries again.
      } finally {
        loading.delete(key);
      }
    }
  };

  // The strip's detail (plot, runtime or seasons, backdrop) for the dwelled title; the tile's own fields show at once.
  /** A title whose detail could not be read: its art is settled as none (it is no longer pending). */
  const [heroMissId, setHeroMissId] = createSignal<string | undefined>(undefined);
  const loadHero = (id: string) => {
    const view: Promise<MovieView | SeriesView | undefined> = kind === 'series' ? api.getSeries(id) : api.getMovie(id);
    const missed = () => { if (alive && stripTile()?.id === id) setHeroMissId(id); };
    void view.then((v) => {
      if (!alive || stripTile()?.id !== id) return;
      setHero(v);
      if (!v) missed();
    }).catch(missed);
  };
  /** Drops a detail that belongs to another title and loads the dwelled tile's (the dwell is the debounce). */
  const syncHero = () => {
    const t = stripTile();
    if (hero()?.tile.id !== t?.id) setHero(undefined);
    if (t && hero()?.tile.id !== t.id) loadHero(t.id);
  };
  createEffect(on(stripTile, () => syncHero()));
  const onFocusMoved = () => {
    remember();
    void loadNear();
  };

  // ---- actions ----

  /** Back from the rows or the header goes to the rail; Back on the rail returns to Live TV. */
  const back = () => {
    if (area() !== 'rail') return focusArea('rail');
    router.back({ fromVod: true });
    return true;
  };
  const openCell = () => {
    const c = focusedCell();
    const r = rows()[focus().row];
    if (!c || !r) return true;
    if (c.kind === 'tile') router.push(copy.detailRoute, { id: c.tile.id, tile: c.tile });
    else if (c.kind === 'viewAll') router.push('vodGrid', { kind, categoryId: r.id });
    return true;
  };
  /** The grid on All (Green). */
  const openGrid = (categoryId: string) => {
    if (screenOverlayOpen() || menu.isOpen()) return true;
    router.push('vodGrid', { kind, categoryId });
    return true;
  };
  const launcher = createVodLauncher({
    alive: () => alive,
    overlayOpen: screenOverlayOpen,
    getPlayable: (id, seriesId) => api.getVodPlayable(id, seriesId),
    push: (playable, fromStart) => router.push('vodPlay', { playable, fromStart }),
    toast: showToast,
  });
  /** The focused series' view once loaded (its primary episode and seasons). */
  const heroSeries = (): SeriesView | undefined => {
    const h = hero();
    return kind === 'series' && h && h.tile.id === stripTile()?.id ? (h as SeriesView) : undefined;
  };
  // Back to the area the user chose: `area` may sit on a fallback (the rail while there were no rows).
  const menu = createPosterMenu({
    refocus: () => focusArea(preferredArea),
    onChanged: () => void load(),
    play: {
      launcher,
      // A series plays its primary episode: the strip's loaded view when it is that title's, else loaded on demand.
      seriesView: (id) => (kind === 'series' && hero()?.tile.id === id ? (hero() as SeriesView) : undefined),
      onSeriesView: (v) => { if (alive && focusedTile()?.id === v.tile.id) setHero(v); },
      still: (id) => focusedTile()?.id === id,
    },
  });
  const openMenu = () => {
    const t = focusedTile();
    if (t) menu.open(t, rows()[focus().row]?.id === VOD_ROW_CONTINUE);
    return true;
  };

  // ---- category picker: other countries fold into one row (spec 2026-10-22-your-countries-flags) ----
  const [picking, setPicking] = createSignal(false);
  const [pickerLevel, setPickerLevel] = createSignal<FoldLevel>(TOP_LEVEL);
  const [pickerFocusId, setPickerFocusId] = createSignal<string | undefined>(undefined);
  let removePicker: (() => void) | undefined;
  const effectiveLevel = (): FoldLevel => foldEffectiveLevel(pickerLevel(), categories());
  // Built only while the picker is open: a library can have 1,000+ categories.
  const pickerView = createMemo(() => {
    if (!picking()) return undefined;
    const r = settings()?.regions;
    return foldView(categories(), effectiveLevel(), {
      title: copy.categoriesTitle, picked: r !== undefined && r.mode !== 'off' && r.codes.length > 0, focusId: pickerFocusId(),
      label: (c) => `${c.name} · ${grouped(c.count)}`, flagOf: flagFor,
      onlyCount: r?.mode === 'only' ? r.codes.length : 0,
    });
  });
  const openCategories = () => {
    if (picking() || !hasHeader() || screenOverlayOpen() || menu.isOpen()) return;
    setPickerLevel(TOP_LEVEL);
    setPickerFocusId(undefined);
    setPicking(true);
    removePicker = router.pushOverlay(CATEGORIES_ID, closeCategories);
    queueMicrotask(() => { if (alive) pickerNode?.setFocus(); });
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
    queueMicrotask(() => { if (alive) focusArea('header'); });
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

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    if (key === 'left' && focus().col === 0) return focusArea('rail');
    const r = moveBrowse(rows(), focus(), key, memory.cols);
    // Up from the top row: the header (when there is one).
    if ('edge' in r) return hasHeader() ? focusArea('header') : true;
    const cur = focus();
    if (r.focus.row === cur.row && r.focus.col === cur.col) {
      if (focusedCell()?.kind === 'loading') void loadNear();
      return true;
    }
    setFocus(r.focus);
    onFocusMoved();
    return true;
  };

  /** The wheel walks the rows (pointer mode shows only whole rows above the shell's Back button); never off them. */
  const onWheel = (dy: number, dx: number) => {
    const key = wheelKey(dy, dx);
    if (!key || (key === 'up' && focus().row === 0) || (key === 'left' && focus().col === 0)) return true;
    if (area() !== 'rows') focusArea('rows');
    move(key);
    return true;
  };
  // It ends above the shell's Back row, which must keep its clicks. Registered before the rows' own targets, so a poster row (which passes the wheel on) wins where they overlap.
  usePointerTarget({ node: () => wheelNode, enabled: () => status() === 'ready' && rows().length > 0, onWheel });

  // ---- lifecycle ----

  onMount(() => {
    // The live stream stops here (a full screen); a live channel that plays is remembered so Home resumes it on the way back.
    parkLiveForScreen('stop');
    const sameSource = (e: unknown) => {
      const ev = e as { sourceId?: string; kind?: string };
      return ev.sourceId === sourceId() && ev.kind === kind;
    };
    const offs = [
      onEvent('vodRefreshed', (e) => { if (sameSource(e)) void load(); }),
      onEvent('vodRefreshFailed', (e) => { if (sameSource(e)) void load(); }),
      onEvent('vodLoading', (e) => { if (sameSource(e) && rows().length === 0) void load(); }),
      // A first load got further (the worker throttles these): show the titles so far.
      onEvent('vodProgress', (e) => { if (sameSource(e)) void load(); }),
      // Another source became active (a phone companion, Settings): drop everything and re-read.
      onEvent('sourcesChanged', (e) => {
        const ev = e as { type: 'sourcesChanged'; activeSourceId?: string };
        if (ev.activeSourceId === sourceId()) { void load(); return; }
        gen++;
        loading.clear();
        launcher.cancel();
        setSourceId(ev.activeSourceId);
        memory = memoryFor(memKey());
        batch(() => {
          setRows([]);
          setCats([]);
          setHome(undefined);
          setHero(undefined);
          setFocus({ row: memory.focus.row, col: memory.focus.col });
        });
        restoring = true;
        try { focusArea('rail'); } finally { restoring = false; }
        void load();
      }),
    ];
    onCleanup(() => { for (const off of offs) off(); });
    void load();
    // The rows take the focus once they arrive (`restoreFocus`); a rail choice that opened this screen keeps the rail.
    // A warm start already has its rows, so nothing "arrives": focus them now.
    if (startOnRail) focusRailCollapsed(railNode);
    else if (warmStart) {
      restoring = true;
      try { focusArea(preferredArea); } finally { restoring = false; }
    }
  });
  onCleanup(() => { alive = false; removePicker?.(); });

  // ---- view ----

  const status = () => home()?.status;
  // A first load that never reports back (a lost `vodRefreshed`) must not strand the screen on "Loading…".
  // Driven by a memo so a home update that keeps the status does not restart the interval; one request at a time.
  const homeStatus = createMemo(() => home()?.status);
  createEffect(() => {
    if (!homePollNeeded(homeStatus())) return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void load(false).finally(() => { inFlight = false; });
    }, HOME_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });
  const message = () => {
    const s = status();
    if (s === undefined || s === 'loading') return copy.loading;
    if (s === 'empty') return copy.empty;
    if (s === 'error') return home()?.error?.message ?? copy.loadError;
    return '';
  };
  const statusLine = () => vodStatusLine(kind, home());
  /** The detail only shows while it belongs to the strip's title. */
  const heroDetail = () => (hero()?.tile.id === stripTile()?.id ? hero()?.detail : undefined);
  const art = () => heroDetail()?.backdrop ?? undefined;
  const backdropUrl = () => {
    const u = art();
    return u && posterCache.usable(u) ? u : undefined;
  };
  /** The strip title's detail is still on its way (neither loaded nor known missing). */
  const heroPending = () => {
    const t = stripTile();
    return t !== undefined && hero()?.tile.id !== t.id && heroMissId() !== t.id;
  };
  /** The art drawn: the last one stays while the next title is pending, so the new art cross-fades over it. */
  const shownArt = createMemo<string | undefined>((prev) => heroArt(prev, heroPending(), backdropUrl()));
  /** "2022 · 1 h 54 min · Drama · 12 · ★ 7.6"; a series shows "N seasons" in place of the runtime once its view is loaded. */
  const heroMeta = () => {
    const d = heroDetail();
    const t = stripTile();
    if (kind !== 'series') {
      const runtimeMin = (d as MovieView['detail'] | undefined)?.runtimeMin;
      return metaLine({ year: t?.year, runtimeMin, genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating });
    }
    return seriesMetaLine({ year: t?.year, seasons: regularSeasonCount(heroSeries()?.seasons ?? []), genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating });
  };
  const stripMeta = () => joinMeta(heroMeta(), stripTile() ? tileStatus(stripTile()!) : '');
  /**
   * The focused row on top, then the rows after it, down to a peek of the next one's title; in pointer mode only
   * rows that fit above the shell's bottom button row.
   */
  const column = useRowColumn({
    heights: () => rows().map(() => ROW_H),
    focusRow: () => focus().row,
    frame: () => ({ top: ROW_Y, gap: ROW_GAP, bottom: pointerMode() ? BOTTOM_ROW_Y : LAYOUT.height, peek: ROW_PEEK }),
    mode: () => (pointerMode() ? 'whole' : 'peek'),
    clipTop: CLIP_Y,
  });
  /** A pointer press on a poster: the column memory of the row left and of the row pressed are kept, as with the keys. */
  const pointTo = (row: number, col: number) => {
    const from = rows()[focus().row];
    if (from) memory.cols.set(from.id, focus().col);
    const to = rows()[row];
    if (to) memory.cols.set(to.id, col);
    setFocus({ row, col });
    onFocusMoved();
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={BG} onBack={back}
      onGreen={() => (greenOpensGrid(status()) ? openGrid(VOD_ALL) : true)}
      onYellow={() => { router.push('search'); return true; }} onBlue={() => { router.push('settings'); return true; }}>
      <Backdrop url={shownArt()} area="strip" />
      <Rail ref={(el) => { railNode = el; }} active={tabOfKind(kind)} onSelect={(t) => goRail(tabOfKind(kind), t, () => router.back({ fromVod: true }))}
        onRight={() => focusArea(rows().length > 0 ? 'rows' : 'header')} onFocusChanged={(f) => { if (f) choose('rail'); }} />
      {/* The catalogue status while there is one, else the plot. */}
      <InfoBlock x={INFO_STRIP.x} y={INFO_STRIP.y} width={INFO_STRIP.w} title={stripTile()?.title ?? ''} meta={stripMeta() || undefined}
        description={statusLine() || heroDetail()?.plot} fadeOnTitle />
      <Show when={hasHeader()}>
        {/* Above the backdrop's scrims (zIndex 1). */}
        <View zIndex={4}>
          <DropdownHeader ref={(el) => { headerNode = el; }} x={LAYOUT.width - LAYOUT.safeX} y={LAYOUT.safeY} align="right"
            size={TYPE.body} label="All categories" onPress={openCategories}
            onDown={() => focusArea('rows')} onLeft={() => focusArea('rail')} onFocusChanged={(f) => { if (f) choose('header'); }} />
        </View>
      </Show>

      <Show when={status() === 'ready'} fallback={
        <View zIndex={2} onLeft={() => focusArea('rail')}>
          <Text x={ROW_X} y={INFO_STRIP.y} width={LAYOUT.contentW} maxWidth={LAYOUT.contentW} contain="width" maxLines={2}
            fontSize={TYPE.title} color={COLORS.text}>{message()}</Text>
          {/* First load: skeleton rows (a label bar and poster placeholders) stand in for the rows (spec §3.7). */}
          <Show when={skeletonShown(status(), rows().length)}>
            <For each={SKELETONS}>{(r) => (
              <View>
                <View x={r.label.x} y={r.label.y} width={r.label.w} height={r.label.h} borderRadius={r.label.h / 2} color={COLORS.surface} />
                <For each={r.posters}>{(p) => <View x={p.x} y={p.y} width={p.w} height={p.h} borderRadius={RADIUS.card} color={COLORS.surface} />}</For>
              </View>
            )}</For>
          </Show>
          <Show when={status() === 'error'}>
            <Button ref={(el) => { errorNode = el; }} x={ROW_X} y={ROW_Y} label="Try again"
              onPress={() => void api.refreshVod(kind).catch(() => undefined).then(() => load())}
              onUp={() => focusArea(hasHeader() ? 'header' : 'rail')} />
          </Show>
        </View>
      }>
        {/* Rows: the focused row sits on top, the rows after it below. One focusable node owns the keys. */}
        <View ref={(el) => { rowsNode = el; }} y={0} width={LAYOUT.width} height={LAYOUT.height} zIndex={3}
          onFocusChanged={(f: boolean) => { if (f) choose('rows'); }}
          onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')}
          onEnter={openCell} onMenu={openMenu} onLongOk={openMenu}>
          <View ref={(el) => { wheelNode = el; }} y={ROW_Y} width={LAYOUT.width} height={BOTTOM_ROW_Y - ROW_Y} />
          {/* The rows sit at fixed y's in one column that slides (a row sliding out is clipped under the strip). */}
          <View y={CLIP_Y} width={LAYOUT.width} height={LAYOUT.height - CLIP_Y} clipping>
            <View ref={column.ref} width={LAYOUT.width} height={column.height()}>
              <For each={column.rows()}>{(i) => {
                const r = () => rows()[i]!;
                return (
                  <View y={column.rowY(i)} width={LAYOUT.width} height={column.rowH(i)}>
                    <Text x={ROW_X} y={0} width={ROW_TITLE_W} maxWidth={ROW_TITLE_W} contain="width" maxLines={1} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{r().title}</Text>
                    <Row x={ROW_X} y={LABEL_H} width={LAYOUT.width - ROW_X} content={{ variant: 'poster', row: r() }}
                      focusCol={i === focus().row ? focus().col : undefined} lit={area() === 'rows' && i === focus().row}
                      onCellClick={(c) => { pointTo(i, c); focusArea('rows'); openCell(); }}
                      onCellOptions={(c) => { pointTo(i, c); openMenu(); }} onWheel={onWheel} />
                  </View>
                );
              }}</For>
            </View>
          </View>
        </View>
      </Show>
      {/* Above the rail (zIndex 50), so the menu's scrim dims it too. */}
      <View zIndex={60}><menu.View /></View>
      <Show when={pickerView()}>
        {(view) => {
          const rows = createMemo(() => view().rows.map(fromPickerRow));
          return (
            <Sheet ref={(el) => { pickerNode = el; }} title={view().title} rows={rows()} backLayerId={CATEGORIES_ID}
              initial={view().initial} resetKey={view().key} onSelect={(_, i) => { const r = view().rows[i]; if (r) pickCategory(r); }} />
          );
        }}
      </Show>
    </View>
  );
}
