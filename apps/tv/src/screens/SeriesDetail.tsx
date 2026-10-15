import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { SeriesView, VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { EP_ROW_H, EpisodeRow } from '../components/EpisodeRow.tsx';
import { posterCache } from '../components/PosterTile.tsx';
import { SEASON_TAB_H, SeasonTabs } from '../components/SeasonTabs.tsx';
import { moveFocus } from '../components/virtualWindow.ts';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { createVodLauncher } from '../vod/launch.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { metaLine } from '../vod/posterLogic.ts';
import { scrimTexture } from '../vod/scrim.ts';
import { primaryLabel, refocus, seasonLabel, seriesMeta } from '../vod/seriesDetailLogic.ts';
import { TAB_SWITCH_MS } from '../vod/tabLogic.ts';

const BG = COLORS.background;
/** The background colour without alpha (0xRRGGBB), for the fade textures. */
const BG_RGB = Math.floor(COLORS.background / 0x100);
const HERO_X = LAYOUT.safeX;
const HERO_W = 1100;
const TITLE_Y = 110;
const ACTIONS_Y = 384;
const TABS_Y = 500;
const ROW_Y = 600;
const ROW_W = LAYOUT.width - LAYOUT.safeX;

type Area = 'actions' | 'seasons' | 'episodes';
/** Where the screen was, kept in its router params so a remount (returning from the player) lands there again. */
interface SavedFocus { seasonNumber: number; episodeId: string }

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

/**
 * Series detail: backdrop, title, meta and plot, the primary episode button and Favourite, the season tabs, and a row of
 * episode cards for the season shown. Opens on the season and episode of the primary, with focus on the primary button.
 */
export function SeriesDetailScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { id: string; tile?: VodTile; focus?: SavedFocus; area?: Area };
  /** Read before the effect below starts overwriting them. */
  const saved = { focus: params.focus, area: params.area };
  const [view, setView] = createSignal<SeriesView | undefined>(undefined);
  const [loaded, setLoaded] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [area, setArea] = createSignal<Area>('actions');
  /** The season tab the keys are on, and the season whose episodes are listed (it follows `tabSel` after a rest or OK). */
  const [tabSel, setTabSel] = createSignal(0);
  const [season, setSeason] = createSignal(0);
  const [epCol, setEpCol] = createSignal(0);
  let actionsNode: ElementNode | undefined;
  let tabsNode: ElementNode | undefined;
  let rowNode: ElementNode | undefined;
  let alive = true;
  /** Bumped by every load; an answer from an older load never writes state. */
  let gen = 0;
  let busy = false;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  const launcher = createVodLauncher({
    alive: () => alive,
    topOverlay: () => router.topOverlay(),
    getPlayable: (id, seriesId) => api.getVodPlayable(id, seriesId),
    push: (playable, fromStart) => router.push('vodPlay', { playable, fromStart }),
    toast: showToast,
  });

  /** Set after a successful toggle; a failed reload then still shows the right state. Cleared when a reload lands. */
  const [favOverride, setFavOverride] = createSignal<boolean | undefined>(undefined);
  const tile = (): VodTile | undefined => {
    const t = view()?.tile ?? params.tile;
    const f = favOverride();
    return t && f !== undefined ? { ...t, favourite: f } : t;
  };
  const detail = () => view()?.detail ?? undefined;
  const seasons = () => view()?.seasons ?? [];
  const episodes = () => seasons()[season()]?.episodes ?? [];
  const position = (): SavedFocus | undefined => {
    const s = seasons()[season()];
    return s ? { seasonNumber: s.number, episodeId: s.episodes[epCol()]?.id ?? '' } : undefined;
  };

  // The router keeps this entry's params while the player is on top: remember where focus is.
  createEffect(() => {
    const p = position();
    const a = area();
    if (!p) return;
    params.focus = p;
    params.area = a;
  });

  /** No overlay or poster menu is open (a key or click behind one must not act). */
  const free = () => router.topOverlay() === undefined && !menu.isOpen();

  const clearRest = () => {
    if (restTimer !== undefined) clearTimeout(restTimer);
    restTimer = undefined;
  };
  const showSeason = (i: number) => {
    clearRest();
    if (i === season() || !seasons()[i]) return;
    setSeason(i);
    setEpCol(0);
  };
  /** Leaving the tabs (or OK) shows the selected season at once instead of after the rest. */
  const commitTab = () => showSeason(tabSel());

  /** Focuses an area. A refocus (`fallback`) lands on the nearest live area above; a key press into an empty one stays. */
  const focusArea = (a: Area, fallback = false): boolean => {
    if (a === 'episodes' && episodes().length === 0) {
      if (!fallback) return true;
      a = 'seasons';
    }
    if (a === 'seasons' && seasons().length === 0) {
      if (!fallback) return true;
      a = 'actions';
    }
    if (a === 'seasons') setTabSel(season());
    setArea(a);
    (a === 'actions' ? actionsNode : a === 'seasons' ? tabsNode : rowNode)?.setFocus();
    return true;
  };

  /** After a reload the focused area may have emptied: keep focus on a live node. */
  const settleFocus = () => queueMicrotask(() => {
    if (!alive || router.topOverlay() !== undefined || menu.isOpen()) return;
    if (area() !== 'actions') focusArea(area(), true);
  });

  /**
   * Places the season, tab and episode. First load: the saved focus when the screen was left from the seasons or episodes
   * (returning from the player), else the primary episode (it may have moved on). A reload keeps the current episode.
   */
  const place = (v: SeriesView, first: boolean) => {
    const prev = first ? (saved.area === 'actions' ? undefined : saved.focus) : position();
    const pos = refocus(prev, v);
    clearRest();
    setSeason(pos.season);
    setTabSel(pos.season);
    setEpCol(Math.max(0, pos.episode));
  };

  const load = async (first: boolean) => {
    const g = ++gen;
    let v: SeriesView | undefined;
    let failed = false;
    try {
      v = await api.getSeries(params.id);
    } catch (err) {
      console.warn('Series load failed', errName(err));
      failed = true;
    }
    if (!alive || g !== gen) return;
    if (v || first) setView(v);
    if (first || v) setLoadFailed(failed);
    if (v) {
      setFavOverride(undefined);
      place(v, first);
    }
    setLoaded(true);
    if (first && v && (saved.area === 'seasons' || saved.area === 'episodes') && free()) {
      queueMicrotask(() => { if (alive && free()) focusArea(saved.area!, true); });
    } else {
      settleFocus();
    }
  };

  const playEpisode = (col: number) => {
    const ep = episodes()[col];
    if (!ep || busy || !free()) return;
    void launcher.play(ep.id, { seriesId: params.id });
  };

  const actions = () => {
    const p = view()?.primary;
    return [
      { id: 'play', label: primaryLabel(p), width: p ? 360 : 220 },
      { id: 'fav', label: tile()?.favourite ? 'In favourites' : 'Add to favourites', width: 320 },
    ];
  };
  const onAction = async (id: string) => {
    const t = tile();
    if (!t || busy || !free()) return;
    busy = true;
    try {
      if (id === 'play') {
        const p = view()?.primary;
        if (p) await launcher.play(p.episodeId, { seriesId: params.id });
      } else if (id === 'fav') {
        try {
          await api.setVodFavourite(t.id, !t.favourite);
        } catch (err) {
          console.warn('Favourite failed', errName(err));
          if (alive) showToast("Couldn't save that. Try again.");
          return;
        }
        if (!alive) return;
        // Show the new state at once; the reload below only refines it.
        setFavOverride(!t.favourite);
        await load(false);
      }
    } finally {
      busy = false;
    }
  };

  const moveTabs = (key: 'up' | 'down' | 'left' | 'right') => {
    if (key === 'up') { commitTab(); return focusArea('actions'); }
    if (key === 'down') { commitTab(); return focusArea('episodes'); }
    const next = moveFocus(tabSel(), key === 'left' ? -1 : 1, seasons().length);
    if (next === tabSel()) return true;
    setTabSel(next);
    clearRest();
    restTimer = setTimeout(() => { restTimer = undefined; if (alive) showSeason(tabSel()); }, TAB_SWITCH_MS);
    return true;
  };
  const moveEpisodes = (key: 'up' | 'down' | 'left' | 'right') => {
    if (key === 'up') return focusArea('seasons');
    if (key === 'down') return true;
    setEpCol((c) => moveFocus(c, key === 'left' ? -1 : 1, episodes().length));
    return true;
  };

  const menu = createPosterMenu({
    refocus: () => { if (alive) focusArea('episodes', true); },
    onChanged: () => { if (alive) void load(false); },
  });
  const openMenu = (col: number) => {
    const ep = episodes()[col];
    if (!ep || !free()) return true;
    menu.openEpisode(ep, params.id);
    return true;
  };

  /** Pointer: a tab click shows that season at once. */
  const clickTab = (i: number) => {
    if (!free()) return;
    setTabSel(i);
    showSeason(i);
    focusArea('seasons');
  };
  const clickCard = (col: number, options: boolean) => {
    if (!free()) return;
    setEpCol(col);
    focusArea('episodes');
    if (options) openMenu(col);
    else playEpisode(col);
  };

  onMount(() => {
    void load(true);
    actionsNode?.setFocus();
  });
  onCleanup(() => {
    alive = false;
    clearRest();
  });

  const backdrop = () => detail()?.backdrop;
  const notAvailable = () => loaded() && (loadFailed() || (view() !== undefined && view()!.detail === null));
  const meta = () => {
    const v = view();
    if (v) return seriesMeta(v);
    return metaLine({ year: tile()?.year, rating: tile()?.rating });
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={BG} onBack={() => { router.back(); return true; }}>
      {/* Layers by zIndex, not insertion order: a late image is inserted last and would otherwise cover the rest. */}
      <View zIndex={0}>
        <Show when={backdrop() && posterCache.usable(backdrop()) ? backdrop() : undefined} keyed>
          {(u) => <View x={640} y={0} width={1280} height={720} src={rawViaDevProxy(u)} onEvent={{ failed: () => posterCache.markFailed(u) }} />}
        </Show>
      </View>
      <View zIndex={1} x={640} y={0} width={1280} height={720} src={scrimTexture('left', BG_RGB)} />
      <View zIndex={1} y={440} width={LAYOUT.width} height={280} src={scrimTexture('down', BG_RGB)} />
      <View zIndex={2}>
        <Text x={HERO_X} y={TITLE_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={64} color={COLORS.text}>{tile()?.title ?? ''}</Text>
        <Text x={HERO_X} y={TITLE_Y + 86} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.text}>{meta()}</Text>
        <Text x={HERO_X} y={TITLE_Y + 132} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={3} fontSize={FONT.body} color={COLORS.muted}>
          {notAvailable() ? 'Details are not available right now.' : detail()?.plot ?? ''}
        </Text>
        <ActionBar ref={(el) => { actionsNode = el; }} x={HERO_X} y={ACTIONS_Y} actions={actions()} onAction={(id) => void onAction(id)}
          onDown={() => focusArea('seasons')} onFocusChanged={(f) => { if (f) setArea('actions'); }} />

        <Show when={!loaded() || seasons().length > 0}>
          <View ref={(el) => { tabsNode = el; }} x={0} y={TABS_Y} width={LAYOUT.width} height={SEASON_TAB_H}
            onFocusChanged={(f: boolean) => { if (f) setArea('seasons'); }}
            onUp={() => moveTabs('up')} onDown={() => moveTabs('down')} onLeft={() => moveTabs('left')} onRight={() => moveTabs('right')}
            onEnter={() => { commitTab(); return true; }}>
            <SeasonTabs x={HERO_X} y={0} width={ROW_W} labels={view() ? seasons().map(seasonLabel) : undefined}
              sel={tabSel()} shown={season()} lit={area() === 'seasons'} onTabClick={clickTab} />
          </View>
          <View ref={(el) => { rowNode = el; }} x={0} y={ROW_Y} width={LAYOUT.width} height={EP_ROW_H}
            onFocusChanged={(f: boolean) => { if (f) setArea('episodes'); }}
            onUp={() => moveEpisodes('up')} onDown={() => moveEpisodes('down')} onLeft={() => moveEpisodes('left')} onRight={() => moveEpisodes('right')}
            onEnter={() => { playEpisode(epCol()); return true; }} onMenu={() => openMenu(epCol())} onLongOk={() => openMenu(epCol())}>
            <EpisodeRow x={HERO_X} y={0} width={ROW_W} episodes={view() ? episodes() : undefined}
              focusCol={view() ? epCol() : undefined} lit={area() === 'episodes'}
              onCardClick={(c) => clickCard(c, false)} onCardOptions={(c) => clickCard(c, true)} />
          </View>
        </Show>
      </View>
      <View zIndex={5}><menu.View /></View>
    </View>
  );
}
