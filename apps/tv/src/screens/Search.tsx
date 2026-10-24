import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { AppEvent } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { KEYBOARD_W, Keyboard } from '../components/Keyboard.tsx';
import { POSTER_H } from '../components/PosterTile.tsx';
import { PosterRow } from '../components/PosterRow.tsx';
import { WIDE_H } from '../components/WideTile.tsx';
import { WideRow } from '../components/WideRow.tsx';
import { devResume } from '../playback/devResume.ts';
import { parkLiveForScreen } from '../playback/parkLiveForScreen.ts';
import { playback } from '../playback/playback.ts';
import { initState } from '../state/appState.ts';
import { liveReturn, liveToRemember } from '../vod/liveReturn.ts';
import { wheelKey } from '../vod/browseLogic.ts';
import { Rail } from '../shell/Rail.tsx';
import { railBelow, type RailId } from '../shell/railLogic.ts';
import { goRailFrom } from '../shell/railNav.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { LIVE_PREVIEW_RECT } from './live/liveLogic.ts';
import {
  FOLDERS_ROW_LABEL, LIVE_ROW_LABEL, NO_ROWS, SEARCH_LIMIT, SEARCH_ROW_ORDER, VOD_ROW_LABEL, channelToPlay, clampSearchFocus,
  createSearchMemory, createSearcher, focusedCell, folderRoute,
  laterRoute, moveSearch, pendingNotes, rerunsSearch, resultsMessage, searchRows, searchingNote, settleFocus, vodRoute, vodRowModel,
  type SearchFocus, type SearchRowArea, type SearchRows, type SearchState,
} from './searchLogic.ts';

const GROUP_ALL = 'all';
const KB_X = LAYOUT.contentX;
const KB_Y = LAYOUT.safeY + 60;
/** Results run right of the keyboard to the right safe edge (x 1000 to 1824). */
const RESULTS_X = KB_X + KEYBOARD_W + LAYOUT.gap * 2;
const RESULTS_W = LAYOUT.width - LAYOUT.safeX - RESULTS_X;
const RESULTS_Y = KB_Y;
const LABEL_H = 42;
const ROW_GAP = 36;
const NOTE_H = 36;
/** Cards fully visible in each row (they fit the 824 px results area). */
const VOD_VISIBLE = 4;
const LIVE_VISIBLE = 2;
const KEYBOARD: SearchFocus = { area: 'keyboard', col: 0 };

type RowArea = SearchRowArea;
const rowHeight = (a: RowArea) => LABEL_H + (a === 'vod' ? POSTER_H : WIDE_H);

/** Kept across visits (each push/pop re-creates the screen), so Back from the Player returns to the same results. */
const memory = createSearchMemory();

/**
 * Search: the rail, an inline on-screen keyboard, and the results right of it in three rows: "Movies & series"
 * (posters), "Folders" (wide cards for channel folders and movie or series categories) and "Live & guide" (wide cards
 * for channels and programmes). Ok plays the channel, opens the title's detail screen, opens Live TV at a coming-up
 * programme or at a channel folder, or opens a category's grid.
 */
export function SearchScreen(props: { entry: ScreenEntry }) {
  // One-shot seed (a letter typed on Live TV): the field starts with it and the search runs once (onMount). Consumed,
  // so the Player's return to this entry keeps whatever the user typed after it.
  const params = props.entry.params as { query?: unknown };
  if (typeof params.query === 'string') {
    memory.query = params.query;
    memory.returning = false;
  }
  delete params.query;
  /** What is under Search, for the rail (a tab's screen, the library grid over one, or unknown: a tab choice only pops). */
  const below = railBelow(router.below(1), router.below(2));

  const [query, setQuery] = createSignal(memory.query);
  const [state, setState] = createSignal<SearchState<SearchRows>>({ query: '', results: NO_ROWS, busy: false, failed: false });
  const [focus, setFocus] = createSignal<SearchFocus>(KEYBOARD);
  const [rowsFocused, setRowsFocused] = createSignal(false);
  const [onRail, setOnRail] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  let kbNode: ElementNode | undefined;
  let rowsNode: ElementNode | undefined;
  let railNode: ElementNode | undefined;
  let alive = true;
  /** The query of the last settled answer. */
  let settledQuery = '';

  const rows = () => state().results;
  const vodRow = createMemo(() => vodRowModel(rows()));
  const liveRow = createMemo(() => ({ cells: rows().live }));
  const foldersRow = createMemo(() => ({ cells: rows().folders }));

  /** Puts the focus on `f` and moves key focus there (the keyboard or the rows). */
  const place = (f: SearchFocus) => {
    setFocus(f);
    (f.area === 'keyboard' ? kbNode : rowsNode)?.setFocus();
    return true;
  };
  const toRail = () => { railNode?.setFocus(); return true; };

  const searcher = createSearcher<SearchRows>(async (q) => searchRows(await api.search(q, SEARCH_LIMIT)), (s) => {
    if (!alive) return;
    setState(s);
    // While a query runs the previous results stay on screen untouched (focus included).
    if (s.busy) return;
    // Returning from the Player or a detail screen restores the focused cell once the full answer (not a pending one)
    // is in; a re-run of the same query keeps the focused cell; a new query keeps the keyboard.
    const restoring = memory.returning;
    const d = settleFocus({
      rows: s.results, returning: restoring, memory: { area: memory.area, col: memory.col }, current: focus(),
      query: s.query, settledQuery,
    });
    settledQuery = s.query;
    setFocus(d.focus);
    if (d.consumeReturning) memory.returning = false;
    // Key focus moves only for a restore, or when the row under the user emptied; never off the rail or an overlay.
    const move = (restoring && d.focus.area !== 'keyboard') || (d.focus.area === 'keyboard' && rowsFocused());
    if (move) queueMicrotask(() => { if (alive && !onRail() && router.topOverlay() === undefined) place(focus()); });
  }, { empty: NO_ROWS });

  const onChange = (v: string) => {
    memory.returning = false;
    memory.query = v;
    // Typing happens on the keyboard (remote, pointer or a physical keyboard). A physical keyboard can type while the
    // rows hold key focus: move it to the keyboard, so focus never sits on an unlit row.
    if (rowsFocused()) place(KEYBOARD);
    else setFocus(KEYBOARD);
    setQuery(v);
    searcher.setQuery(v);
  };

  /** One D-pad step from the keyboard's edge or within the rows. */
  const step = (from: SearchFocus, key: 'up' | 'down' | 'left' | 'right') => {
    const to = moveSearch(from, key, rows());
    if (to === 'rail') return toRail();
    if (from.area !== 'keyboard') memory.userNavigated();
    return place(to === 'keyboard' ? KEYBOARD : to);
  };
  /** Channel up/down: a page of cards along the focused row. */
  const page = (dir: 1 | -1) => {
    const f = focus();
    if (f.area === 'keyboard') return true;
    memory.userNavigated();
    const per = f.area === 'vod' ? VOD_VISIBLE : LIVE_VISIBLE; // folders use the wide card, like live
    return place(clampSearchFocus({ area: f.area, col: f.col + dir * per }, rows()));
  };
  const onWheel = (dy: number, dx: number) => {
    const key = wheelKey(dy, dx);
    if (!key) return true;
    const f = focus();
    const to = f.area === 'keyboard' ? moveSearch(f, 'right', rows()) : moveSearch(f, key, rows());
    if (typeof to === 'object') { memory.userNavigated(); place(to); }
    return true;
  };

  /**
   * Channels and on-now programmes play the channel; a coming-up programme returns to Live TV at that channel and
   * time; a movie or series opens its detail.
   */
  const open = () => {
    const cell = focusedCell(rows(), focus());
    const vod = vodRoute(cell);
    if (vod) {
      memory.leaveTo(focus());
      // As a Movies or Series tab does on entry: the detail and its player are full screens and a 1 GB TV needs the
      // decoder, so live stops; a channel that plays (or loads) is remembered first and Home resumes it on return.
      liveReturn.remember(liveToRemember(playback.current()?.id, playback.status()?.kind), initState()?.activeSourceId, 'search');
      playback.stop();
      router.push(vod.screen, vod.params);
      return true;
    }
    const later = laterRoute(cell);
    if (later) {
      // Search leaves the stack (as on Back), so the next visit starts fresh. The root Live TV (never a second one)
      // opens at that channel and time.
      memory.leaveBack();
      if (!router.backTo(later.screen, later.params)) router.reset(later.screen, later.params);
      return true;
    }
    const folder = folderRoute(cell);
    if (folder) {
      // A channel folder: back to the root Live TV at that folder (Search leaves the stack, as on Back). A category: the
      // grid of that kind, with Search kept underneath so Back returns to the results.
      if (folder.screen === 'home') {
        memory.leaveBack();
        if (!router.backTo('home', folder.params)) router.reset('home', folder.params);
      } else {
        memory.leaveTo(focus());
        router.push('vodGrid', folder.params);
      }
      return true;
    }
    const ch = channelToPlay(cell);
    if (!ch) return true;
    memory.leaveTo(focus());
    devResume.release(); // the user started a channel (spec §3.1)
    const token = playback.begin();
    void (async () => {
      try {
        const pc = await api.getPlayable(ch.id);
        if (!alive || !pc || !playback.isLatest(token)) return;
        playback.playChannel(pc);
        playback.setRect('fullscreen');
        await api.markWatched(ch.id, GROUP_ALL).catch(() => undefined);
        if (alive && playback.isLatest(token)) router.push('player', { channelId: ch.id, groupId: GROUP_ALL });
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
    return true;
  };
  /** A pointer click on a card: focus it, then open it. */
  const clickCell = (area: RowArea, col: number) => {
    memory.userNavigated();
    place({ area, col });
    open();
  };

  /** A rail choice leaves Search like Back does (the query is forgotten); Search itself returns to the content. */
  const onRailSelect = (id: RailId) => {
    if (id === 'search') { place(clampSearchFocus(focus(), rows())); return; }
    memory.leaveBack();
    goRailFrom('search', below, id, () => router.back({ fromVod: true }));
  };

  onMount(() => {
    onCleanup(visibleInterval(() => setNow(Date.now()), 30_000)); // sleeps while the page is hidden
    // A search index (guide titles, or movies and series) became ready, or a guide import finished (the first one may
    // finish while Search is open): re-run the open query so those results appear. A same-query re-run keeps the focused cell.
    const rerun = (e: unknown) => { if (rerunsSearch(e as AppEvent) && query().trim() !== '') searcher.setQuery(query()); };
    onCleanup(onEvent('searchReady', rerun));
    onCleanup(onEvent('refreshed', rerun));
    // Back from the Player leaves the video fullscreen behind this opaque screen: park it where Home shows it.
    parkLiveForScreen({ preview: LIVE_PREVIEW_RECT });
    kbNode?.setFocus();
    if (memory.query !== '') searcher.setQuery(memory.query);
    else memory.returning = false;
  });
  onCleanup(() => {
    alive = false;
    searcher.dispose();
  });

  /**
   * Drawn rows (an empty row is not drawn), top to bottom. Plain area strings, compared by value: `<For>` keys by
   * identity, so new objects on every busy or settled state would dispose and rebuild the rows and all their tiles
   * on each keystroke (posters flash, low-end TVs churn nodes). Each row's y is computed reactively instead.
   */
  const drawn = createMemo<RowArea[]>(
    () => SEARCH_ROW_ORDER.filter((a) => (a === 'vod' ? rows().vod : a === 'folders' ? rows().folders : rows().live).length > 0),
    [],
    { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) },
  );
  const rowY = (area: RowArea) => {
    let y = RESULTS_Y;
    for (const a of drawn()) {
      if (a === area) return y;
      y += rowHeight(a) + ROW_GAP;
    }
    return y;
  };
  const notesY = () => {
    const d = drawn();
    const last = d[d.length - 1];
    return last ? rowY(last) + rowHeight(last) + ROW_GAP : RESULTS_Y;
  };
  const searching = () => searchingNote(state());
  /** Pending notes under the rows; with no rows the message (which names the first pending note) stands alone. */
  const notes = () => (drawn().length > 0 ? pendingNotes(rows()) : []);
  const message = () => resultsMessage(state());

  /** Back that reaches the screen (no overlay open) leaves Search: forget the query. The shell then pops. */
  const onBack = () => {
    if (router.topOverlay() === undefined) memory.leaveBack();
    return false;
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background}
      forwardFocus={() => place(clampSearchFocus(focus(), rows()))} onBack={onBack}>
      <Rail ref={(el) => { railNode = el; }} active="search" onSelect={onRailSelect}
        onRight={() => place(clampSearchFocus(focus(), rows()))} onFocusChanged={(f) => setOnRail(f)} />
      <Text x={KB_X} y={LAYOUT.safeY} fontSize={TYPE.title} color={COLORS.text}>{'Search'}</Text>

      <Keyboard ref={(el) => { kbNode = el; }} x={KB_X} y={KB_Y} label="Channel, programme or title" hint="Right: results · Back returns" value={query()}
        onChange={onChange} onDone={() => { step(KEYBOARD, 'right'); }}
        onEdgeRight={() => { step(KEYBOARD, 'right'); }} onEdgeLeft={() => { step(KEYBOARD, 'left'); }} />

      <View ref={(el) => { rowsNode = el; }} x={RESULTS_X} y={0} width={RESULTS_W} height={LAYOUT.height}
        onFocusChanged={(f: boolean) => setRowsFocused(f)}
        onUp={() => step(focus(), 'up')} onDown={() => step(focus(), 'down')}
        onLeft={() => step(focus(), 'left')} onRight={() => step(focus(), 'right')}
        onChannelUp={() => page(-1)} onChannelDown={() => page(1)}
        onEnter={() => { memory.userNavigated(); return open(); }}
        onLongOk={() => true} onMenu={() => true}>
        <For each={drawn()}>{(area, i) => {
          const focusCol = () => (focus().area === area ? focus().col : undefined);
          const lit = () => rowsFocused() && focus().area === area;
          return (
            <View y={rowY(area)}>
              <Text x={0} y={0} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{area === 'vod' ? VOD_ROW_LABEL : area === 'folders' ? FOLDERS_ROW_LABEL : LIVE_ROW_LABEL}</Text>
              {/* While the next query runs over these rows: a subtle note on the first row's label line. */}
              <Show when={i() === 0 && searching()}>
                <Text x={0} y={(TYPE.body - TYPE.meta) / 2} width={RESULTS_W} maxWidth={RESULTS_W} contain="width" maxLines={1} textAlign="right"
                  fontSize={TYPE.meta} color={COLORS.muted}>{searching()!}</Text>
              </Show>
              <Show when={area === 'vod'} fallback={
                <WideRow x={0} y={LABEL_H} width={RESULTS_W} row={area === 'folders' ? foldersRow() : liveRow()} now={now()} visible={LIVE_VISIBLE}
                  channelNumbers={area === 'live'}
                  focusCol={focusCol()} lit={lit()} onCellClick={(c) => clickCell(area, c)} onWheel={onWheel} />
              }>
                <PosterRow x={0} y={LABEL_H} width={RESULTS_W} row={vodRow()} visible={VOD_VISIBLE}
                  focusCol={focusCol()} lit={lit()} onCellClick={(c) => clickCell(area, c)} onWheel={onWheel} />
              </Show>
            </View>
          );
        }}</For>
        <For each={notes()}>{(n, i) => (
          <Text x={0} y={notesY() + i() * NOTE_H} width={RESULTS_W} maxWidth={RESULTS_W} contain="width" maxLines={1}
            fontSize={TYPE.meta} color={COLORS.muted}>{n}</Text>
        )}</For>
      </View>
      <Show when={message()}>{(m) => (
        <Text x={RESULTS_X} y={RESULTS_Y} width={RESULTS_W} maxWidth={RESULTS_W} contain="width" maxLines={2}
          fontSize={TYPE.body} color={COLORS.muted}>{m()}</Text>
      )}</Show>
    </View>
  );
}
