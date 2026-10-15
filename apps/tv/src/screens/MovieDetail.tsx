import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { MovieView, VodPlayable, VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { POSTER_H, PosterTile, posterCache } from '../components/PosterTile.tsx';
import { PosterRow } from '../components/PosterRow.tsx';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { moveBrowse, type RowModel } from '../vod/browseLogic.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { metaLine } from '../vod/posterLogic.ts';
import { scrimTexture } from '../vod/scrim.ts';

const BG = COLORS.background;
/** The background colour without alpha (0xRRGGBB), for the fade textures. */
const BG_RGB = Math.floor(COLORS.background / 0x100);
const POSTER_X = LAYOUT.safeX;
const POSTER_Y = 150;
const BIG_W = 320;
const BIG_H = 480;
const INFO_X = POSTER_X + BIG_W + 56;
const INFO_W = LAYOUT.width - LAYOUT.safeX - INFO_X;
const MORE_LABEL_Y = 740;
const CANT_PLAY = "This video can't play on this device.";

type Area = 'actions' | 'more';

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

/** Movie detail: poster, backdrop, title, meta, plot, director and cast, Play and Favourite, and More in <category>. */
export function MovieDetailScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { id: string; tile?: VodTile };
  const [view, setView] = createSignal<MovieView | undefined>(undefined);
  const [loaded, setLoaded] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [catName, setCatName] = createSignal('');
  const [moreCol, setMoreCol] = createSignal(0);
  const [area, setArea] = createSignal<Area>('actions');
  let actionsNode: ElementNode | undefined;
  let moreNode: ElementNode | undefined;
  let alive = true;
  /** Bumped by every load; an answer from an older load never writes state. */
  let gen = 0;
  /** Bumped by every Play press; a late playable for an older press is dropped. */
  let playGen = 0;
  let busy = false;
  const cols = new Map<string, number>();

  /** Set after a successful toggle; a failed reload then still shows the right state. Cleared when a reload lands. */
  const [favOverride, setFavOverride] = createSignal<boolean | undefined>(undefined);
  const baseTile = () => view()?.tile ?? params.tile;
  const tile = (): VodTile | undefined => {
    const t = baseTile();
    const f = favOverride();
    return t && f !== undefined ? { ...t, favourite: f } : t;
  };
  const detail = () => view()?.detail ?? undefined;
  const moreRow = createMemo((): RowModel => ({ id: 'more', title: '', total: view()?.more.length ?? 0, items: view()?.more ?? [], loaded: true }));

  /** No overlay or poster menu is open (a key or click behind one must not act). */
  const free = () => router.topOverlay() === undefined && !menu.isOpen();

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
    if (!alive || router.topOverlay() !== undefined || menu.isOpen()) return;
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
    if (v) setFavOverride(undefined);
    setLoaded(true);
    settleFocus();
    if (v && catName() === '') {
      let name = '';
      try {
        name = (await api.getVodCategories('movie')).find((c) => c.id === v.tile.categoryId)?.name ?? '';
      } catch (err) {
        console.warn('Categories load failed', errName(err));
      }
      if (alive && g === gen) setCatName(name);
    }
  };

  const actions = () => [
    { id: 'play', label: 'Play', width: 220 },
    { id: 'fav', label: tile()?.favourite ? 'In favourites' : 'Add to favourites', width: 320 },
  ];
  const onAction = async (id: string) => {
    const t = tile();
    if (!t || busy || !free()) return;
    busy = true;
    try {
      if (id === 'play') {
        const mine = ++playGen;
        let p: VodPlayable | undefined;
        try {
          p = await api.getVodPlayable(t.id);
        } catch (err) {
          console.warn('Play failed', errName(err));
          if (alive && mine === playGen) showToast(CANT_PLAY);
          return;
        }
        if (!alive || mine !== playGen || router.topOverlay() !== undefined) return;
        if (p) router.push('vodPlay', { playable: p });
        else showToast(CANT_PLAY);
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
  });
  const openMenu = (col: number) => {
    const t = moreRow().items[col];
    if (!t) return true;
    menuArea = area();
    menu.open(t, false);
    return true;
  };

  onMount(() => {
    void load(true);
    actionsNode?.setFocus();
  });
  onCleanup(() => { alive = false; });

  const backdrop = () => detail()?.backdrop;
  const notAvailable = () => loaded() && (loadFailed() || (view() !== undefined && view()!.detail === null));

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

      <PosterTile x={POSTER_X} y={POSTER_Y} w={BIG_W} h={BIG_H} tile={tile()} lit={false} />
      <Text x={INFO_X} y={POSTER_Y} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={64} color={COLORS.text}>{tile()?.title ?? ''}</Text>
      <Text x={INFO_X} y={POSTER_Y + 86} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.text}>
        {metaLine({ year: tile()?.year, runtimeMin: detail()?.runtimeMin, genre: detail()?.genre, ageRating: detail()?.ageRating, rating: tile()?.rating })}
      </Text>
      <Text x={INFO_X} y={POSTER_Y + 136} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={4} fontSize={FONT.body} color={COLORS.muted}>
        {notAvailable() ? 'Details are not available right now.' : detail()?.plot ?? ''}
      </Text>
      <Show when={detail()?.director}>
        <Text x={INFO_X} y={POSTER_Y + 296} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>
          {`Director: ${detail()?.director ?? ''}`}
        </Text>
      </Show>
      <Show when={detail()?.cast}>
        <Text x={INFO_X} y={POSTER_Y + 332} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>
          {`Cast: ${detail()?.cast ?? ''}`}
        </Text>
      </Show>
      <ActionBar ref={(el) => { actionsNode = el; }} x={INFO_X} y={POSTER_Y + 392} actions={actions()} onAction={(id) => void onAction(id)}
        onDown={() => focusArea('more')} onFocusChanged={(f) => { if (f) setArea('actions'); }} />

      <Show when={moreRow().items.length > 0}>
        <Text x={LAYOUT.safeX} y={MORE_LABEL_Y} fontSize={FONT.heading} color={COLORS.text}>{catName() ? `More in ${catName()}` : 'More like this'}</Text>
        <View ref={(el) => { moreNode = el; }} y={MORE_LABEL_Y + 44} width={LAYOUT.width} height={POSTER_H}
          onFocusChanged={(f: boolean) => { if (f) setArea('more'); }}
          onUp={() => moveMore('up')} onDown={() => moveMore('down')} onLeft={() => moveMore('left')} onRight={() => moveMore('right')}
          onEnter={openMore} onMenu={() => openMenu(moreCol())} onLongOk={() => openMenu(moreCol())}>
          <PosterRow x={LAYOUT.safeX} y={0} width={LAYOUT.width - LAYOUT.safeX} row={moreRow()} focusCol={moreCol()} lit={area() === 'more'}
            onCellClick={(c) => { setMoreCol(c); openMore(); }} onCellOptions={(c) => { setMoreCol(c); openMenu(c); }} />
        </View>
      </Show>
      </View>
      <View zIndex={5}><menu.View /></View>
    </View>
  );
}
