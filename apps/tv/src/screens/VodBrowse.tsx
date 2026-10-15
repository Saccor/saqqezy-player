import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { MovieView, VodHome, VodTile } from '@iptv/app-api';
import { VOD_ROW_CONTINUE, VOD_ROW_ITEMS } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { Button } from '../components/Button.tsx';
import { POSTER_H, posterCache } from '../components/PosterTile.tsx';
import { PosterRow } from '../components/PosterRow.tsx';
import { TabBar } from '../components/TabBar.tsx';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { createDebounce } from '../playback/debounce.ts';
import { playback } from '../playback/playback.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { initState } from '../state/appState.ts';
import { cellAt, clampFocus, moveBrowse, rowSort, rowsToLoad, toRowModels, type BrowseFocus, type RowModel } from '../vod/browseLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { metaLine } from '../vod/posterLogic.ts';
import { tabNavigation, type TabId } from '../vod/tabLogic.ts';

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
/** The background with alpha 0, for the scrims (colours are 0xRRGGBBAA). */
const BG_CLEAR = 0x0b0d1200;

type Area = 'tabs' | 'hero' | 'rows';

/** Kept across visits so Back from the detail returns to the same poster. */
const memory: { focus: BrowseFocus; cols: Map<string, number> } = { focus: { row: 0, col: 0 }, cols: new Map() };

/** Movies browse: the tab bar, a hero for the focused title, and poster rows (Continue watching, Favourites, Recently added, categories). */
export function VodBrowseScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { kind?: 'movie'; focus?: 'tabs' | 'content' };
  const kind = params.kind ?? 'movie';
  const startOnTabs = params.focus === 'tabs';
  delete params.focus;

  const [home, setHome] = createSignal<VodHome | undefined>(undefined);
  const [rows, setRows] = createSignal<RowModel[]>([]);
  const [focus, setFocus] = createSignal<BrowseFocus>(memory.focus);
  const [area, setArea] = createSignal<Area>(startOnTabs ? 'tabs' : 'rows');
  const [hero, setHero] = createSignal<MovieView | undefined>(undefined);
  let tabsNode: ElementNode | undefined;
  let heroNode: ElementNode | undefined;
  let rowsNode: ElementNode | undefined;
  let errorNode: ElementNode | undefined;
  let alive = true;
  const loading = new Set<string>();

  const focusedCell = () => {
    const r = rows()[focus().row];
    return r ? cellAt(r, focus().col) : undefined;
  };
  const focusedTile = (): VodTile | undefined => {
    const c = focusedCell();
    return c?.kind === 'tile' ? c.tile : undefined;
  };
  const focusedRowTitle = () => rows()[focus().row]?.title ?? '';

  const focusArea = (a: Area) => {
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

  const load = async () => {
    const h = await api.getVodHome(kind);
    if (!alive) return;
    const models = toRowModels(h);
    batch(() => {
      setHome(h);
      setRows(models);
      setFocus(clampFocus(models, focus()));
    });
    void loadNear();
  };

  const loadNear = async () => {
    const rs = rows();
    for (const i of rowsToLoad(rs, focus().row)) {
      const r = rs[i]!;
      if (loading.has(r.id)) continue;
      loading.add(r.id);
      try {
        const page = await api.getVodSlice(kind, r.id, rowSort(rs), 0, VOD_ROW_ITEMS);
        if (!alive) return;
        setRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, items: page.rows, total: page.total, loaded: true } : x)));
      } catch {
        // Stays a loading cell; a later focus move tries again.
      } finally {
        loading.delete(r.id);
      }
    }
  };

  // The hero detail (plot, runtime, backdrop) after focus rests; the tile's own fields show at once.
  const heroLoad = createDebounce<string>(HERO_SETTLE_MS, (id) => {
    void api.getMovie(id).then((v) => { if (alive && focusedTile()?.id === id) setHero(v); }).catch(() => undefined);
  });
  const onFocusMoved = () => {
    memory.focus = focus();
    void loadNear();
    const t = focusedTile();
    if (hero()?.tile.id !== t?.id) setHero(undefined);
    if (t) heroLoad.schedule(t.id);
  };

  // ---- actions ----

  const back = () => {
    router.back({ focusTabs: true });
    return true;
  };
  const goTab = (t: TabId) => {
    const nav = tabNavigation('movies', t);
    if (nav.action === 'back') back();
  };
  const openCell = () => {
    const c = focusedCell();
    const r = rows()[focus().row];
    if (!c || !r) return true;
    if (c.kind === 'tile') router.push('movieDetail', { id: c.tile.id, tile: c.tile });
    else if (c.kind === 'viewAll') router.push('vodGrid', { kind, categoryId: r.id });
    return true;
  };
  const play = async (t: VodTile) => {
    try {
      const p = await api.getVodPlayable(t.id);
      if (p && alive) router.push('vodPlay', { playable: p });
    } catch {
      showToast("This video can't play on this device.");
    }
  };
  const menu = createPosterMenu({ refocus: () => focusArea(area()), onChanged: () => void load() });
  const openMenu = () => {
    const t = focusedTile();
    if (t) menu.open(t, rows()[focus().row]?.id === VOD_ROW_CONTINUE);
    return true;
  };
  const heroActions = createMemo(() => {
    const t = focusedTile();
    return [
      { id: 'play', label: 'Play', width: 200 },
      { id: 'details', label: 'Details', width: 200 },
      { id: 'fav', label: t?.favourite ? 'In favourites' : 'Add to favourites', width: 300 },
    ];
  });
  const onHeroAction = (id: string) => {
    const t = focusedTile();
    if (!t) return;
    if (id === 'play') void play(t);
    else if (id === 'details') router.push('movieDetail', { id: t.id, tile: t });
    else if (id === 'fav') void api.setVodFavourite(t.id, !t.favourite).then(() => load()).catch(() => showToast("Couldn't save that. Try again."));
  };

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    const r = moveBrowse(rows(), focus(), key, memory.cols);
    if ('edge' in r) return focusArea(focusedTile() ? 'hero' : 'tabs');
    setFocus(r.focus);
    onFocusMoved();
    return true;
  };

  // ---- lifecycle ----

  onMount(() => {
    // The live stream stops here: Movies is a full screen, and a 1 GB TV needs the decoder and memory.
    playback.stop();
    const sameSource = (e: unknown) => {
      const ev = e as { sourceId?: string; kind?: string };
      return ev.sourceId === initState()?.activeSourceId && ev.kind === kind;
    };
    const offs = [
      onEvent('vodRefreshed', (e) => { if (sameSource(e)) void load(); }),
      onEvent('vodRefreshFailed', (e) => { if (sameSource(e)) void load(); }),
      onEvent('vodLoading', (e) => { if (sameSource(e) && rows().length === 0) void load(); }),
      // Another source became active (a phone companion, Settings): drop everything and re-read.
      onEvent('sourcesChanged', () => {
        memory.focus = { row: 0, col: 0 };
        memory.cols.clear();
        setFocus({ row: 0, col: 0 });
        setHero(undefined);
        void load();
      }),
    ];
    onCleanup(() => { for (const off of offs) off(); });
    void load().then(() => {
      if (!alive) return;
      focusArea(startOnTabs ? 'tabs' : 'rows');
      onFocusMoved();
    });
    if (startOnTabs) tabsNode?.setFocus();
  });
  onCleanup(() => { alive = false; heroLoad.cancel(); });

  // ---- view ----

  const status = () => home()?.status;
  const message = () => {
    const s = status();
    if (s === undefined || s === 'loading') return 'Loading movies from your source…';
    if (s === 'empty') return 'This source has no movies.';
    if (s === 'error') return home()?.error?.message ?? 'Movies could not be loaded.';
    return '';
  };
  const art = () => hero()?.detail?.backdrop ?? undefined;
  const heroTile = () => focusedTile();
  const visibleRows = () => [focus().row, focus().row + 1].filter((i) => rows()[i] !== undefined);

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={BG} onBack={back}
      onYellow={() => { router.push('search'); return true; }} onBlue={() => { router.push('settings'); return true; }}>
      {/* Hero art: the backdrop, else the poster, faded into the background. */}
      <Show when={heroTile()}>
        <Show when={art() && posterCache.usable(art()) ? art() : undefined} keyed fallback={
          <Show when={heroTile()?.poster} keyed>
            {(u) => <View x={LAYOUT.width - LAYOUT.safeX - 360} y={120} width={360} height={540} src={rawViaDevProxy(u)} alpha={0.9} />}
          </Show>
        }>
          {(u) => <View x={ART_X} y={0} width={ART_W} height={ART_H} src={rawViaDevProxy(u)}
            onEvent={{ failed: () => posterCache.markFailed(u) }} />}
        </Show>
        {/* Scrims: left to right, and into the rows. Check the gradient direction in the preview; flip `angle` if it runs the wrong way. */}
        <View x={ART_X} y={0} width={ART_W} height={ART_H} linearGradient={{ colors: [BG, BG_CLEAR], angle: Math.PI / 2, stops: [0.1, 0.7] }} />
        <View y={ART_H - 280} width={LAYOUT.width} height={280} linearGradient={{ colors: [BG_CLEAR, BG], angle: Math.PI, stops: [0, 1] }} />
        <Text x={HERO_X} y={HERO_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>{focusedRowTitle()}</Text>
        <Text x={HERO_X} y={HERO_Y + 34} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={64} color={COLORS.text}>{heroTile()?.title ?? ''}</Text>
        <Text x={HERO_X} y={HERO_Y + 116} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.text}>
          {metaLine({
            year: heroTile()?.year, runtimeMin: hero()?.detail?.runtimeMin, genre: hero()?.detail?.genre,
            ageRating: hero()?.detail?.ageRating, rating: heroTile()?.rating,
          })}
        </Text>
        <Text x={HERO_X} y={HERO_Y + 160} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={3} fontSize={FONT.body} color={COLORS.muted}>
          {hero()?.detail?.plot ?? ''}
        </Text>
        <ActionBar ref={(el) => { heroNode = el; }} x={HERO_X} y={HERO_Y + 290} actions={heroActions()} onAction={onHeroAction}
          onUp={() => focusArea('tabs')} onDown={() => focusArea('rows')} onFocusChanged={(f) => { if (f) setArea('hero'); }} />
      </Show>

      <TabBar ref={(el) => { tabsNode = el; }} active="movies" onSelect={goTab} onDown={() => focusArea(focusedTile() ? 'hero' : 'rows')}
        onFocusChanged={(f) => { if (f) setArea('tabs'); }} />
      <Show when={home()?.truncated}>
        <Text x={LAYOUT.safeX + 300} y={LAYOUT.safeY + 34} fontSize={FONT.small} color={COLORS.muted}>{'Showing the first 200,000 titles.'}</Text>
      </Show>

      <Show when={status() === 'ready'} fallback={
        <View>
          <Text x={HERO_X} y={HERO_Y + 100} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={2} fontSize={FONT.heading} color={COLORS.text}>{message()}</Text>
          <Show when={status() === 'error'}>
            <Button ref={(el) => { errorNode = el; }} x={HERO_X} y={HERO_Y + 220} label="Try again"
              onPress={() => void api.refreshVod(kind).then(load).catch(() => void load())} onUp={() => { tabsNode?.setFocus(); return true; }} />
          </Show>
        </View>
      }>
        {/* Rows: the focused row sits in the fixed slot, the next one peeks in below. One focusable node owns the keys. */}
        <View ref={(el) => { rowsNode = el; }} y={0} width={LAYOUT.width} height={LAYOUT.height}
          onFocusChanged={(f: boolean) => { if (f) setArea('rows'); }}
          onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')}
          onEnter={openCell} onMenu={openMenu} onLongOk={openMenu}>
          <For each={visibleRows()}>{(i) => {
            const r = () => rows()[i]!;
            const y = () => (i === focus().row ? ROW_LABEL_Y : NEXT_LABEL_Y);
            return (
              <View y={y()}>
                <Text x={LAYOUT.safeX} y={0} fontSize={FONT.heading} color={COLORS.text}>{r().title}</Text>
                <PosterRow x={LAYOUT.safeX} y={44} width={LAYOUT.width - LAYOUT.safeX} row={r()}
                  focusCol={i === focus().row ? focus().col : undefined} lit={area() === 'rows' && i === focus().row}
                  onCellClick={(c) => { setFocus({ row: i, col: c }); onFocusMoved(); focusArea('rows'); openCell(); }}
                  onCellOptions={(c) => { setFocus({ row: i, col: c }); onFocusMoved(); openMenu(); }} />
              </View>
            );
          }}</For>
        </View>
      </Show>
      <menu.View />
    </View>
  );
}
