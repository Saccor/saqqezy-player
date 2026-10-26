import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { VOD_ALL } from '@iptv/core';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { VOD_ROW_RECENT, type ChannelRow, type SportsEventTile as StartEvent, type StartCell, type StartHome, type StartRow } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { CATCHUP_COPY, FAV_COPY, favChangedToast } from '../copy.ts';
import { canFromStart } from '../vod/catchupLogic.ts';
import { createSheetChoice } from '../components/Sheet.tsx';
import { Row } from '../components/Row.tsx';
import { COMPACT_H } from '../components/wideTileLogic.ts';
import { useRowColumn } from '../components/rowColumn.ts';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { parkLiveForScreen } from '../playback/parkLiveForScreen.ts';
import { BOTTOM_ROW_Y, screenOverlayOpen } from '../shell/logic.ts';
import { focusRailCollapsed, Rail } from '../shell/Rail.tsx';
import { dwellSignal } from '../shell/dwell.ts';
import { goRail } from '../shell/railNav.ts';
import type { RailId } from '../shell/railLogic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, SPACE, STRONG, TYPE } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { initState, settings } from '../state/appState.ts';
import { wheelKey } from '../vod/browseLogic.ts';
import { saveSetting } from './settings/shared.ts';
import { createStartActions } from './startActions.tsx';
import {
  cellId, channelMenuItems, emptyStartText, eventMenuItems, eventMenuPatch, focusAfterLoad, locateStart, moveStart, rowKind, toPosterRow,
  START_POSTER, START_POSTER_VISIBLE, START_ROW_Y, START_WIDE_VISIBLE, focusLabel, labelWidth,
  type StartFocus, type StartMemory,
} from './startLogic.ts';

/**
 * Layout (1080p design space, spec 2026-10-22 §1.1): no info strip; rows at x 160 from y 80. Match and channel rows use
 * the 360×112 compact tile and posters are 144×216, so four full rows show at once.
 */
const ROW_X = LAYOUT.contentX;
const ROW_Y = START_ROW_Y;
const LABEL_H = 42;
const ROW_GAP = SPACE.l;
/** A row below the focused one is drawn while at least its title and a strip of tiles fit on screen. */
const ROW_PEEK = LABEL_H + 20;
/** The rows' clip edge: a row sliding out upwards disappears here, just above the focused row's title. */
const CLIP_Y = ROW_Y - 8;
const REVALIDATE_MS = 30_000;

const rowHeight = (r: StartRow) => LABEL_H + (rowKind(r) === 'poster' ? START_POSTER.h : COMPACT_H);
/** Per source: focus by identity and the last column per row (kept across visits, like VodBrowse). */
const memories = new Map<string, { focus: StartMemory; cols: Map<string, number> }>();

/** Start: the rail and rows built from the user's own data (spec 2026-10-19 §2, dense layout 2026-10-22). */
export function StartScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { focus?: 'rail' };
  const startOnRail = params.focus === 'rail';
  delete params.focus;
  const memKey = initState()?.activeSourceId ?? '';
  const memory = memories.get(memKey) ?? { focus: { row: 0, col: 0 }, cols: new Map<string, number>() };
  memories.set(memKey, memory);

  const [home, setHome] = createSignal<StartHome | undefined>(undefined);
  const [focus, setFocus] = createSignal<StartFocus>({ row: memory.focus.row, col: memory.focus.col });
  const [area, setArea] = createSignal<'rail' | 'rows'>(startOnRail ? 'rail' : 'rows');
  const [now, setNow] = createSignal(Date.now());
  let railNode: ElementNode | undefined;
  let rowsNode: ElementNode | undefined;
  let wheelNode: ElementNode | undefined;
  let alive = true;
  let gen = 0;
  /** What the user chose; `area` may sit on a fallback (rail while there are no rows). Only user moves change it. */
  let preferredArea: 'rail' | 'rows' = startOnRail ? 'rail' : 'rows';

  const rows = () => home()?.rows ?? [];
  const focusedCell = (): StartCell | undefined => rows()[focus().row]?.cells[focus().col];
  /** The focused cell's label follows focus once it rests: holding a key does not rebuild a Text per step. */
  const label = dwellSignal(() => `${focus().row}|${focusLabel(focusedCell())}`);
  /** The dwelled label's text if it belongs to row `i` (a stale one from the previous row is not shown). */
  const labelFor = (i: number): string => {
    const v = label();
    const k = v.indexOf('|');
    return Number(v.slice(0, k)) === i ? v.slice(k + 1) : '';
  };
  const remember = () => {
    const f = focus();
    const r = rows()[f.row];
    const c = focusedCell();
    memory.focus = { ...f, ...(r ? { rowId: r.id } : {}), ...(c ? { cellId: cellId(c) } : {}) };
  };
  /** `user`: a key or pointer move (it becomes the preference); false for focus the screen moves by itself. */
  const focusArea = (a: 'rail' | 'rows', user = true) => {
    if (user) preferredArea = a;
    const target = a === 'rows' && rows().length === 0 ? 'rail' : a;
    setArea(target);
    // Focus the screen moves by itself (a rail choice opened it, or there are no rows) keeps the rail collapsed.
    if (target === 'rail' && (!user || a !== 'rail')) focusRailCollapsed(railNode);
    else (target === 'rail' ? railNode : rowsNode)?.setFocus();
    return true;
  };

  const apply = (input: StartHome | undefined) => {
    if (!input) return;
    // A page cached by an older build may still carry the channel row (spec 2026-10-24 §1.1): never draw it.
    const h = input.rows.some((r) => r.id === 'live') ? { ...input, rows: input.rows.filter((r) => r.id !== 'live') } : input;
    const hadRows = rows().length > 0;
    batch(() => {
      setHome(h);
      setFocus(locateStart(h.rows, memory.focus));
    });
    if (h.rows.length === 0 && area() === 'rows') focusArea('rail', false);
    else if (focusAfterLoad({ hadRows }, { hasRows: h.rows.length > 0 }, preferredArea, screenOverlayOpen()) === 'rows') {
      // The rows node mounts with the rows; focus it once it exists.
      queueMicrotask(() => { if (alive && !screenOverlayOpen()) focusArea('rows', false); });
    }
  };
  const load = async () => {
    const g = ++gen;
    try {
      const h = await api.getStartHome();
      if (alive && g === gen) apply(h);
    } catch (err) {
      console.warn('Start load failed', err instanceof Error ? err.name : 'Error');
    }
  };

  const refocusRows = () => queueMicrotask(() => { if (alive) focusArea('rows', false); });
  const actions = createStartActions({ alive: () => alive, reload: () => void load(), refocus: refocusRows });
  const menu = createSheetChoice('startMenu', refocusRows);

  const openCell = () => {
    const c = focusedCell();
    if (!c || screenOverlayOpen()) return true;
    if (c.type === 'vod') router.push(c.tile.kind === 'series' ? 'seriesDetail' : 'movieDetail', { id: c.tile.id, tile: c.tile });
    else if (c.type === 'channel') actions.tune(c.channel.id);
    else if (c.type === 'event') void actions.openEvent(c.event);
    else if (c.target === 'sports') router.push('startSports', {});
    else if (c.order === 'rating') router.push('vodGrid', { kind: c.target, categoryId: VOD_ALL, sort: 'rating' });
    else router.push('vodGrid', { kind: c.target, categoryId: VOD_ROW_RECENT });
    return true;
  };
  const matchPrefs = () => {
    const st = settings();
    return { followedTeams: st?.followedTeams ?? [], pinnedCompetitions: st?.pinnedCompetitions ?? [], hiddenCompetitions: st?.hiddenCompetitions ?? [] };
  };
  /** The channel menu Home shows on a long press: favourite on or off behind a choice, never at once. */
  const channelMenu = async (ch: ChannelRow) => {
    // Catch-up: the programme on now from its start, first when the channel keeps an archive.
    const fromStart = canFromStart(ch, Date.now()) ? [{ id: 'fromStart', label: CATCHUP_COPY.fromStart }] : [];
    const choice = await menu.choose(ch.name, [...fromStart, ...channelMenuItems(ch.favourite)]);
    if (alive && choice === 'fromStart') actions.fromStart(ch);
    if (!alive || choice !== 'fav') return;
    try {
      const on = await api.toggleFavourite(ch.id);
      if (!alive) return;
      showToast(favChangedToast(on));
      void load();
    } catch {
      if (alive) showToast(FAV_COPY.failed);
    }
  };
  /** Long Ok / Menu: the channel menu, or the match menu (follow a side, put first or hide its competition). */
  const openMenu = () => {
    const c = focusedCell();
    if (screenOverlayOpen()) return true;
    if (c?.type === 'channel') {
      void channelMenu(c.channel);
    } else if (c?.type === 'event') {
      void eventMenu(c.event);
    }
    return true;
  };
  /**
   * A match: From the start when one of its channels keeps an archive, following its sides, and putting first or
   * hiding its competition (the guide's own text).
   */
  const eventMenu = async (e: StartEvent) => {
    const t = Date.now();
    const rows = e.start <= t && t < e.stop ? await api.getEventChannels(e.key).catch(() => [] as ChannelRow[]) : [];
    if (!alive) return;
    const items = eventMenuItems(e, matchPrefs(), rows.some((r) => canFromStart(r, t)));
    if (items.length === 1) return; // only Cancel
    const choice = await menu.choose(e.title, items);
    if (!alive || !choice) return;
    if (choice === 'fromStart') { actions.fromStartRows(e, rows); return; }
    // Re-read: the lists may have changed while the menu was open. saveSetting shows its own toast on failure.
    const patch = eventMenuPatch(choice, e, matchPrefs());
    if (!patch) return;
    await saveSetting(patch);
    void load();
  };

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    if (key === 'left' && focus().col === 0) return focusArea('rail');
    const r = moveStart(rows(), focus(), key, memory.cols);
    if ('edge' in r) return true; // Up from the top row: nothing above it
    setFocus(r.focus);
    remember();
    return true;
  };
  const onWheel = (dy: number, dx: number) => {
    const key = wheelKey(dy, dx);
    if (!key || (key === 'up' && focus().row === 0)) return true;
    if (area() !== 'rows') focusArea('rows');
    move(key);
    return true;
  };
  usePointerTarget({ node: () => wheelNode, enabled: () => rows().length > 0, onWheel });

  /** Back from the rows goes to the rail; Back on the rail returns to Live TV. */
  const back = () => {
    if (area() !== 'rail') return focusArea('rail');
    router.back({ fromVod: true });
    return true;
  };
  const goTab = (t: RailId) => goRail('start', t, () => router.back({ fromVod: true }));

  onMount(() => {
    // Like Movies and Series: a full screen over Home; Back to Live TV resumes the channel that was playing.
    parkLiveForScreen('stop');
    void api.getStartHomeCached().then((h) => { if (alive && !home()) apply(h); }).catch(() => undefined);
    void load();
    const offs = [
      onEvent('refreshed', () => void load()),
      onEvent('layoutChanged', () => void load()),
      onEvent('vodRefreshed', () => void load()),
      onEvent('sourcesChanged', () => { memory.focus = { row: 0, col: 0 }; memory.cols.clear(); void load(); }),
    ];
    // Stale-while-revalidate: re-read the rows every 30 s while the page is visible (and once when it becomes visible
    // again), so Live now and Sports move on with the guide; the tiles' times follow `now`.
    const stopTick = visibleInterval(() => { setNow(Date.now()); void load(); }, REVALIDATE_MS);
    onCleanup(() => { for (const off of offs) off(); stopTick(); });
    queueMicrotask(() => focusArea(startOnRail ? 'rail' : 'rows', false));
  });
  onCleanup(() => { alive = false; actions.close(); menu.close(); });

  /**
   * The focused row on top and the rows after it below, down to a peek of the next one's title and tiles; in pointer
   * mode only rows that fit above the shell's bottom button row.
   */
  const column = useRowColumn({
    heights: () => rows().map(rowHeight),
    focusRow: () => focus().row,
    frame: () => ({ top: ROW_Y, gap: ROW_GAP, bottom: pointerMode() ? BOTTOM_ROW_Y : LAYOUT.height, peek: ROW_PEEK }),
    mode: () => (pointerMode() ? 'whole' : 'peek'),
    clipTop: CLIP_Y,
  });
  const pointTo = (row: number, col: number) => { setFocus({ row, col }); remember(); focusArea('rows'); };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={back}
      onYellow={() => { router.push('search'); return true; }} onBlue={() => { router.push('settings'); return true; }}>
      <Rail ref={(el) => { railNode = el; }} active="start" onSelect={goTab} onRight={() => focusArea('rows')}
        onFocusChanged={(f) => { if (f) setArea('rail'); }} />
      <Show when={home() !== undefined && rows().length === 0}>
        <Text x={ROW_X} y={LAYOUT.safeY} width={LAYOUT.contentW} maxWidth={LAYOUT.contentW} contain="width" maxLines={2}
          fontSize={TYPE.title} color={COLORS.text}>{emptyStartText()}</Text>
      </Show>
      <Show when={rows().length > 0}>
        <View ref={(el) => { rowsNode = el; }} width={LAYOUT.width} height={LAYOUT.height} zIndex={3}
          onFocusChanged={(f: boolean) => { if (f) { setArea('rows'); preferredArea = 'rows'; } }}
          onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')}
          onEnter={openCell} onMenu={openMenu} onLongOk={openMenu}>
          <View ref={(el) => { wheelNode = el; }} y={ROW_Y} width={LAYOUT.width} height={BOTTOM_ROW_Y - ROW_Y} />
          {/* The rows sit at fixed y's in one column that slides (a row sliding out is clipped above the focused row). */}
          <View y={CLIP_Y} width={LAYOUT.width} height={LAYOUT.height - CLIP_Y} clipping>
            <View ref={column.ref} width={LAYOUT.width} height={column.height()}>
              <For each={column.rows()}>{(i) => {
                const r = () => rows()[i]!;
                const focusCol = () => (i === focus().row ? focus().col : undefined);
                const lit = () => area() === 'rows' && i === focus().row;
                // Built once per row change, not on every `props.row` read inside Row (each tile reads it).
                const posterRow = createMemo(() => (rowKind(r()) === 'poster' ? toPosterRow(r()) : undefined));
                return (
                  <View y={column.rowY(i)} width={LAYOUT.width} height={column.rowH(i)}>
                    <Text x={ROW_X} y={0} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{r().title}</Text>
                    <Show when={lit() ? labelFor(i) : ''} keyed>
                      {(t) => {
                        const x = ROW_X + labelWidth(r().title) + 24;
                        const w = LAYOUT.width - LAYOUT.safeX - x;
                        return <Text x={x} y={0} width={w} maxWidth={w} contain="width" maxLines={1}
                          fontSize={TYPE.meta} color={COLORS.muted}>{t}</Text>;
                      }}
                    </Show>
                    <Show when={rowKind(r()) === 'poster'} fallback={
                      <Row x={ROW_X} y={LABEL_H} width={LAYOUT.width - ROW_X} content={{ variant: 'wideCompact', cells: r().cells, now: now() }}
                        focusCol={focusCol()} lit={lit()} visible={START_WIDE_VISIBLE}
                        onCellClick={(c) => { pointTo(i, c); openCell(); }} onCellOptions={(c) => { pointTo(i, c); openMenu(); }} onWheel={onWheel} />
                    }>
                      <Row x={ROW_X} y={LABEL_H} width={LAYOUT.width - ROW_X} content={{ variant: 'poster', row: posterRow()! }}
                        w={START_POSTER.w} h={START_POSTER.h} visible={START_POSTER_VISIBLE} focusCol={focusCol()} lit={lit()}
                        onCellClick={(c) => { pointTo(i, c); openCell(); }} onCellOptions={(c) => { pointTo(i, c); openMenu(); }} onWheel={onWheel} />
                    </Show>
                  </View>
                );
              }}</For>
            </View>
          </View>
        </View>
      </Show>
      {/* Above the rail (zIndex 50), so the menus' scrims dim it too. */}
      <View zIndex={60}>
        <actions.View />
        <menu.View />
      </View>
    </View>
  );
}
