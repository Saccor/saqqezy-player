import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { MovieView, VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { FAV_COPY } from '../copy.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { ListPicker } from '../components/ListPicker.tsx';
import { POSTER_H } from '../components/PosterTile.tsx';
import { PosterRow } from '../components/PosterRow.tsx';
import { pointerMode } from '../input/pointer.ts';
import { screenOverlayOpen } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { moveBrowse, type RowModel } from '../vod/browseLogic.ts';
import { createVodLauncher } from '../vod/launch.ts';
import { minutesLeft, resumeBarShown, titleLengthMs } from '../vod/vodPlayerLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { metaLine } from '../vod/posterLogic.ts';
import { Backdrop } from '../vod/Backdrop.tsx';
import { iconTexture } from '../vod/icons.ts';
import { joinMeta } from '../vod/stripLogic.ts';
import { createFavToggle } from '../vod/favToggle.ts';
import { versionRows, withLanguages } from '../vod/versionsLogic.ts';
import type { PickerRow } from './homeMenuLogic.ts';

const VERSIONS_ID = 'movie-versions';

const BG = COLORS.background;
const INFO_X = LAYOUT.safeX;
const INFO_W = 980;
const TITLE_Y = 150;
const META_Y = 236;
const PLOT_Y = 280;
const CREDITS_Y = 410;
const ACTIONS_Y = 520;
const RESUME_Y = ACTIONS_Y + 92;
const MORE_LABEL_Y = 694;
/** Pointer mode: 50 px higher, so the shell's Back button (978–1026, bottom left) never covers the first poster. */
const MORE_LABEL_Y_POINTER = 644;
const FAV_W = 64;

type Area = 'actions' | 'more';

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

/** Movie detail: backdrop, title, meta, plot, credits, pill actions and More like this. */
export function MovieDetailScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { id: string; tile?: VodTile };
  const [view, setView] = createSignal<MovieView | undefined>(undefined);
  const [loaded, setLoaded] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [moreCol, setMoreCol] = createSignal(0);
  const [area, setArea] = createSignal<Area>('actions');
  const moreY = () => (pointerMode() ? MORE_LABEL_Y_POINTER : MORE_LABEL_Y);
  let actionsNode: ElementNode | undefined;
  let moreNode: ElementNode | undefined;
  let alive = true;
  /** Bumped by every load; an answer from an older load never writes state. */
  let gen = 0;
  let busy = false;
  const launcher = createVodLauncher({
    alive: () => alive,
    overlayOpen: screenOverlayOpen,
    // Once the view is loaded, Play and the Versions list name the exact version; before, the card plays Play's pick.
    getPlayable: (id) => api.getVodPlayable(id, undefined, view() !== undefined),
    push: (playable, fromStart) => router.push('vodPlay', { playable, fromStart }),
    toast: showToast,
  });
  const cols = new Map<string, number>();

  const fav = createFavToggle({
    alive: () => alive,
    reload: () => load(false),
    setFavourite: (id, on) => api.setVodFavourite(id, on),
    toast: showToast,
  });
  const tile = (): VodTile | undefined => fav.apply(view()?.tile ?? params.tile);
  const detail = () => view()?.detail ?? undefined;
  const moreRow = createMemo((): RowModel => ({ id: 'more', title: '', total: view()?.more.length ?? 0, items: view()?.more ?? [], loaded: true }));

  /** No overlay or poster menu is open (a key or click behind one must not act). */
  const free = () => !screenOverlayOpen() && !menu.isOpen();

  /** Focuses an area. A refocus (`fallback`) lands on the actions when the More row is gone; a Down press just stays. */
  const focusArea = (a: Area, fallback = false) => {
    if (a === 'more' && moreRow().items.length === 0) {
      if (!fallback) return true;
      a = 'actions';
    }
    setArea(a);
    (a === 'actions' ? actionsNode : moreNode)?.setFocus();
    return true;
  };

  /** After a reload the focused view may have unmounted (the More row emptied): keep focus on a live node. */
  const settleFocus = () => queueMicrotask(() => {
    if (!alive || screenOverlayOpen() || menu.isOpen()) return;
    if (area() !== 'more') return;
    setMoreCol((c) => Math.max(0, Math.min(c, moreRow().items.length - 1)));
    if (moreRow().items.length === 0) focusArea('actions');
  });

  const load = async (first: boolean) => {
    const g = ++gen;
    let v: MovieView | undefined;
    let failed = false;
    try {
      v = await api.getMovie(params.id);
    } catch (err) {
      console.warn('Movie load failed', errName(err));
      failed = true;
    }
    if (!alive || g !== gen) return;
    if (v || first) setView(v);
    if (first || v) setLoadFailed(failed);
    if (v) fav.clear();
    setLoaded(true);
    settleFocus();
  };

  const resumeMs = () => view()?.resumeMs ?? 0;
  const durationMs = () => titleLengthMs(resumeMs(), tile()?.progress, detail()?.runtimeMin);
  const fraction = () => (durationMs() > 0 ? Math.max(0, Math.min(1, resumeMs() / durationMs())) : 0);
  const actions = () => [
    ...(resumeMs() > 0
      ? [{ id: 'play', label: 'Resume', width: 220 }, { id: 'start', label: 'From start', width: 220 }]
      : [{ id: 'play', label: 'Play', width: 180 }]),
    ...((view()?.versions.length ?? 0) > 1 ? [{ id: 'versions', label: `${view()!.versions.length} versions`, width: 220 }] : []),
    ...(view()?.split ? [{ id: 'combine', label: 'Combine again', width: 260 }] : []),
    { id: 'fav', label: tile()?.favourite ? FAV_COPY.in : FAV_COPY.add, width: FAV_W, round: true,
      icon: iconTexture(tile()?.favourite ? 'heartFilled' : 'heart') },
  ];
  const onAction = async (id: string) => {
    const t = tile();
    if (!t || busy || !free()) return;
    busy = true;
    try {
      const playId = view()?.playId ?? t.id;
      if (id === 'play') {
        await launcher.play(playId);
      } else if (id === 'start') {
        await launcher.play(playId, { fromStart: true });
      } else if (id === 'fav') {
        await fav.toggle(t);
      } else if (id === 'versions') {
        openVersions();
      } else if (id === 'combine') {
        await api.setVodSplit(t.id, false).catch((err: unknown) => console.warn('Combine failed', errName(err)));
        if (alive) await load(false);
      }
    } finally {
      busy = false;
    }
  };
  const moveMore = (key: 'up' | 'down' | 'left' | 'right') => {
    if (key === 'up') return focusArea('actions');
    if (key === 'down') return true;
    const r = moveBrowse([moreRow()], { row: 0, col: moreCol() }, key, cols);
    if ('focus' in r) setMoreCol(r.focus.col);
    return true;
  };
  const openMore = () => {
    if (!free()) return true;
    const t = moreRow().items[moreCol()];
    if (t) router.replace('movieDetail', { id: t.id, tile: t });
    return true;
  };
  /** The area the menu was opened from (it only opens on the More row); Cancel returns there. */
  let menuArea: Area = 'more';
  const menu = createPosterMenu({
    refocus: () => { if (alive) focusArea(menuArea, true); },
    onChanged: () => { if (alive) void load(false); },
    // Play from the menu shares this screen's launcher (one press at a time).
    play: { launcher },
  });
  const openMenu = (col: number) => {
    const t = moreRow().items[col];
    if (!t) return true;
    menuArea = area();
    menu.open(t, false);
    return true;
  };

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
    queueMicrotask(() => { if (alive) focusArea('actions'); });
  }
  const dismissVersions = () => {
    removePicker?.();
    closeVersions();
  };
  const pickVersion = async (row: PickerRow) => {
    const t = tile();
    dismissVersions();
    if (!t) return;
    if (row.kind === 'new') {
      await api.setVodSplit(t.id, true).catch((err: unknown) => console.warn('Split failed', errName(err)));
      if (alive) await load(false);
      return;
    }
    if (row.kind === 'heading') return;
    // Remembered first, so Play and the card pick this version from now on.
    await api.pickVodVersion(t.id, row.id).catch((err: unknown) => console.warn('Pick failed', errName(err)));
    if (!alive) return;
    await launcher.play(row.id);
    if (alive) void load(false);
  };

  onMount(() => {
    void load(true);
    actionsNode?.setFocus();
  });
  onCleanup(() => {
    alive = false;
    removePicker?.();
  });

  const backdrop = () => detail()?.backdrop;
  const notAvailable = () => loaded() && (loadFailed() || (view() !== undefined && view()!.detail === null));

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={BG} onBack={() => { router.back(); return true; }}>
      <Backdrop url={backdrop()} area="detail" />
      <View zIndex={2}>

      <Text x={INFO_X} y={TITLE_Y} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={TYPE.hero} {...STRONG}
        color={COLORS.text}>{tile()?.title ?? ''}</Text>
      <Text x={INFO_X} y={META_Y} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>
        {joinMeta(metaLine({ year: tile()?.year, runtimeMin: detail()?.runtimeMin, genre: detail()?.genre, ageRating: detail()?.ageRating, rating: tile()?.rating }), tile()?.quality)}
      </Text>
      <Text x={INFO_X} y={PLOT_Y} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={3} lineHeight={38} fontSize={TYPE.body}
        color={COLORS.textSecondary}>{notAvailable() ? 'Details are not available right now.' : detail()?.plot ?? ''}</Text>
      <Show when={detail()?.director || detail()?.cast}>
        <Text x={INFO_X} y={CREDITS_Y} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>
          {joinMeta(detail()?.director ? `Director ${detail()!.director}` : undefined, detail()?.cast ? `With ${detail()!.cast}` : undefined)}
        </Text>
      </Show>
      <ActionBar ref={(el) => { actionsNode = el; }} x={INFO_X} y={ACTIONS_Y} actions={actions()} onAction={(id) => void onAction(id)}
        onDown={() => focusArea('more')} onFocusChanged={(f) => { if (f) setArea('actions'); }} />
      {/* Only with a known length: the bar and the minutes left would be guesses otherwise. */}
      <Show when={resumeBarShown(resumeMs(), durationMs())}>
        <View x={INFO_X} y={RESUME_Y} width={220} height={4} borderRadius={2} color={COLORS.track}>
          <View width={Math.round(220 * fraction())} height={4} borderRadius={2} color={COLORS.accent} />
        </View>
        <Text x={INFO_X + 236} y={RESUME_Y - 12} fontSize={TYPE.meta} color={COLORS.muted}>{minutesLeft(resumeMs(), durationMs())}</Text>
      </Show>

      <Show when={moreRow().items.length > 0}>
        <Text x={LAYOUT.safeX} y={moreY()} width={LAYOUT.width - LAYOUT.safeX * 2} maxWidth={LAYOUT.width - LAYOUT.safeX * 2} contain="width"
          maxLines={1} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>More like this</Text>
        <View ref={(el) => { moreNode = el; }} y={moreY() + 44} width={LAYOUT.width} height={POSTER_H}
          onFocusChanged={(f: boolean) => { if (f) setArea('more'); }}
          onUp={() => moveMore('up')} onDown={() => moveMore('down')} onLeft={() => moveMore('left')} onRight={() => moveMore('right')}
          onEnter={openMore} onMenu={() => openMenu(moreCol())} onLongOk={() => openMenu(moreCol())}>
          <PosterRow x={INFO_X} y={0} width={LAYOUT.width - LAYOUT.safeX} row={moreRow()} focusCol={moreCol()} lit={area() === 'more'}
            onCellClick={(c) => { setMoreCol(c); openMore(); }} onCellOptions={(c) => { setMoreCol(c); openMenu(c); }} />
        </View>
      </Show>
      </View>
      <View zIndex={5}><menu.View /></View>
      <Show when={picking()}>
        <ListPicker ref={(el) => { pickerNode = el; }} title="Versions" rows={versionRows(view()?.versions ?? [], view()?.playId)}
          onPick={(row) => void pickVersion(row)} hint="Ok plays · Back closes" />
      </Show>
    </View>
  );
}
