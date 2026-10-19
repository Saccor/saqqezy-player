import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { SeriesView, VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { ListPicker } from '../components/ListPicker.tsx';
import { EP_ROW_H, EpisodeRow } from '../components/EpisodeRow.tsx';
import { SEASON_TAB_H, SeasonTabs } from '../components/SeasonTabs.tsx';
import { moveFocus } from '../components/virtualWindow.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { WORDMARK_BOTTOM } from '../shell/Wordmark.tsx';
import { DetailBackdrop } from '../vod/DetailBackdrop.tsx';
import { createFavToggle } from '../vod/favToggle.ts';
import { createVodLauncher, playSeriesPrimary } from '../vod/launch.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { metaLine } from '../vod/posterLogic.ts';
import {
  fallbackArea, refocus, remountRestore, restoreFocusMove, seasonLabel, seriesActions, seriesMeta, tabSelAfterReload, type SavedFocus, type SeriesArea,
} from '../vod/seriesDetailLogic.ts';
import { TAB_SWITCH_MS } from '../vod/tabLogic.ts';
import { versionRows, versionsBadge } from '../vod/versionsLogic.ts';
import type { PickerRow } from './homeMenuLogic.ts';

const VERSIONS_ID = 'series-versions';

const BG = COLORS.background;
const HERO_X = LAYOUT.safeX;
const HERO_W = 1100;
/** Below the wordmark: a long title at 64 px would otherwise run under it (it spans the screen centre). */
const TITLE_Y = WORDMARK_BOTTOM + 8;
/** Under a three-line plot (it ends about TITLE_Y + 228). */
const ACTIONS_Y = TITLE_Y + 250;
const TABS_Y = 500;
const ROW_Y = 600;
const ROW_W = LAYOUT.width - LAYOUT.safeX;

type Area = SeriesArea;

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

/**
 * Series detail: backdrop, title, meta and plot, the primary episode button and Favourite, the season tabs, and a row of
 * episode cards for the season shown. Opens on the season and episode of the primary, with focus on the primary button.
 */
export function SeriesDetailScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { id: string; tile?: VodTile; focus?: SavedFocus; area?: Area };
  /** Read before the effect below starts overwriting the saved focus; resolved against the view on the first load. */
  const saved = { focus: params.focus, area: params.area };
  const [view, setView] = createSignal<SeriesView | undefined>(undefined);
  const [loaded, setLoaded] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [area, setArea] = createSignal<Area>('actions');
  /** The season tab the keys are on, and the season whose episodes are listed (it follows `tabSel` after a rest or OK). */
  const [tabSel, setTabSel] = createSignal(0);
  const [season, setSeason] = createSignal(0);
  const [epCol, setEpCol] = createSignal(0);
  /** The version the user chose in the Versions list this visit (undefined: the one Play picks). */
  const [versionId, setVersionId] = createSignal<string | undefined>(undefined);
  /** The id episodes play and are marked under: the shown version's. */
  const seriesId = () => view()?.versionId || params.id;
  let actionsNode: ElementNode | undefined;
  let tabsNode: ElementNode | undefined;
  let rowNode: ElementNode | undefined;
  let alive = true;
  /** Bumped by every load; an answer from an older load never writes state. */
  let gen = 0;
  let busy = false;
  /** The user pressed a key (or clicked) since mount: the first load's restore then leaves focus where it is. */
  let userPressed = false;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  const launcher = createVodLauncher({
    alive: () => alive,
    topOverlay: () => router.topOverlay(),
    getPlayable: (id, seriesId) => api.getVodPlayable(id, seriesId),
    push: (playable, fromStart) => router.push('vodPlay', { playable, fromStart }),
    toast: showToast,
  });

  const fav = createFavToggle({
    alive: () => alive,
    reload: () => load(),
    setFavourite: (id, on) => api.setVodFavourite(id, on),
    toast: showToast,
  });
  const tile = (): VodTile | undefined => fav.apply(view()?.tile ?? params.tile);
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
  const focusArea = (want: Area, fallback = false): boolean => {
    const a = fallbackArea(want, { seasons: seasons().length, episodes: episodes().length });
    if (a !== want && !fallback) return true;
    if (a === 'seasons' && area() !== 'seasons') setTabSel(season());
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
   * Places the season, tab and episode. First load: `prev` from `remountRestore` (the saved episode, or the primary). A reload keeps the
   * current episode; while the keys are on the tabs their selection and a pending rest switch are kept.
   */
  const place = (v: SeriesView, first: boolean, prev: SavedFocus | undefined) => {
    const pos = refocus(first ? prev : position(), v);
    const onTabs = !first && area() === 'seasons';
    if (!onTabs) clearRest();
    setSeason(pos.season);
    setTabSel((t) => tabSelAfterReload(first ? 'actions' : area(), t, pos.season, v.seasons.length));
    setEpCol(Math.max(0, pos.episode));
  };

  /** True until a load lands: a first load superseded by another (a Favourite toggle) hands its role on. */
  let firstPending = true;
  /** The latest load; a superseded one returns early, after the next one has replaced this. */
  let inFlight: Promise<void> = Promise.resolve();
  const load = (): Promise<void> => (inFlight = loadOnce());
  /** Waits until a load has landed (a superseded one hands on to the next), then the view (undefined if it failed). */
  const loadedView = async (): Promise<SeriesView | undefined> => {
    while (alive && !loaded()) await inFlight;
    return view();
  };
  const loadOnce = async () => {
    const g = ++gen;
    let v: SeriesView | undefined;
    let failed = false;
    try {
      v = await api.getSeries(params.id, versionId());
    } catch (err) {
      console.warn('Series load failed', errName(err));
      failed = true;
    }
    if (!alive || g !== gen) return;
    const first = firstPending;
    firstPending = false;
    if (v || first) setView(v);
    if (first || v) setLoadFailed(failed);
    const restore = first && v ? remountRestore(saved, v) : undefined;
    if (v) {
      fav.clear();
      place(v, first, restore?.prev);
    }
    setLoaded(true);
    const moveTo = restoreFocusMove(restore?.area, userPressed);
    if (moveTo && free()) {
      queueMicrotask(() => { if (alive && free() && !userPressed) focusArea(moveTo, true); });
    } else {
      settleFocus();
    }
  };

  const playEpisode = (col: number) => {
    const ep = episodes()[col];
    if (!ep || busy || !free()) return;
    void launcher.play(ep.id, { seriesId: seriesId() });
  };

  const actions = () => [
    ...seriesActions({ loaded: loaded(), primary: view()?.primary, favourite: tile()?.favourite === true }),
    ...((view()?.versions.length ?? 0) > 1 ? [{ id: 'versions', label: `Versions (${view()!.versions.length})`, width: 240 }] : []),
    ...(view()?.split ? [{ id: 'combine', label: 'Combine again', width: 260 }] : []),
  ];
  const onAction = async (id: string) => {
    userPressed = true;
    if (busy || !free()) return;
    busy = true;
    try {
      if (id === 'play') {
        // A press before the view has loaded waits for it, then plays the primary.
        await playSeriesPrimary({
          seriesId: params.id,
          view: () => (loaded() ? view() : undefined),
          load: loadedView,
          still: () => alive && free(),
          launcher,
          noPrimary: () => undefined,
        });
      } else if (id === 'fav') {
        const t = tile();
        if (t) await fav.toggle(t);
      } else if (id === 'versions') {
        openVersions();
      } else if (id === 'combine') {
        await api.setVodSplit(params.id, false).catch((err: unknown) => console.warn('Combine failed', errName(err)));
        if (alive) await load();
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
    onChanged: () => { if (alive) void load(); },
  });
  const openMenu = (col: number) => {
    const ep = episodes()[col];
    if (!ep || !free()) return true;
    menu.openEpisode(ep, seriesId());
    return true;
  };

  /** Pointer: a tab click shows that season at once. */
  const clickTab = (i: number) => {
    userPressed = true;
    if (!free()) return;
    setTabSel(i);
    showSeason(i);
    focusArea('seasons');
  };
  const clickCard = (col: number, options: boolean) => {
    userPressed = true;
    if (!free()) return;
    setEpCol(col);
    focusArea('episodes');
    if (options) openMenu(col);
    else playEpisode(col);
  };

  // ---- Versions list ----
  const [picking, setPicking] = createSignal(false);
  let pickerNode: ElementNode | undefined;
  let removePicker: (() => void) | undefined;
  const openVersions = () => {
    if ((view()?.versions.length ?? 0) < 2) return;
    setPicking(true);
    removePicker = router.pushOverlay(VERSIONS_ID, closeVersions);
    queueMicrotask(() => { if (alive) pickerNode?.setFocus(); });
  };
  function closeVersions() {
    removePicker = undefined;
    setPicking(false);
    queueMicrotask(() => { if (alive) focusArea('actions', true); });
  }
  const pickVersion = async (row: PickerRow) => {
    removePicker?.();
    closeVersions();
    if (row.kind === 'new') {
      await api.setVodSplit(params.id, true).catch((err: unknown) => console.warn('Split failed', errName(err)));
    } else {
      // Remembered, so the card and Play open this version from now on; the seasons shown switch to it.
      await api.pickVodVersion(params.id, row.id).catch((err: unknown) => console.warn('Pick failed', errName(err)));
      setVersionId(row.id);
    }
    if (alive) await load();
  };

  onMount(() => {
    void load();
    actionsNode?.setFocus();
  });
  onCleanup(() => {
    alive = false;
    clearRest();
    removePicker?.();
  });

  const backdrop = () => detail()?.backdrop;
  /** The load failed or found nothing (the hero keeps the tile's fields), or the source has no detail for it. */
  const notAvailable = () => loaded() && (loadFailed() || view() === undefined || view()!.detail === null);
  const meta = () => {
    const v = view();
    if (v) return [seriesMeta(v), versionsBadge(v.tile.quality, v.versions)].filter(Boolean).join(' · ');
    return metaLine({ year: tile()?.year, rating: tile()?.rating });
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={BG} onBack={() => { router.back(); return true; }}
      onCaptureKey={(e: KeyboardEvent) => { if (!e.repeat) userPressed = true; return false; }}>
      <DetailBackdrop url={backdrop()} />
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
      <Show when={picking()}>
        <ListPicker ref={(el) => { pickerNode = el; }} title="Versions" rows={versionRows(view()?.versions ?? [], view()?.versionId)}
          onPick={(row) => void pickVersion(row)} hint="Ok shows its episodes · Back closes" />
      </Show>
    </View>
  );
}
