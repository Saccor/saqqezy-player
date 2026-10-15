import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { MovieView, SeriesView, VodHome, VodTile } from '@iptv/app-api';
import { VOD_ROW_CONTINUE, VOD_ROW_ITEMS } from '@iptv/app-api';
import { episodeLabel } from '@iptv/core';
import { api, onEvent } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { Button } from '../components/Button.tsx';
import { POSTER_H, posterCache } from '../components/PosterTile.tsx';
import { PosterRow } from '../components/PosterRow.tsx';
import { TabBar } from '../components/TabBar.tsx';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { createDebounce } from '../playback/debounce.ts';
import { playback } from '../playback/playback.ts';
import { BOTTOM_ROW_Y } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { initState } from '../state/appState.ts';
import { cellAt, locateFocus, mergeRows, wheelKey, moveBrowse, rowSort, rowsToLoad, toRowModels, type BrowseFocus, type FocusMemory, type RowModel } from '../vod/browseLogic.ts';
import { createVodLauncher } from '../vod/launch.ts';
import { minutesLeft, titleLengthMs } from '../vod/vodPlayerLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { scrimTexture } from '../vod/scrim.ts';
import { metaLine } from '../vod/posterLogic.ts';
import { KIND_COPY } from '../vod/kindCopy.ts';
import { tabNavigation, tabOfKind, type TabId, type VodKind } from '../vod/tabLogic.ts';

const HERO_X = LAYOUT.safeX;
const HERO_Y = 200;
const HERO_W = 860;
const ROW_LABEL_Y = 610;
const NEXT_LABEL_Y = ROW_LABEL_Y + 44 + POSTER_H + 36;
const HERO_SETTLE_MS = 400;
const ART_X = 640;
const ART_W = LAYOUT.width - ART_X;
const ART_H = 720;
const BG = COLORS.background;
/** The background colour without alpha (0xRRGGBB), for the fade textures. */
const BG_RGB = Math.floor(COLORS.background / 0x100);

type Area = 'tabs' | 'hero' | 'rows';

/** The focus by identity (row id, tile id) and the last column per row id. */
interface BrowseMemory { focus: FocusMemory; cols: Map<string, number> }
/** Kept across visits (per source and kind) so Back from the detail returns to the same poster. */
const memories = new Map<string, BrowseMemory>();
const memoryFor = (key: string): BrowseMemory => {
  let m = memories.get(key);
  if (!m) { m = { focus: { row: 0, col: 0 }, cols: new Map() }; memories.set(key, m); }
  return m;
};

const DETAILS_ACTION = { id: 'details', label: 'Details', width: 200 };
const FAV_ADD_ACTION = { id: 'fav', label: 'Add to favourites', width: 300 };
const FAV_ON_ACTION = { id: 'fav', label: 'In favourites', width: 300 };

/**
 * Movies or Series browse (`params.kind`): the tab bar, a hero for the focused title, and poster rows (Continue watching,
 * Favourites, Recently added, categories).
 */
export function VodBrowseScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { kind?: VodKind; focus?: 'tabs' | 'content' };
  const kind: VodKind = params.kind ?? 'movie';
  const copy = KIND_COPY[kind];
  const startOnTabs = params.focus === 'tabs';
  delete params.focus;

  const [home, setHome] = createSignal<VodHome | undefined>(undefined);
  const [rows, setRows] = createSignal<RowModel[]>([]);
  const [sourceId, setSourceId] = createSignal<string | undefined>(initState()?.activeSourceId);
  const memKey = () => `${sourceId() ?? ''}:${kind}`;
  let memory = memoryFor(memKey());
  const [focus, setFocus] = createSignal<BrowseFocus>({ row: memory.focus.row, col: memory.focus.col });
  const [area, setArea] = createSignal<Area>(startOnTabs ? 'tabs' : 'rows');
  const [hero, setHero] = createSignal<MovieView | SeriesView | undefined>(undefined);
  let tabsNode: ElementNode | undefined;
  let heroNode: ElementNode | undefined;
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
  const choose = (a: Area) => { setArea(a); if (!restoring) preferredArea = a; };

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

  const focusArea = (a: Area) => {
    if (!restoring) preferredArea = a;
    if (a === 'hero' && !focusedTile()) a = 'rows';
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
    (a === 'tabs' ? tabsNode : a === 'hero' ? heroNode : rowsNode)?.setFocus();
    return true;
  };

  // ---- data ----

  /** After a load: put focus back on what the user chose, only when this load may have unmounted the focused view. */
  const restoreFocus = (before: { status: string | undefined; hasRows: boolean; hasTile: boolean }) => {
    queueMicrotask(() => {
      if (!alive || router.topOverlay() !== undefined || menu.isOpen()) return;
      const changed = before.status !== status() || before.hasRows !== (rows().length > 0) || before.hasTile !== !!focusedTile();
      if (!changed) return;
      restoring = true;
      try { focusArea(preferredArea); } finally { restoring = false; }
    });
  };

  const load = async () => {
    const g = ++gen;
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
      setFavOverride(undefined);
    });
    remember();
    syncHero();
    void loadNear();
    restoreFocus(before);
  };

  const loadNear = async () => {
    const g = gen;
    const rs = rows();
    for (const i of rowsToLoad(rs, focus().row)) {
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
  const heroLoad = createDebounce<string>(HERO_SETTLE_MS, (id) => {
    const view: Promise<MovieView | SeriesView | undefined> = kind === 'series' ? api.getSeries(id) : api.getMovie(id);
    void view.then((v) => { if (alive && focusedTile()?.id === id) setHero(v); }).catch(() => undefined);
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
    else if (nav.action === 'replace') router.replace('vod', { kind: nav.kind, focus: 'tabs' });
  };
  const openCell = () => {
    const c = focusedCell();
    const r = rows()[focus().row];
    if (!c || !r) return true;
    if (c.kind === 'tile') router.push(copy.detailRoute, { id: c.tile.id, tile: c.tile });
    else if (c.kind === 'viewAll') router.push('vodGrid', { kind, categoryId: r.id });
    return true;
  };
  const launcher = createVodLauncher({
    alive: () => alive,
    topOverlay: () => router.topOverlay(),
    getPlayable: (id, seriesId) => api.getVodPlayable(id, seriesId),
    push: (playable, fromStart) => router.push('vodPlay', { playable, fromStart }),
    toast: showToast,
  });
  const menu = createPosterMenu({ refocus: () => focusArea(area()), onChanged: () => void load() });
  const openMenu = () => {
    const t = focusedTile();
    if (t) menu.open(t, rows()[focus().row]?.id === VOD_ROW_CONTINUE);
    return true;
  };
  /** Set after a successful toggle so the hero shows the new state at once; cleared when a reload lands. */
  const [favOverride, setFavOverride] = createSignal<{ id: string; on: boolean } | undefined>(undefined);
  let favBusy = false;
  const isFav = createMemo(() => {
    const t = focusedTile();
    const o = favOverride();
    return t ? (o?.id === t.id ? o.on : !!t.favourite) : false;
  });
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
    const t = focusedTile();
    if (kind === 'series') {
      // Task 3 replaces this with seriesDetailLogic.primaryLabel.
      const p = heroSeries()?.primary;
      const label = p ? (p.mode === 'continue' ? 'Continue ' : 'Play ') + episodeLabel(p.season, p.episode) : 'Play';
      return { id: 'play', label, width: p ? 320 : 200 };
    }
    const h = hero()?.tile.id === t?.id ? (hero() as MovieView | undefined) : undefined;
    const total = titleLengthMs(h?.resumeMs ?? 0, t?.progress, h?.detail?.runtimeMin);
    if (!t?.progress || !h || h.resumeMs <= 0 || total <= 0) return { id: 'play', label: 'Play', width: 200 };
    return { id: 'play', label: `Resume · ${minutesLeft(h.resumeMs, total)}`, width: 320 };
  });
  const heroActions = createMemo(() => [playAction(), DETAILS_ACTION, isFav() ? FAV_ON_ACTION : FAV_ADD_ACTION]);
  const toggleFav = async (t: VodTile) => {
    if (favBusy) return;
    favBusy = true;
    const on = !isFav();
    try {
      try {
        await api.setVodFavourite(t.id, on);
      } catch {
        if (alive) showToast("Couldn't save that. Try again.");
        return;
      }
      if (!alive) return;
      setFavOverride({ id: t.id, on });
      await load();
    } finally {
      favBusy = false;
    }
  };
  const onHeroAction = (id: string) => {
    const t = focusedTile();
    if (!t || router.topOverlay() !== undefined || menu.isOpen()) return;
    if (id === 'play') {
      if (kind !== 'series') { void launcher.play(t.id); return; }
      // A series plays its primary episode; without one (no episodes, or not loaded yet) the detail opens.
      const p = heroSeries()?.primary;
      if (p) void launcher.play(p.episodeId, { seriesId: t.id });
      else router.push(copy.detailRoute, { id: t.id, tile: t });
    } else if (id === 'details') router.push(copy.detailRoute, { id: t.id, tile: t });
    else if (id === 'fav') void toggleFav(t);
  };

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    const r = moveBrowse(rows(), focus(), key, memory.cols);
    if ('edge' in r) return focusArea(focusedTile() ? 'hero' : 'tabs');
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
   * Pointer mode shows only the focused row (the peek row would sit under the shell's Back button), so the wheel walks
   * the rows: vertical between rows, horizontal along the row. At the top row a wheel up stays put.
   */
  const onWheel = (dy: number, dx: number) => {
    const key = wheelKey(dy, dx);
    if (!key || (key === 'up' && focus().row === 0)) return true;
    if (area() !== 'rows') focusArea('rows');
    move(key);
    return true;
  };
  // It ends above the shell's Back row, which must keep its clicks. Registered before the rows' own targets, so a poster row (which passes the wheel on) wins where they overlap.
  usePointerTarget({ node: () => wheelNode, enabled: () => status() === 'ready' && rows().length > 0, onWheel });

  // ---- lifecycle ----

  onMount(() => {
    // The live stream stops here: Movies and Series are full screens, and a 1 GB TV needs the decoder and memory.
    playback.stop();
    const sameSource = (e: unknown) => {
      const ev = e as { sourceId?: string; kind?: string };
      return ev.sourceId === sourceId() && ev.kind === kind;
    };
    const offs = [
      onEvent('vodRefreshed', (e) => { if (sameSource(e)) void load(); }),
      onEvent('vodRefreshFailed', (e) => { if (sameSource(e)) void load(); }),
      onEvent('vodLoading', (e) => { if (sameSource(e) && rows().length === 0) void load(); }),
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
          setHome(undefined);
          setHero(undefined);
          setFocus({ row: memory.focus.row, col: memory.focus.col });
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
  const heroTile = () => focusedTile();
  /** The detail only shows while it belongs to the focused title. */
  const heroDetail = () => (hero()?.tile.id === heroTile()?.id ? hero()?.detail : undefined);
  const art = () => heroDetail()?.backdrop ?? undefined;
  /** "2022 · 1 h 54 min · Drama · 12 · ★ 7.6"; a series shows "N seasons" in place of the runtime once its view is loaded. */
  const heroMeta = () => {
    const d = heroDetail();
    const t = heroTile();
    if (kind !== 'series') {
      const runtimeMin = (d as MovieView['detail'] | undefined)?.runtimeMin;
      return metaLine({ year: t?.year, runtimeMin, genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating });
    }
    const n = heroSeries()?.seasons.length ?? 0;
    const seasons = n > 0 ? (n === 1 ? '1 season' : `${n} seasons`) : '';
    return [metaLine({ year: t?.year }), seasons, metaLine({ genre: d?.genre, ageRating: d?.ageRating, rating: t?.rating })]
      .filter((p) => p !== '').join(' · ');
  };
  /** The focused row, and the next one peeking in below; not in pointer mode, where it would sit under the shell's Back button. */
  const visibleRows = () => (pointerMode() ? [focus().row] : [focus().row, focus().row + 1]).filter((i) => rows()[i] !== undefined);
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
      onYellow={() => { router.push('search'); return true; }} onBlue={() => { router.push('settings'); return true; }}>
      {/* Hero art: the backdrop, else the poster, faded into the background. */}
      <Show when={heroTile()}>
        {/* Layers by zIndex, not insertion order: a late image is inserted last and would otherwise cover the rest. */}
        <View zIndex={0}>
        <Show when={art() && posterCache.usable(art()) ? art() : undefined} keyed fallback={
          <Show when={heroDetail() !== undefined ? heroTile()?.poster : undefined} keyed>
            {(u) => <View x={LAYOUT.width - LAYOUT.safeX - 300} y={130} width={300} height={450} src={rawViaDevProxy(u)} alpha={0.9} />}
          </Show>
        }>
          {(u) => <View x={ART_X} y={0} width={ART_W} height={ART_H} src={rawViaDevProxy(u)}
            onEvent={{ failed: () => posterCache.markFailed(u) }} />}
        </Show>
        </View>
        {/* Scrims: left to right, and into the rows. */}
        <View zIndex={1} x={ART_X} y={0} width={ART_W} height={ART_H} src={scrimTexture('left', BG_RGB)} />
        <View zIndex={1} y={ART_H - 280} width={LAYOUT.width} height={280} src={scrimTexture('down', BG_RGB)} />
        <View zIndex={2}>
        <Text x={HERO_X} y={HERO_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>{focusedRowTitle()}</Text>
        <Text x={HERO_X} y={HERO_Y + 34} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={64} color={COLORS.text}>{heroTile()?.title ?? ''}</Text>
        <Text x={HERO_X} y={HERO_Y + 116} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.text}>
          {heroMeta()}
        </Text>
        <Text x={HERO_X} y={HERO_Y + 160} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={3} fontSize={FONT.body} color={COLORS.muted}>
          {heroDetail()?.plot ?? ''}
        </Text>
        <ActionBar ref={(el) => { heroNode = el; }} x={HERO_X} y={HERO_Y + 290} actions={heroActions()} onAction={onHeroAction}
          onUp={() => focusArea('tabs')} onDown={() => focusArea('rows')} onFocusChanged={(f) => { if (f) choose('hero'); }} />
        </View>
      </Show>

      <TabBar ref={(el) => { tabsNode = el; }} active={tabOfKind(kind)} onSelect={goTab} onDown={() => focusArea(focusedTile() ? 'hero' : 'rows')}
        onFocusChanged={(f) => { if (f) choose('tabs'); }} />
      <Show when={home()?.truncated}>
        <Text zIndex={2} x={LAYOUT.safeX + 300} y={LAYOUT.safeY + 34} fontSize={FONT.small} color={COLORS.muted}>{'Showing the first 200,000 titles.'}</Text>
      </Show>

      <Show when={status() === 'ready'} fallback={
        <View>
          <Text x={HERO_X} y={HERO_Y + 100} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={2} fontSize={FONT.heading} color={COLORS.text}>{message()}</Text>
          <Show when={status() === 'error'}>
            <Button ref={(el) => { errorNode = el; }} x={HERO_X} y={HERO_Y + 220} label="Try again"
              onPress={() => void api.refreshVod(kind).catch(() => undefined).then(() => load())} onUp={() => { tabsNode?.setFocus(); return true; }} />
          </Show>
        </View>
      }>
        {/* Rows: the focused row sits in the fixed slot, the next one peeks in below. One focusable node owns the keys. */}
        <View ref={(el) => { rowsNode = el; }} y={0} width={LAYOUT.width} height={LAYOUT.height} zIndex={3}
          onFocusChanged={(f: boolean) => { if (f) choose('rows'); }}
          onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')}
          onEnter={openCell} onMenu={openMenu} onLongOk={openMenu}>
          <View ref={(el) => { wheelNode = el; }} y={ROW_LABEL_Y} width={LAYOUT.width} height={BOTTOM_ROW_Y - ROW_LABEL_Y} />
          <For each={visibleRows()}>{(i) => {
            const r = () => rows()[i]!;
            const y = () => (i === focus().row ? ROW_LABEL_Y : NEXT_LABEL_Y);
            return (
              <View y={y()}>
                <Text x={LAYOUT.safeX} y={0} fontSize={FONT.heading} color={COLORS.text}>{r().title}</Text>
                <PosterRow x={LAYOUT.safeX} y={44} width={LAYOUT.width - LAYOUT.safeX} row={r()}
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
