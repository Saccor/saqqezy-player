import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createSignal, onCleanup, onMount } from 'solid-js';
import { VOD_ROW_RECENT, type StartCell, type StartHome, type StartRow } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { createChoiceMenu } from '../components/choiceMenu.tsx';
import { POSTER_H } from '../components/PosterTile.tsx';
import { PosterRow } from '../components/PosterRow.tsx';
import { TabBar } from '../components/TabBar.tsx';
import { WIDE_H } from '../components/WideTile.tsx';
import { WideRow } from '../components/WideRow.tsx';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { playback } from '../playback/playback.ts';
import { BOTTOM_ROW_Y } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { initState, settings } from '../state/appState.ts';
import { wheelKey } from '../vod/browseLogic.ts';
import { liveReturn, liveToRemember } from '../vod/liveReturn.ts';
import { tabNavigation, tabParams, type TabId } from '../vod/tabLogic.ts';
import { saveSetting } from './settings/shared.ts';
import { createStartActions } from './startActions.tsx';
import {
  cellId, channelsLabel, emptyStartText, eventWhen, focusAfterLoad, locateStart, moveStart, rowKind, toPosterRow, type StartFocus, type StartMemory,
} from './startLogic.ts';

const HERO_X = LAYOUT.safeX;
const HERO_Y = 190;
const HERO_W = 1100;
const ROW_Y = 470;
const LABEL_H = 44;
const ROW_GAP = 36;
const REVALIDATE_MS = 30_000;

const rowHeight = (r: StartRow) => LABEL_H + (rowKind(r) === 'poster' ? POSTER_H : WIDE_H);
/** Per source: focus by identity and the last column per row (kept across visits, like VodBrowse). */
const memories = new Map<string, { focus: StartMemory; cols: Map<string, number> }>();

/** Start: the tab bar, a hero for the focused cell, and rows built from the user's own data (spec §2). */
export function StartScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { focus?: 'tabs' };
  const startOnTabs = params.focus === 'tabs';
  delete params.focus;
  const memKey = initState()?.activeSourceId ?? '';
  const memory = memories.get(memKey) ?? { focus: { row: 0, col: 0 }, cols: new Map<string, number>() };
  memories.set(memKey, memory);

  const [home, setHome] = createSignal<StartHome | undefined>(undefined);
  const [focus, setFocus] = createSignal<StartFocus>({ row: memory.focus.row, col: memory.focus.col });
  const [area, setArea] = createSignal<'tabs' | 'rows'>(startOnTabs ? 'tabs' : 'rows');
  const [now, setNow] = createSignal(Date.now());
  let tabsNode: ElementNode | undefined;
  let rowsNode: ElementNode | undefined;
  let wheelNode: ElementNode | undefined;
  let alive = true;
  let gen = 0;
  let lastLoad = 0;
  /** What the user chose; `area` may sit on a fallback (tabs while there are no rows). Only user moves change it. */
  let preferredArea: 'tabs' | 'rows' = startOnTabs ? 'tabs' : 'rows';

  const rows = () => home()?.rows ?? [];
  const focusedCell = (): StartCell | undefined => rows()[focus().row]?.cells[focus().col];
  const remember = () => {
    const f = focus();
    const r = rows()[f.row];
    const c = focusedCell();
    memory.focus = { ...f, ...(r ? { rowId: r.id } : {}), ...(c ? { cellId: cellId(c) } : {}) };
  };
  /** `user`: a key or pointer move (it becomes the preference); false for focus the screen moves by itself. */
  const focusArea = (a: 'tabs' | 'rows', user = true) => {
    if (user) preferredArea = a;
    const target = a === 'rows' && rows().length === 0 ? 'tabs' : a;
    setArea(target);
    (target === 'tabs' ? tabsNode : rowsNode)?.setFocus();
    return true;
  };

  const apply = (h: StartHome | undefined) => {
    if (!h) return;
    const hadRows = rows().length > 0;
    batch(() => {
      setHome(h);
      setFocus(locateStart(h.rows, memory.focus));
    });
    if (h.rows.length === 0 && area() === 'rows') focusArea('tabs', false);
    else if (focusAfterLoad({ hadRows }, { hasRows: h.rows.length > 0 }, preferredArea, router.topOverlay() !== undefined) === 'rows') {
      // The rows node mounts with the rows; focus it once it exists.
      queueMicrotask(() => { if (alive && router.topOverlay() === undefined) focusArea('rows', false); });
    }
  };
  const load = async () => {
    const g = ++gen;
    lastLoad = Date.now();
    try {
      const h = await api.getStartHome();
      if (alive && g === gen) apply(h);
    } catch (err) {
      console.warn('Start load failed', err instanceof Error ? err.name : 'Error');
    }
  };

  const refocusRows = () => queueMicrotask(() => { if (alive) focusArea('rows', false); });
  const actions = createStartActions({ alive: () => alive, reload: () => void load(), refocus: refocusRows });
  const menu = createChoiceMenu('startMenu', refocusRows);

  const openCell = () => {
    const c = focusedCell();
    if (!c || router.topOverlay() !== undefined) return true;
    if (c.type === 'vod') router.push(c.tile.kind === 'series' ? 'seriesDetail' : 'movieDetail', { id: c.tile.id, tile: c.tile });
    else if (c.type === 'channel') actions.tune(c.channel.id);
    else if (c.type === 'event') void actions.openEvent(c.event);
    else if (c.target === 'sports') router.push('startSports', {});
    else router.push('vodGrid', { kind: c.target, categoryId: VOD_ROW_RECENT });
    return true;
  };
  const followMenu = async (sides: [string, string]) => {
    const followed = settings()?.followedTeams ?? [];
    const isOn = (s: string) => followed.some((f) => f.toLowerCase() === s.toLowerCase());
    const choice = await menu.choose('Teams I follow', sides.map((s) => ({ id: s, label: `${isOn(s) ? 'Unfollow' : 'Follow'} ${s}` })));
    if (!alive || !choice) return;
    const next = isOn(choice) ? followed.filter((f) => f.toLowerCase() !== choice.toLowerCase()) : [...followed, choice];
    try {
      await saveSetting({ followedTeams: next });
    } catch (err) {
      console.warn('Follow failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't save your teams.");
      return;
    }
    void load();
  };
  /** Long Ok / Menu: favourite a channel; follow or unfollow a side of an event. */
  const openMenu = () => {
    const c = focusedCell();
    if (router.topOverlay() !== undefined) return true;
    if (c?.type === 'channel') {
      void api.toggleFavourite(c.channel.id)
        .then((on) => { showToast(on ? 'Added to favourites' : 'Removed from favourites'); void load(); })
        .catch(() => showToast("Couldn't change favourites."));
    } else if (c?.type === 'event' && c.event.sides) {
      void followMenu(c.event.sides);
    }
    return true;
  };

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    const r = moveStart(rows(), focus(), key, memory.cols);
    if ('edge' in r) return focusArea('tabs');
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

  const back = () => { router.back({ focusTabs: true }); return true; };
  const goTab = (t: TabId) => {
    const nav = tabNavigation('start', t);
    if (nav.action === 'back') back();
    else if (nav.action === 'replace') router.replace(nav.to.screen, tabParams(nav.to));
  };

  onMount(() => {
    // Like Movies and Series: a full screen over Home; Back to Live TV resumes the channel that was playing.
    liveReturn.remember(liveToRemember(playback.current()?.id, playback.status()?.kind), initState()?.activeSourceId);
    playback.stop();
    void api.getStartHomeCached().then((h) => { if (alive && !home()) apply(h); }).catch(() => undefined);
    void load();
    const offs = [
      onEvent('refreshed', () => void load()),
      onEvent('layoutChanged', () => void load()),
      onEvent('vodRefreshed', () => void load()),
      onEvent('sourcesChanged', () => { memory.focus = { row: 0, col: 0 }; memory.cols.clear(); void load(); }),
    ];
    const tick = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastLoad > REVALIDATE_MS) void load();
    }, 60_000);
    onCleanup(() => { for (const off of offs) off(); clearInterval(tick); });
    queueMicrotask(() => focusArea(startOnTabs ? 'tabs' : 'rows', false));
  });
  onCleanup(() => { alive = false; actions.close(); menu.close(); });

  const heroTitle = () => {
    const c = focusedCell();
    if (!c) return '';
    if (c.type === 'vod') return c.tile.title;
    if (c.type === 'channel') return c.channel.name;
    if (c.type === 'event') return c.event.title;
    return rows()[focus().row]?.title ?? '';
  };
  const heroLine = () => {
    const c = focusedCell();
    if (c?.type === 'channel') return c.channel.now ? `Now: ${c.channel.now.title}${c.channel.next ? ` · Next: ${c.channel.next.title}` : ''}` : 'No guide information';
    if (c?.type === 'event') return [eventWhen(c.event, now()), channelsLabel(c.event.channelCount), c.event.subTitle].filter(Boolean).join(' · ');
    if (c?.type === 'vod') return c.tile.year ? String(c.tile.year) : '';
    return '';
  };
  /** The focused row and the next one peeking in below; only the focused one in pointer mode (as VodBrowse). */
  const visibleRows = () => (pointerMode() ? [focus().row] : [focus().row, focus().row + 1]).filter((i) => i < rows().length);
  const rowY = (i: number) => (i === focus().row ? ROW_Y : ROW_Y + rowHeight(rows()[focus().row]!) + ROW_GAP);
  const pointTo = (row: number, col: number) => { setFocus({ row, col }); remember(); focusArea('rows'); };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={back}
      onYellow={() => { router.push('search'); return true; }} onBlue={() => { router.push('settings'); return true; }}>
      <TabBar ref={(el) => { tabsNode = el; }} active="start" onSelect={goTab} onDown={() => focusArea('rows')}
        onFocusChanged={(f) => { if (f) setArea('tabs'); }} />
      <Show when={home() !== undefined && rows().length === 0}>
        <Text x={HERO_X} y={HERO_Y + 60} fontSize={FONT.heading} color={COLORS.text}>{emptyStartText()}</Text>
      </Show>
      <Show when={rows().length > 0}>
        <Text x={HERO_X} y={HERO_Y} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>
          {rows()[focus().row]?.title ?? ''}
        </Text>
        <Text x={HERO_X} y={HERO_Y + 34} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={1} fontSize={64} color={COLORS.text}>{heroTitle()}</Text>
        <Text x={HERO_X} y={HERO_Y + 116} width={HERO_W} maxWidth={HERO_W} contain="width" maxLines={2} fontSize={FONT.body} color={COLORS.muted}>{heroLine()}</Text>
        <View ref={(el) => { rowsNode = el; }} width={LAYOUT.width} height={LAYOUT.height} zIndex={3}
          onFocusChanged={(f: boolean) => { if (f) { setArea('rows'); preferredArea = 'rows'; } }}
          onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')}
          onEnter={openCell} onMenu={openMenu} onLongOk={openMenu}>
          <View ref={(el) => { wheelNode = el; }} y={ROW_Y} width={LAYOUT.width} height={BOTTOM_ROW_Y - ROW_Y} />
          <For each={visibleRows()}>{(i) => {
            const r = () => rows()[i]!;
            const focusCol = () => (i === focus().row ? focus().col : undefined);
            const lit = () => area() === 'rows' && i === focus().row;
            return (
              <View y={rowY(i)}>
                <Text x={LAYOUT.safeX} y={0} fontSize={FONT.heading} color={COLORS.text}>{r().title}</Text>
                <Show when={rowKind(r()) === 'poster'} fallback={
                  <WideRow x={LAYOUT.safeX} y={LABEL_H} width={LAYOUT.width - LAYOUT.safeX} row={r()} now={now()} focusCol={focusCol()} lit={lit()}
                    onCellClick={(c) => { pointTo(i, c); openCell(); }} onCellOptions={(c) => { pointTo(i, c); openMenu(); }} onWheel={onWheel} />
                }>
                  <PosterRow x={LAYOUT.safeX} y={LABEL_H} width={LAYOUT.width - LAYOUT.safeX} row={toPosterRow(r())} focusCol={focusCol()} lit={lit()}
                    onCellClick={(c) => { pointTo(i, c); openCell(); }} onCellOptions={(c) => { pointTo(i, c); openMenu(); }} onWheel={onWheel} />
                </Show>
              </View>
            );
          }}</For>
        </View>
      </Show>
      <actions.View />
      <menu.View />
    </View>
  );
}
