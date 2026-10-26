import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { SeriesView, VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { VOD_COPY } from '../copy.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { fromPickerRow } from '../components/sheetLogic.ts';
import { EP_ROW_H, EpisodeRow } from '../components/EpisodeRow.tsx';
import { DropdownHeader } from '../components/DropdownHeader.tsx';
import { moveFocus } from '../components/virtualWindow.ts';
import { screenOverlayOpen } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { Backdrop } from '../vod/Backdrop.tsx';
import { iconTexture } from '../vod/icons.ts';
import { joinMeta } from '../vod/stripLogic.ts';
import { createFavToggle } from '../vod/favToggle.ts';
import { createVodLauncher, playSeriesPrimary } from '../vod/launch.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { metaLine } from '../vod/posterLogic.ts';
import {
  fallbackArea, moveArea, refocus, remountRestore, restoreFocusMove, seasonLabel, seriesActions, seriesMeta, type SavedFocus, type SeriesAction, type SeriesArea,
} from '../vod/seriesDetailLogic.ts';
import { versionRows, withLanguages } from '../vod/versionsLogic.ts';
import type { PickerRow } from './homeMenuLogic.ts';

const VERSIONS_ID = 'series-versions';
const SEASONS_ID = 'series-seasons';

const BG = COLORS.background;
const HERO_X = LAYOUT.safeX;
const HERO_W = 980;
const TITLE_Y = 150;
const META_Y = 236;
const PLOT_Y = 280;
const CREDITS_Y = 410;
const ACTIONS_Y = 520;
const SEASON_Y = 612;
const ROW_Y = 690;
const FAV_W = 64;
const ROW_W = LAYOUT.width - LAYOUT.safeX;

type Area = SeriesArea;

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

/**
 * Series detail: backdrop, title, meta and plot, the primary episode button and Favourite, the season dropdown, and a row of
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
  /** The season whose episodes are listed. */
  const [season, setSeason] = createSignal(0);
  const [epCol, setEpCol] = createSignal(0);
  /** The version the user chose in the Versions list this visit (undefined: the one Play picks). */
  const [versionId, setVersionId] = createSignal<string | undefined>(undefined);
  /** The id episodes play and are marked under: the shown version's. */
  const seriesId = () => view()?.versionId || params.id;
  let actionsNode: ElementNode | undefined;
  let seasonNode: ElementNode | undefined;
  let rowNode: ElementNode | undefined;
  let alive = true;
  /** Bumped by every load; an answer from an older load never writes state. */
  let gen = 0;
  let busy = false;
  /** The user pressed a key (or clicked) since mount: the first load's restore then leaves focus where it is. */
  let userPressed = false;
  const launcher = createVodLauncher({
    alive: () => alive,
    overlayOpen: screenOverlayOpen,
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
  const free = () => !screenOverlayOpen() && !menu.isOpen();

  const showSeason = (i: number) => {
    if (i === season() || !seasons()[i]) return;
    setSeason(i);
    setEpCol(0);
  };

  /** Focuses an area. A refocus (`fallback`) lands on the nearest live area above; a key press into an empty one stays. */
  const focusArea = (want: Area, fallback = false): boolean => {
    const a = fallbackArea(want, { seasons: seasons().length, episodes: episodes().length });
    if (a !== want && !fallback) return true;
    setArea(a);
    (a === 'actions' ? actionsNode : a === 'season' ? seasonNode : rowNode)?.setFocus();
    return true;
  };

  /** After a reload the focused area may have emptied: keep focus on a live node. */
  const settleFocus = () => queueMicrotask(() => {
    if (!alive || screenOverlayOpen() || menu.isOpen()) return;
    if (area() !== 'actions') focusArea(area(), true);
  });

  /** Places the season and episode. First load: `prev` from `remountRestore` (the saved episode, or the primary). A reload keeps the current episode. */
  const place = (v: SeriesView, first: boolean, prev: SavedFocus | undefined) => {
    const pos = refocus(first ? prev : position(), v);
    setSeason(pos.season);
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

  const resuming = () => view()?.primary?.mode === 'continue' && (view()?.primary?.resumeMs ?? 0) > 0;
  const actions = () => {
    const base = seriesActions({ loaded: loaded(), primary: view()?.primary, favourite: tile()?.favourite === true });
    const play = base.filter((a): a is Extract<SeriesAction, { id: 'play' }> => a.id === 'play');
    const fav = base.find((a) => a.id === 'fav')!;
    return [
      ...play,
      ...(resuming() ? [{ id: 'start', label: 'From start', width: 220 }] : []),
      ...((view()?.versions.length ?? 0) > 1 ? [{ id: 'versions', label: `${view()!.versions.length} versions`, width: 220 }] : []),
      ...(view()?.split ? [{ id: 'combine', label: 'Combine again', width: 260 }] : []),
      { ...fav, width: FAV_W, round: true, icon: iconTexture(tile()?.favourite ? 'heartFilled' : 'heart') },
    ];
  };
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
      } else if (id === 'start') {
        const p = view()?.primary;
        if (p) await launcher.play(p.episodeId, { seriesId: seriesId(), fromStart: true });
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

  const counts = () => ({ seasons: seasons().length, episodes: episodes().length });
  const moveEpisodes = (key: 'up' | 'down' | 'left' | 'right') => {
    if (key === 'up') return focusArea(moveArea('episodes', 'up', counts()));
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

  const clickCard = (col: number, options: boolean) => {
    userPressed = true;
    if (!free()) return;
    setEpCol(col);
    focusArea('episodes');
    if (options) openMenu(col);
    else playEpisode(col);
  };

  // ---- Season list ----
  const [pickingSeason, setPickingSeason] = createSignal(false);
  let seasonPickerNode: ElementNode | undefined;
  let removeSeasonPicker: (() => void) | undefined;
  const openSeasons = () => {
    userPressed = true;
    if (!free() || seasons().length === 0) return;
    setPickingSeason(true);
    removeSeasonPicker = router.pushOverlay(SEASONS_ID, closeSeasons);
    queueMicrotask(() => { if (alive) seasonPickerNode?.setFocus(); });
  };
  function closeSeasons() {
    removeSeasonPicker = undefined;
    setPickingSeason(false);
    queueMicrotask(() => { if (alive) focusArea('season', true); });
  }
  const pickSeason = (row: PickerRow) => {
    removeSeasonPicker?.();
    removeSeasonPicker = undefined;
    setPickingSeason(false);
    if (row.kind !== 'list') return;
    showSeason(Number(row.id));
    queueMicrotask(() => { if (alive) focusArea('episodes', true); });
  };
  const seasonRows = (): PickerRow[] => seasons().map((s, i) => ({ kind: 'list', id: String(i), label: seasonLabel(s), checked: i === season() }));
  const seasonSheetRows = createMemo(() => seasonRows().map(fromPickerRow));

  // ---- Versions list ----
  const [picking, setPicking] = createSignal(false);
  let pickerNode: ElementNode | undefined;
  let removePicker: (() => void) | undefined;
  const openVersions = () => {
    const shown = view();
    if (!shown || shown.versions.length < 2) return;
    // Versions whose names give no language: the source's probe data usually does (fills in while the list shows).
    if (shown.versions.some((v) => !v.lang)) {
      api.getVersionLanguages(params.id).then((langs) => {
        const cur = view();
        if (alive && cur && Object.keys(langs).length > 0) setView({ ...cur, versions: withLanguages(cur.versions, langs) });
      }).catch((err) => console.warn('Version languages failed', errName(err)));
    }
    setPicking(true);
    removePicker = router.pushOverlay(VERSIONS_ID, closeVersions);
    queueMicrotask(() => { if (alive) pickerNode?.setFocus(); });
  };
  function closeVersions() {
    removePicker = undefined;
    setPicking(false);
    queueMicrotask(() => { if (alive) focusArea('actions', true); });
  }
  const versionPickRows = createMemo(() => versionRows(view()?.versions ?? [], view()?.versionId));
  const versionSheetRows = createMemo(() => versionPickRows().map(fromPickerRow));
  const pickVersion = async (row: PickerRow) => {
    removePicker?.();
    closeVersions();
    if (row.kind === 'heading') return;
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
    removePicker?.();
    removeSeasonPicker?.();
  });

  const backdrop = () => detail()?.backdrop;
  /** The load failed or found nothing (the hero keeps the tile's fields), or the source has no detail for it. */
  const notAvailable = () => loaded() && (loadFailed() || view() === undefined || view()!.detail === null);
  const meta = () => {
    const v = view();
    return joinMeta(v ? seriesMeta(v) : metaLine({ year: tile()?.year, rating: tile()?.rating }), tile()?.quality);
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={BG} onBack={() => { router.back(); return true; }}
      onCaptureKey={(e: KeyboardEvent) => { if (!e.repeat) userPressed = true; return false; }}>
      <Backdrop url={backdrop()} area="detail" />
      <View zIndex={2}>
        <Text x={HERO_X} y={TITLE_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={TYPE.hero} {...STRONG}
          color={COLORS.text}>{tile()?.title ?? ''}</Text>
        <Text x={HERO_X} y={META_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{meta()}</Text>
        <Text x={HERO_X} y={PLOT_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={3} lineHeight={38} fontSize={TYPE.body}
          color={COLORS.textSecondary}>{notAvailable() ? 'Details are not available right now.' : detail()?.plot ?? ''}</Text>
        <Show when={detail()?.director || detail()?.cast}>
          <Text x={HERO_X} y={CREDITS_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>
            {joinMeta(detail()?.director ? `Director ${detail()!.director}` : undefined, detail()?.cast ? `With ${detail()!.cast}` : undefined)}
          </Text>
        </Show>
        <ActionBar ref={(el) => { actionsNode = el; }} x={HERO_X} y={ACTIONS_Y} actions={actions()} onAction={(id) => void onAction(id)}
          onDown={() => focusArea(moveArea('actions', 'down', counts()))} onFocusChanged={(f) => { if (f) setArea('actions'); }} />

        <Show when={!loaded() || seasons().length > 0}>
          <DropdownHeader ref={(el) => { seasonNode = el; }} x={HERO_X} y={SEASON_Y} size={TYPE.body}
            label={view() && seasons()[season()] ? seasonLabel(seasons()[season()]!) : ''} onPress={openSeasons}
            onUp={() => focusArea('actions')} onDown={() => focusArea('episodes')} onFocusChanged={(f) => { if (f) setArea('season'); }} />
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
      <Show when={pickingSeason()}>
        <Sheet ref={(el) => { seasonPickerNode = el; }} title={VOD_COPY.season} rows={seasonSheetRows()} backLayerId={SEASONS_ID}
          onSelect={(_, i) => { const r = seasonRows()[i]; if (r) pickSeason(r); }} />
      </Show>
      <Show when={picking()}>
        <Sheet ref={(el) => { pickerNode = el; }} title={VOD_COPY.versions} rows={versionSheetRows()} backLayerId={VERSIONS_ID}
          onSelect={(_, i) => { const r = versionPickRows()[i]; if (r) void pickVersion(r); }} />
      </Show>
    </View>
  );
}
