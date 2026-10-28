import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createEffect, createMemo, onCleanup, onMount } from 'solid-js';
import type { SeriesView } from '@iptv/app-api';
import { VOD_ROW_CONTINUE } from '@iptv/app-api';
import { VOD_ALL } from '@iptv/core';
import { api, onEvent } from '../api.ts';
import { VOD_COPY } from '../copy.ts';
import { DropdownHeader } from '../components/DropdownHeader.tsx';
import { InfoBlock } from '../components/InfoBlock.tsx';
import { INFO_STRIP } from '../components/infoBlockLogic.ts';
import { Row } from '../components/Row.tsx';
import { SlidingRows } from '../components/SlidingRows.tsx';
import { useRowColumn } from '../components/rowColumn.ts';
import { parkLiveForScreen } from '../playback/parkLiveForScreen.ts';
import { BOTTOM_ROW_Y, screenOverlayOpen } from '../shell/logic.ts';
import { focusRailCollapsed, Rail } from '../shell/Rail.tsx';
import { goRail } from '../shell/railNav.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, SPACE, STRONG, TYPE } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { HOME_POLL_MS, homePollNeeded, moveBrowse, skeletonRows, wheelKey } from '../vod/browseLogic.ts';
import { greenOpensGrid, type BrowseArea } from '../vod/browseNavLogic.ts';
import { Backdrop } from '../vod/Backdrop.tsx';
import { createVodLauncher } from '../vod/launch.ts';
import { createPosterMenu } from '../vod/PosterMenu.tsx';
import { POSTER_H } from '../vod/posterLogic.ts';
import { vodStatusLine } from '../vod/kindCopy.ts';
import { tabOfKind } from '../vod/tabLogic.ts';
import { BrowseStatus } from './vodBrowse/BrowseStatus.tsx';
import { createBrowseData, type BrowseShown } from './vodBrowse/createBrowseData.ts';
import { createBrowseHero } from './vodBrowse/createBrowseHero.ts';
import { createBrowseState } from './vodBrowse/createBrowseState.ts';
import { createCategorySheet } from './vodBrowse/createCategorySheet.tsx';

/**
 * Layout (1080p design space, UI revamp §2.2), like Start's: the info strip at the top for the focused title, the
 * "All categories ▾" header at the top right, and the poster rows from y 262 at x 160. The focused row sits on top;
 * the next shows in full and a third peeks in (`rowSlots`; the column slides a row at a time, `useRowColumn`).
 */
const ROW_X = LAYOUT.contentX;
const ROW_Y = 262;
const LABEL_H = 42;
const ROW_GAP = SPACE.l;
/** A row below the focused one is drawn while at least its title and a strip of it fit on screen. */
const ROW_PEEK = LABEL_H + 20;
/** The rows' clip edge: a row sliding out upwards disappears here, just above the focused row's title. */
const CLIP_Y = ROW_Y - 8;
const ROW_H = LABEL_H + POSTER_H;
/** A row's title line: a long category name (fed by the source's own names) ends inside the safe area. */
const ROW_TITLE_W = LAYOUT.width - LAYOUT.safeX - ROW_X;
const BG = COLORS.background;
/** Skeleton rows (first load): where the rows go, ending a gap above the pointer-mode bottom row. */
const SKELETONS = skeletonRows({ x: ROW_X, top: ROW_Y, bottom: BOTTOM_ROW_Y - LAYOUT.gap }, 3, 8);

type Area = BrowseArea;

/**
 * Movies or Series browse (`params.kind`): the rail, an info strip and backdrop for the focused title, the "All
 * categories ▾" header (its picker opens the grid on a category; Green opens it on All) and poster rows (Continue
 * watching, Favourites, Recently added, categories). The state lives in `vodBrowse/createBrowseState.ts`, the reads in
 * `createBrowseData.ts`, the strip's detail in `createBrowseHero.ts` and the categories sheet in
 * `createCategorySheet.tsx`; this component owns the focus, the keys, the lifecycle and the drawing.
 */
export function VodBrowseScreen(props: { entry: ScreenEntry }) {
  const st = createBrowseState(props.entry);
  const { kind, copy, startOnRail, sourceId, rows, focus, area, setArea, hero, hasHeader, focusedCell, focusedTile, stripTile, remember, status } = st;
  let railNode: ElementNode | undefined;
  let headerNode: ElementNode | undefined;
  let rowsNode: ElementNode | undefined;
  let errorNode: ElementNode | undefined;
  let wheelNode: ElementNode | undefined;
  let alive = true;
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

  /** 'rows' falls back to the Try again button (error), then the header, then the rail; 'header' to the rows. */
  const focusArea = (a: Area) => {
    if (!restoring) preferredArea = a;
    fallbackArea = undefined;
    const asked = a;
    if (a === 'header' && !hasHeader()) a = 'rows';
    if (a === 'rows' && rows().length === 0) {
      if (st.home()?.status === 'error' && errorNode) {
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
  /** Focus on the area the user chose, as the screen's own move (not a new choice). */
  const restorePreferred = () => {
    restoring = true;
    try { focusArea(preferredArea); } finally { restoring = false; }
  };

  // ---- data ----

  /** After a load: put focus back on what the user chose, only when this load may have unmounted the focused view. */
  const restoreFocus = (before: BrowseShown) => {
    queueMicrotask(() => {
      if (!alive || screenOverlayOpen() || menu.isOpen()) return;
      const changed = before.status !== status() || before.hasRows !== (rows().length > 0) || before.hasHeader !== hasHeader();
      if (!changed) return;
      restorePreferred();
    });
  };
  const data = createBrowseData(st, { alive: () => alive, restoreFocus, syncHero: () => heroPart.syncHero() });
  const { load, loadNear } = data;
  const heroPart = createBrowseHero(st, () => alive);
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
  // Back to the area the user chose: `area` may sit on a fallback (the rail while there were no rows).
  const menu = createPosterMenu({
    refocus: () => focusArea(preferredArea),
    onChanged: () => void load(),
    play: {
      launcher,
      // A series plays its primary episode: the strip's loaded view when it is that title's, else loaded on demand.
      seriesView: (id) => (kind === 'series' && hero()?.tile.id === id ? (hero() as SeriesView) : undefined),
      onSeriesView: (v) => { if (alive && focusedTile()?.id === v.tile.id) st.setHero(v); },
      still: (id) => focusedTile()?.id === id,
    },
  });
  const openMenu = () => {
    const t = focusedTile();
    if (t) menu.open(t, rows()[focus().row]?.id === VOD_ROW_CONTINUE);
    return true;
  };

  // ---- category picker: other countries fold into one row (spec 2026-10-22-your-countries-flags) ----
  const categorySheet = createCategorySheet({
    alive: () => alive, kind, copy, categories: st.categories, hasHeader, menuOpen: menu.isOpen, focusHeader: () => { focusArea('header'); },
  });

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    if (key === 'left' && focus().col === 0) return focusArea('rail');
    const r = moveBrowse(rows(), focus(), key, st.memory().cols);
    // Up from the top row: the header (when there is one).
    if ('edge' in r) return hasHeader() ? focusArea('header') : true;
    const cur = focus();
    if (r.focus.row === cur.row && r.focus.col === cur.col) {
      if (focusedCell()?.kind === 'loading') void loadNear();
      return true;
    }
    st.setFocus(r.focus);
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
        data.restart();
        launcher.cancel();
        st.setSourceId(ev.activeSourceId);
        st.switchMemory();
        batch(() => {
          st.setRows([]);
          st.setCats([]);
          st.setHome(undefined);
          st.setHero(undefined);
          st.setFocus({ row: st.memory().focus.row, col: st.memory().focus.col });
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
    else if (st.warmStart) restorePreferred();
  });
  onCleanup(() => { alive = false; categorySheet.cleanup(); });

  // ---- view ----

  // A first load that never reports back (a lost `vodRefreshed`) must not strand the screen on "Loading…".
  // Driven by a memo so a home update that keeps the status does not restart the interval; one request at a time.
  const homeStatus = createMemo(() => st.home()?.status);
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
    if (s === 'error') return st.home()?.error?.message ?? copy.loadError;
    return '';
  };
  const statusLine = () => vodStatusLine(st.home());
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
    if (from) st.memory().cols.set(from.id, focus().col);
    const to = rows()[row];
    if (to) st.memory().cols.set(to.id, col);
    st.setFocus({ row, col });
    onFocusMoved();
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={BG} onBack={back}
      onGreen={() => (greenOpensGrid(status()) ? openGrid(VOD_ALL) : true)}
      onYellow={() => { router.push('search'); return true; }} onBlue={() => { router.push('settings'); return true; }}>
      <Backdrop url={heroPart.shownArt()} area="strip" />
      <Rail ref={(el) => { railNode = el; }} active={tabOfKind(kind)} onSelect={(t) => goRail(tabOfKind(kind), t, () => router.back({ fromVod: true }))}
        onRight={() => focusArea(rows().length > 0 ? 'rows' : 'header')} onFocusChanged={(f) => { if (f) choose('rail'); }} />
      {/* The catalogue status while there is one, else the plot. */}
      <InfoBlock x={INFO_STRIP.x} y={INFO_STRIP.y} width={INFO_STRIP.w} title={stripTile()?.title ?? ''} meta={heroPart.stripMeta() || undefined}
        description={statusLine() || heroPart.heroDetail()?.plot} fadeOnTitle />
      <Show when={hasHeader()}>
        {/* Above the backdrop's scrims (zIndex 1). */}
        <View zIndex={4}>
          <DropdownHeader ref={(el) => { headerNode = el; }} x={LAYOUT.width - LAYOUT.safeX} y={LAYOUT.safeY} align="right"
            size={TYPE.body} label={VOD_COPY.allCategories} onPress={categorySheet.openCategories}
            onDown={() => focusArea('rows')} onLeft={() => focusArea('rail')} onFocusChanged={(f) => { if (f) choose('header'); }} />
        </View>
      </Show>

      <Show when={status() === 'ready'} fallback={
        <BrowseStatus x={ROW_X} y={ROW_Y} status={status()} message={message()} rowCount={rows().length} skeletons={SKELETONS}
          errorRef={(el) => { errorNode = el; }} onLeft={() => focusArea('rail')}
          onRetry={() => void api.refreshVod(kind).catch(() => undefined).then(() => load())}
          onRetryUp={() => focusArea(hasHeader() ? 'header' : 'rail')} />
      }>
        {/* Rows: the focused row sits on top, the rows after it below. One focusable node owns the keys. */}
        {/* The rows sit at fixed y's in one column that slides (a row sliding out is clipped under the strip). */}
        <SlidingRows ref={(el) => { rowsNode = el; }} wheelRef={(el) => { wheelNode = el; }} column={column} top={ROW_Y} clipTop={CLIP_Y}
          onFocusChanged={(f: boolean) => { if (f) choose('rows'); }}
          onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')}
          onEnter={openCell} onMenu={openMenu} onLongOk={openMenu}>{(i) => {
            const r = () => rows()[i]!;
            return (
              <>
                <Text x={ROW_X} y={0} width={ROW_TITLE_W} maxWidth={ROW_TITLE_W} contain="width" maxLines={1} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{r().title}</Text>
                <Row x={ROW_X} y={LABEL_H} width={LAYOUT.width - ROW_X} content={{ variant: 'poster', row: r() }}
                  focusCol={i === focus().row ? focus().col : undefined} lit={area() === 'rows' && i === focus().row}
                  onCellClick={(c) => { pointTo(i, c); focusArea('rows'); openCell(); }}
                  onCellOptions={(c) => { pointTo(i, c); openMenu(); }} onWheel={onWheel} />
              </>
            );
          }}</SlidingRows>
      </Show>
      {/* Above the rail (zIndex 50), so the menu's scrim dims it too. */}
      <View zIndex={60}><menu.View /></View>
      <categorySheet.View />
    </View>
  );
}
