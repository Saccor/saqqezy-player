import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { MovieView, SeriesView, VodHome, VodTile } from '@iptv/app-api';
import { VOD_ROW_CONTINUE, VOD_ROW_ITEMS } from '@iptv/app-api';
import { VOD_ALL } from '@iptv/core';
import { api, onEvent } from '../api.ts';
import { FAV_COPY } from '../copy.ts';
import { ActionBar, type Action } from '../components/ActionBar.tsx';
import { Button } from '../components/Button.tsx';
import { CHIP_H, ChipRow } from '../components/ChipRow.tsx';
import { POSTER_H, posterCache } from '../components/PosterTile.tsx';
import { PosterRow } from '../components/PosterRow.tsx';
import { TAB_BAR_Y, TabBar } from '../components/TabBar.tsx';
import { createDebounce } from '../playback/debounce.ts';
import { parkLiveForScreen } from '../playback/parkLiveForScreen.ts';
import { BOTTOM_ROW_Y, screenOverlayOpen } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { BACKGROUND_RGB, COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { initState } from '../state/appState.ts';
import {
  cellAt, locateFocus, mergeRows, wheelKey, moveBrowse, rowSort, rowsToLoad, skeletonRows, skeletonShown, toRowModels,
  type BrowseFocus, type FocusMemory, type RowModel,
} from '../vod/browseLogic.ts';
import {
  areaAbove, areaBelow, browseChips, browseSlots, chipMove, effectiveLine, greenOpensGrid, hintAfterHeading, locateChip, type BrowseArea, type BrowseChip, type BrowseLine,
} from '../vod/browseNavLogic.ts';
import { CrossFadeArt } from '../vod/CrossFadeArt.tsx';
import { heroArt } from '../vod/fadeLogic.ts';
import { createFavToggle } from '../vod/favToggle.ts';
import { lruGet } from '../vod/memoryLogic.ts';
import { createVodLauncher, playSeriesPrimary } from '../vod/launch.ts';
import { minutesLeft, titleLengthMs } from '../vod/vodPlayerLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { scrimTexture } from '../vod/scrim.ts';
import { seriesMetaLine } from '../vod/heroLogic.ts';
import { primaryLabel, regularSeasonCount } from '../vod/seriesDetailLogic.ts';
import { metaLine } from '../vod/posterLogic.ts';
import { KIND_COPY, vodStatusLine } from '../vod/kindCopy.ts';
import { TAB_H, tabNavigation, tabOfKind, tabParams, type TabId, type VodKind } from '../vod/tabLogic.ts';

/**
 * Layout (1080p design space), like Start's: a compact hero under the tab bar (title, one meta line, one line of plot
 * or status) with the action bar at its right, then the lines from y 290: the Categories chips and the poster rows.
 * The line the page is scrolled to sits on top; two poster rows show in full and a third peeks in (`browseSlots`).
 */
const HERO_X = LAYOUT.safeX;
const HERO_Y = TAB_BAR_Y + TAB_H + 24;
const HERO_META_Y = HERO_Y + 62;
const HERO_LINE_Y = HERO_META_Y + 34;
const ACTION_GAP = 16;
/** The widest action bar (Resume, Details, In favourites): the title and meta end a gap before it. */
const ACTIONS_MAX_W = 320 + 200 + 300 + ACTION_GAP * 2;
const HERO_W = LAYOUT.width - LAYOUT.safeX * 2 - ACTIONS_MAX_W - LAYOUT.gap;
/** The plot or status line runs under the action bar. */
const HERO_LINE_W = LAYOUT.width - LAYOUT.safeX * 2;
const ROW_Y = 290;
const LABEL_H = 44;
const ROW_GAP = 36;
/** A line below the top one is drawn while at least its title and a strip of it fit on screen. */
const ROW_PEEK = LABEL_H + 20;
const ROW_H = LABEL_H + POSTER_H;
const CHIPS_LINE_H = LABEL_H + CHIP_H;
/** A row's title line: a long category name (fed by the source's own names) ends inside the safe area. */
const ROW_TITLE_W = LAYOUT.width - LAYOUT.safeX * 2;
const HERO_SETTLE_MS = 400;
const ART_X = 640;
const ART_W = LAYOUT.width - ART_X;
/** The backdrop ends behind the first line, faded into the background. */
const ART_H = 600;
const BG = COLORS.background;
/** Per source and kind focus memories kept (least recently used go). */
const MEMORY_MAX = 20;
/** Skeleton rows (first load): where the rows go, ending a gap above the pointer-mode bottom row. */
const SKELETONS = skeletonRows({ x: LAYOUT.safeX, top: ROW_Y, bottom: BOTTOM_ROW_Y - LAYOUT.gap });

type Area = BrowseArea;

/**
 * The focus by identity (row id, tile id), the last column per row id, the line the page is on and the chip (by id).
 * A first visit starts on the chips: the way into the whole library is the first thing focused.
 */
interface BrowseMemory { focus: FocusMemory; cols: Map<string, number>; line: BrowseLine; chipId?: string; chip: number }
/** Kept across visits (per source and kind) so Back from the detail or the grid returns to the same poster or chip. */
const memories = new Map<string, BrowseMemory>();
const memoryFor = (key: string): BrowseMemory =>
  lruGet(memories, key, () => ({ focus: { row: 0, col: 0 }, cols: new Map(), line: 'chips', chip: 0 }), MEMORY_MAX);
const actionsWidth = (as: readonly Action[]) => as.reduce((w, a) => w + a.width, 0) + ACTION_GAP * Math.max(0, as.length - 1);

const DETAILS_ACTION = { id: 'details', label: 'Details', width: 200 };
const FAV_ADD_ACTION = { id: 'fav', label: FAV_COPY.add, width: 300 };
const FAV_ON_ACTION = { id: 'fav', label: FAV_COPY.in, width: 300 };

/**
 * Movies or Series browse (`params.kind`): the tab bar, a hero for the focused title, the Categories chips (Ok opens
 * the grid on that category; Green opens it on All) and poster rows (Continue watching, Favourites, Recently added,
 * categories).
 */
export function VodBrowseScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { kind?: VodKind; focus?: 'rail' | 'content' };
  const kind: VodKind = params.kind ?? 'movie';
  const copy = KIND_COPY[kind];
  const startOnTabs = params.focus === 'rail';
  delete params.focus;

  const [home, setHome] = createSignal<VodHome | undefined>(undefined);
  const [rows, setRows] = createSignal<RowModel[]>([]);
  const [sourceId, setSourceId] = createSignal<string | undefined>(initState()?.activeSourceId);
  const memKey = () => `${sourceId() ?? ''}:${kind}`;
  let memory = memoryFor(memKey());
  const [focus, setFocus] = createSignal<BrowseFocus>({ row: memory.focus.row, col: memory.focus.col });
  const [area, setArea] = createSignal<Area>(startOnTabs ? 'tabs' : 'rows');
  const [hero, setHero] = createSignal<MovieView | SeriesView | undefined>(undefined);
  const [chips, setChips] = createSignal<BrowseChip[]>([]);
  const [chip, setChip] = createSignal(memory.chip);
  const [line, setLine] = createSignal<BrowseLine>(memory.line);
  let tabsNode: ElementNode | undefined;
  let heroNode: ElementNode | undefined;
  let chipsNode: ElementNode | undefined;
  let rowsNode: ElementNode | undefined;
  let errorNode: ElementNode | undefined;
  let wheelNode: ElementNode | undefined;
  let alive = true;
  const loading = new Set<string>();
  /** Bumped by every load and source change; results from an older generation are dropped. */
  let gen = 0;
  /** What the user chose; `area` may sit on a fallback (tabs while there are no rows). */
  let preferredArea: Area = startOnTabs ? 'tabs' : 'rows';
  let restoring = false;
  /** A key or pointer move happened: chips that arrive later no longer take the focus. */
  let userMoved = false;
  const choose = (a: Area) => { setArea(a); if (!restoring) preferredArea = a; };
  const hasChips = () => chips().length > 0;
  const setLineTo = (l: BrowseLine) => { setLine(l); memory.line = l; };

  const focusedCell = () => {
    const r = rows()[focus().row];
    return r ? cellAt(r, focus().col) : undefined;
  };
  const focusedTile = (): VodTile | undefined => {
    const c = focusedCell();
    return c?.kind === 'tile' ? c.tile : undefined;
  };
  const focusedRowTitle = () => rows()[focus().row]?.title ?? '';
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

  /** Up/Down context for `areaAbove`/`areaBelow`. */
  const ctx = () => ({ chips: hasChips(), heroTile: !!focusedTile(), rows: rows().length > 0, line: line() });

  /** 'rows' goes to the line the page is on (the chips or the rows); 'chips' scrolls the page to the chips. */
  const focusArea = (a: Area) => {
    if (!restoring) preferredArea = a;
    if (a === 'hero' && !focusedTile()) a = 'rows';
    if (a === 'chips' && !hasChips()) a = 'rows';
    if (a === 'rows' && effectiveLine(line(), hasChips()) === 'chips') a = 'chips';
    if (a === 'chips') setLineTo('chips');
    if (a !== 'tabs' && rows().length === 0) {
      // No rows: the Try again button (error) is the content; otherwise the tab bar.
      if (home()?.status === 'error' && errorNode) {
        setArea('rows');
        errorNode.setFocus();
        return true;
      }
      a = 'tabs';
    }
    setArea(a);
    (a === 'tabs' ? tabsNode : a === 'hero' ? heroNode : a === 'chips' ? chipsNode : rowsNode)?.setFocus();
    return true;
  };
  /** Into the poster rows (from the chips, a pointer press, the wheel): the page scrolls to the focused row. */
  const enterRows = () => {
    setLineTo('rows');
    return focusArea('rows');
  };

  // ---- data ----

  /** After a load: put focus back on what the user chose, only when this load may have unmounted the focused view. */
  const restoreFocus = (before: { status: string | undefined; hasRows: boolean; hasTile: boolean }) => {
    queueMicrotask(() => {
      if (!alive || screenOverlayOpen() || menu.isOpen()) return;
      const changed = before.status !== status() || before.hasRows !== (rows().length > 0) || before.hasTile !== !!focusedTile();
      if (!changed) return;
      restoring = true;
      try { focusArea(preferredArea); } finally { restoring = false; }
    });
  };

  /**
   * The chips come from the grid rail's categories, read apart from the home (they may wait for the catalogue).
   * Chips that appear after the user has moved never take the focus: the page stays on the rows.
   */
  const loadChips = async (g: number) => {
    let cs: BrowseChip[];
    try {
      cs = browseChips(await api.getVodCategories(kind));
    } catch {
      return; // The chips keep what they had.
    }
    if (!alive || g !== gen) return;
    const had = hasChips();
    batch(() => {
      setChips(cs);
      setChip(locateChip(cs, memory.chipId, memory.chip));
    });
    // Before the rows arrive, the load's own focus restore goes to the chips (the page's line).
    if (had || cs.length === 0 || line() !== 'chips' || area() !== 'rows' || rows().length === 0) return;
    if (userMoved) { setLineTo('rows'); return; }
    queueMicrotask(() => {
      if (alive && area() === 'rows' && !screenOverlayOpen() && !menu.isOpen()) focusArea('chips');
    });
  };

  const load = async () => {
    const g = ++gen;
    void loadChips(g);
    const before = { status: status(), hasRows: rows().length > 0, hasTile: !!focusedTile() };
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
      fav.clear();
    });
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
          syncHero();
        }
      } catch {
        // Stays a loading cell; a later focus move tries again.
      } finally {
        loading.delete(key);
      }
    }
  };

  // The hero detail (plot, runtime or seasons, backdrop) after focus rests; the tile's own fields show at once.
  /** A title whose hero detail could not be read: its art is settled as none (it is no longer pending). */
  const [heroMissId, setHeroMissId] = createSignal<string | undefined>(undefined);
  const heroLoad = createDebounce<string>(HERO_SETTLE_MS, (id) => {
    const view: Promise<MovieView | SeriesView | undefined> = kind === 'series' ? api.getSeries(id) : api.getMovie(id);
    const missed = () => { if (alive && focusedTile()?.id === id) setHeroMissId(id); };
    void view.then((v) => {
      if (!alive || focusedTile()?.id !== id) return;
      setHero(v);
      if (!v) missed();
    }).catch(missed);
  });
  /** Drops a hero detail that belongs to another title and schedules the focused tile's. */
  const syncHero = () => {
    const t = focusedTile();
    if (hero()?.tile.id !== t?.id) setHero(undefined);
    if (t && hero()?.tile.id !== t.id) heroLoad.schedule(t.id);
  };
  const onFocusMoved = () => {
    remember();
    void loadNear();
    syncHero();
  };

  // ---- actions ----

  const back = () => {
    router.back({ focusTabs: true });
    return true;
  };
  const goTab = (t: TabId) => {
    const nav = tabNavigation(tabOfKind(kind), t);
    if (nav.action === 'back') back();
    // Movies and Series replace each other: the stack never grows.
    else if (nav.action === 'replace') router.replace(nav.to.screen, tabParams(nav.to));
  };
  const openCell = () => {
    const c = focusedCell();
    const r = rows()[focus().row];
    if (!c || !r) return true;
    if (c.kind === 'tile') router.push(copy.detailRoute, { id: c.tile.id, tile: c.tile });
    else if (c.kind === 'viewAll') router.push('vodGrid', { kind, categoryId: r.id });
    return true;
  };
  /** The grid on a category (Ok on a chip), or on All (Green). */
  const openGrid = (categoryId: string) => {
    if (screenOverlayOpen() || menu.isOpen()) return true;
    router.push('vodGrid', { kind, categoryId });
    return true;
  };
  const openChip = () => {
    const c = chips()[chip()];
    return c ? openGrid(c.id) : true;
  };
  const rememberChip = () => {
    memory.chip = chip();
    memory.chipId = chips()[chip()]?.id;
  };
  const moveChips = (key: 'up' | 'down' | 'left' | 'right') => {
    userMoved = true;
    const r = chipMove(chips().length, chip(), key);
    if ('chip' in r) { setChip(r.chip); rememberChip(); return true; }
    if (r.edge === 'up') return focusArea(areaAbove('chips', ctx()));
    return areaBelow('chips', ctx()) === 'rows' ? enterRows() : true;
  };
  const launcher = createVodLauncher({
    alive: () => alive,
    overlayOpen: screenOverlayOpen,
    getPlayable: (id, seriesId) => api.getVodPlayable(id, seriesId),
    push: (playable, fromStart) => router.push('vodPlay', { playable, fromStart }),
    toast: showToast,
  });
  // Back to the area the user chose: `area` may sit on a fallback (tabs while there were no rows).
  const menu = createPosterMenu({ refocus: () => focusArea(preferredArea), onChanged: () => void load() });
  const openMenu = () => {
    const t = focusedTile();
    if (t) menu.open(t, rows()[focus().row]?.id === VOD_ROW_CONTINUE);
    return true;
  };
  /** The hero's Favourite: the saved state shows at once (for that title only) and is cleared when a reload lands. */
  const fav = createFavToggle({
    alive: () => alive,
    reload: () => load(),
    setFavourite: (id, on) => api.setVodFavourite(id, on),
    toast: showToast,
  });
  const isFav = createMemo(() => fav.apply(focusedTile())?.favourite === true);
  /** The focused series' view once loaded (its primary episode and seasons). */
  const heroSeries = (): SeriesView | undefined => {
    const h = hero();
    return kind === 'series' && h && h.tile.id === focusedTile()?.id ? (h as SeriesView) : undefined;
  };
  /**
   * Movies: "Resume · N min left" when the focused title has progress and its detail is loaded; else "Play".
   * Series: "Continue S2 · E4" / "Play S1 · E1" from the view's primary episode; "Play" until it is loaded.
   */
  const playAction = createMemo(() => {
    if (kind === 'series') {
      const p = heroSeries()?.primary;
      return { id: 'play', label: primaryLabel(p), width: p ? 320 : 200 };
    }
    const t = focusedTile();
    const h = hero()?.tile.id === t?.id ? (hero() as MovieView | undefined) : undefined;
    const total = titleLengthMs(h?.resumeMs ?? 0, t?.progress, h?.detail?.runtimeMin);
    if (!t?.progress || !h || h.resumeMs <= 0 || total <= 0) return { id: 'play', label: 'Play', width: 200 };
    return { id: 'play', label: `Resume · ${minutesLeft(h.resumeMs, total)}`, width: 320 };
  });
  const heroActions = createMemo(() => [playAction(), DETAILS_ACTION, isFav() ? FAV_ON_ACTION : FAV_ADD_ACTION]);
  /** A series Play press waiting for the view to load (a second press meanwhile is ignored). */
  let seriesPlayPending = false;
  const playSeries = async (t: VodTile) => {
    if (seriesPlayPending) return;
    seriesPlayPending = true;
    try {
      await playSeriesPrimary({
        seriesId: t.id,
        view: heroSeries,
        load: async () => {
          const v = await api.getSeries(t.id);
          if (alive && v && focusedTile()?.id === t.id) setHero(v);
          return v;
        },
        still: () => alive && focusedTile()?.id === t.id && !screenOverlayOpen() && !menu.isOpen(),
        launcher,
        // No episodes (or the load failed): the detail opens instead.
        noPrimary: () => router.push(copy.detailRoute, { id: t.id, tile: t }),
      });
    } finally {
      seriesPlayPending = false;
    }
  };
  const onHeroAction = (id: string) => {
    const t = focusedTile();
    if (!t || screenOverlayOpen() || menu.isOpen()) return;
    if (id === 'play') {
      if (kind !== 'series') { void launcher.play(t.id); return; }
      // A series plays its primary episode, loading the view first when the press comes before it.
      void playSeries(t);
    } else if (id === 'details') router.push(copy.detailRoute, { id: t.id, tile: t });
    else if (id === 'fav') { const f = fav.apply(t); if (f) void fav.toggle(f); }
  };

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    userMoved = true;
    const r = moveBrowse(rows(), focus(), key, memory.cols);
    if ('edge' in r) return focusArea(areaAbove('rows', ctx()));
    const cur = focus();
    if (r.focus.row === cur.row && r.focus.col === cur.col) {
      if (focusedCell()?.kind === 'loading') void loadNear();
      return true;
    }
    setFocus(r.focus);
    onFocusMoved();
    return true;
  };

  /**
   * The wheel walks the lines (pointer mode shows only whole lines above the shell's Back button): vertical between
   * the chips and the rows, horizontal along the line. On the chips a wheel up stays put; from the top row it goes to
   * the chips (never to the hero).
   */
  const onWheel = (dy: number, dx: number) => {
    const key = wheelKey(dy, dx);
    if (!key) return true;
    userMoved = true;
    if (effectiveLine(line(), hasChips()) === 'chips') {
      if (area() !== 'chips') focusArea('chips');
      if (key !== 'up') moveChips(key);
      return true;
    }
    if (key === 'up' && focus().row === 0) {
      if (hasChips()) focusArea('chips');
      return true;
    }
    if (area() !== 'rows') enterRows();
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
        userMoved = false;
        batch(() => {
          setRows([]);
          setChips([]);
          setHome(undefined);
          setHero(undefined);
          setFocus({ row: memory.focus.row, col: memory.focus.col });
          setChip(memory.chip);
          setLine(memory.line);
        });
        restoring = true;
        try { focusArea('tabs'); } finally { restoring = false; }
        void load();
      }),
    ];
    onCleanup(() => { for (const off of offs) off(); });
    void load();
    if (startOnTabs) tabsNode?.setFocus();
  });
  onCleanup(() => { alive = false; heroLoad.cancel(); });

  // ---- view ----

  const status = () => home()?.status;
  const message = () => {
    const s = status();
    if (s === undefined || s === 'loading') return copy.loading;
    if (s === 'empty') return copy.empty;
    if (s === 'error') return home()?.error?.message ?? copy.loadError;
    return '';
  };
  const statusLine = () => vodStatusLine(kind, home());
  const heroTile = () => focusedTile();
  /** The detail only shows while it belongs to the focused title. */
  const heroDetail = () => (hero()?.tile.id === heroTile()?.id ? hero()?.detail : undefined);
  const art = () => heroDetail()?.backdrop ?? undefined;
  /** Bumped when a backdrop fails, so the poster fallback shows (the poster cache itself is not reactive). */
  const [artFailures, setArtFailures] = createSignal(0);
  const backdropUrl = () => {
    artFailures();
    const u = art();
    return u && posterCache.usable(u) ? u : undefined;
  };
  /** The focused title's detail is still on its way (neither loaded nor known missing). */
  const heroPending = () => {
    const t = heroTile();
    return t !== undefined && hero()?.tile.id !== t.id && heroMissId() !== t.id;
  };
  /** The art drawn: the last one stays while the next title is pending, so the new art cross-fades over it. */
  const shownArt = createMemo<string | undefined>((prev) => heroArt(prev, heroPending(), backdropUrl()));
  /** "2022 · 1 h 54 min · Drama · 12 · ★ 7.6"; a series shows "N seasons" in place of the runtime once its view is loaded. */
  const heroMeta = () => {
    const d = heroDetail();
    const t = heroTile();
    if (kind !== 'series') {
      const runtimeMin = (d as MovieView['detail'] | undefined)?.runtimeMin;
      return metaLine({ year: t?.year, runtimeMin, genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating });
    }
    return seriesMetaLine({ year: t?.year, seasons: regularSeasonCount(heroSeries()?.seasons ?? []), genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating });
  };
  /**
   * The line the page is on at the top, then the rows after it, down to a peek of the next one's title; in pointer
   * mode only lines that fit above the shell's bottom button row.
   */
  const slots = createMemo(() => browseSlots(
    { chipsH: CHIPS_LINE_H, rowH: ROW_H, chips: hasChips(), rowCount: rows().length, line: line(), row: focus().row },
    { top: ROW_Y, gap: ROW_GAP, bottom: pointerMode() ? BOTTOM_ROW_Y : LAYOUT.height, peek: ROW_PEEK },
    pointerMode() ? 'whole' : 'peek'));
  const visibleRows = () => slots().rows.map((s) => s.index);
  const rowY = (i: number) => slots().rows.find((s) => s.index === i)?.y ?? ROW_Y;
  /** The hero's third line: the catalogue status while there is one, else the plot. */
  const heroLine = () => statusLine() || (heroDetail()?.plot ?? '');
  /** A pointer press on a chip: it takes the focus and opens the grid. */
  const pointToChip = (i: number) => {
    userMoved = true;
    setChip(i);
    rememberChip();
    focusArea('chips');
    openChip();
  };
  /** A pointer press on a poster: the column memory of the row left and of the row pressed are kept, as with the keys. */
  const pointTo = (row: number, col: number) => {
    userMoved = true;
    setLineTo('rows');
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
      {/* Hero art: the backdrop, faded into the background behind the hero and the first line. */}
      <Show when={heroTile()}>
        {/* Layers by zIndex, not insertion order: a late image is inserted last and would otherwise cover the rest. */}
        <View zIndex={0}>
          {/* A new backdrop cross-fades in over 200 ms (two stacked image nodes). */}
          <CrossFadeArt x={ART_X} y={0} width={ART_W} height={ART_H} url={shownArt()} onFailed={(u) => { posterCache.markFailed(u); setArtFailures((n) => n + 1); }} />
        </View>
        {/* Scrims: left to right, and into the rows. */}
        <View zIndex={1} x={ART_X} y={0} width={ART_W} height={ART_H} src={scrimTexture('left', BACKGROUND_RGB)} />
        <View zIndex={1} y={ART_H - 340} width={LAYOUT.width} height={340} src={scrimTexture('down', BACKGROUND_RGB)} />
        <View zIndex={2}>
          <Text x={HERO_X} y={HERO_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.title} color={COLORS.text}>{heroTile()?.title ?? ''}</Text>
          <Text x={HERO_X} y={HERO_META_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.text}>
            {heroMeta()}
          </Text>
          <ActionBar ref={(el) => { heroNode = el; }} x={LAYOUT.width - LAYOUT.safeX - actionsWidth(heroActions())} y={HERO_Y - 4}
            actions={heroActions()} onAction={onHeroAction}
            onUp={() => focusArea('tabs')} onDown={() => focusArea(areaBelow('hero', ctx()))} onFocusChanged={(f) => { if (f) choose('hero'); }} />
        </View>
      </Show>
      {/* The plot (one line), or the catalogue status while there is one (also before any title shows). */}
      <Show when={heroLine()}>
        <Text zIndex={2} x={HERO_X} y={HERO_LINE_Y} width={HERO_LINE_W} maxWidth={HERO_LINE_W} contain="width" maxLines={1}
          fontSize={FONT.small} color={COLORS.muted}>{heroLine()}</Text>
      </Show>

      <TabBar ref={(el) => { tabsNode = el; }} active={tabOfKind(kind)} onSelect={goTab} onDown={() => focusArea(areaBelow('tabs', ctx()))}
        onFocusChanged={(f) => { if (f) choose('tabs'); }} />

      <Show when={status() === 'ready'} fallback={
        <View>
          <Text x={HERO_X} y={HERO_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={2} fontSize={FONT.heading} color={COLORS.text}>{message()}</Text>
          {/* First load: skeleton rows (a label bar and poster placeholders) stand in for the rows (spec §3.7). */}
          <Show when={skeletonShown(status(), rows().length)}>
            <For each={SKELETONS}>{(r) => (
              <View>
                <View x={r.label.x} y={r.label.y} width={r.label.w} height={r.label.h} borderRadius={r.label.h / 2} color={COLORS.surface} />
                <For each={r.posters}>{(p) => <View x={p.x} y={p.y} width={p.w} height={p.h} borderRadius={LAYOUT.radius} color={COLORS.surface} />}</For>
              </View>
            )}</For>
          </Show>
          <Show when={status() === 'error'}>
            <Button ref={(el) => { errorNode = el; }} x={HERO_X} y={ROW_Y} label="Try again"
              onPress={() => void api.refreshVod(kind).catch(() => undefined).then(() => load())} onUp={() => { tabsNode?.setFocus(); return true; }} />
          </Show>
        </View>
      }>
        {/* Categories: the way into the whole library (the grid), on top while the page is on it. */}
        <View ref={(el) => { chipsNode = el; }} y={slots().chipsY ?? ROW_Y} width={LAYOUT.width} height={CHIPS_LINE_H} zIndex={3}
          alpha={slots().chipsY === undefined ? 0 : 1}
          onFocusChanged={(f: boolean) => { if (f) choose('chips'); }}
          onUp={() => moveChips('up')} onDown={() => moveChips('down')} onLeft={() => moveChips('left')} onRight={() => moveChips('right')}
          onEnter={openChip}>
          <Show when={slots().chipsY !== undefined}>
            <Text x={LAYOUT.safeX} y={0} fontSize={FONT.heading} color={COLORS.text}>{'Categories'}</Text>
            <Text x={LAYOUT.safeX + hintAfterHeading('Categories', FONT.heading)} y={8} fontSize={FONT.small} color={COLORS.muted}>{`Ok opens the grid · Green: ${copy.allLabel}`}</Text>
            <ChipRow x={LAYOUT.safeX} y={LABEL_H} width={LAYOUT.width - LAYOUT.safeX} chips={chips()} focus={chip()} lit={area() === 'chips'}
              onChipClick={pointToChip} onWheel={onWheel} />
          </Show>
        </View>
        {/* Rows: the line the page is on sits on top, the rows after it below. One focusable node owns the keys. */}
        <View ref={(el) => { rowsNode = el; }} y={0} width={LAYOUT.width} height={LAYOUT.height} zIndex={3}
          onFocusChanged={(f: boolean) => { if (f) choose('rows'); }}
          onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')}
          onEnter={openCell} onMenu={openMenu} onLongOk={openMenu}>
          <View ref={(el) => { wheelNode = el; }} y={ROW_Y} width={LAYOUT.width} height={BOTTOM_ROW_Y - ROW_Y} />
          <For each={visibleRows()}>{(i) => {
            const r = () => rows()[i]!;
            return (
              <View y={rowY(i)}>
                <Text x={LAYOUT.safeX} y={0} width={ROW_TITLE_W} maxWidth={ROW_TITLE_W} contain="width" maxLines={1} fontSize={FONT.heading} color={COLORS.text}>{r().title}</Text>
                <PosterRow x={LAYOUT.safeX} y={LABEL_H} width={LAYOUT.width - LAYOUT.safeX} row={r()}
                  focusCol={i === focus().row ? focus().col : undefined} lit={area() === 'rows' && i === focus().row}
                  onCellClick={(c) => { pointTo(i, c); focusArea('rows'); openCell(); }}
                  onCellOptions={(c) => { pointTo(i, c); openMenu(); }} onWheel={onWheel} />
              </View>
            );
          }}</For>
        </View>
      </Show>
      <View zIndex={5}><menu.View /></View>
    </View>
  );
}
