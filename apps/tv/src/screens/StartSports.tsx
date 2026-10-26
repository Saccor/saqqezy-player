import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { MatchCompetitionChips, MatchFilterChip, SportsEventTile } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { ActionBar } from '../components/ActionBar.tsx';
import { BUTTON_H } from '../components/Button.tsx';
import { createSheetChoice } from '../components/Sheet.tsx';
import { COMPACT_W, MATCH_GRID_H, WIDE_GAP, WideTile } from '../components/WideTile.tsx';
import { pointerMode } from '../input/pointer.ts';
import { parkLiveForScreen } from '../playback/parkLiveForScreen.ts';
import { BOTTOM_ROW_Y, screenOverlayOpen } from '../shell/logic.ts';
import { router } from '../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { settings } from '../state/appState.ts';
import { saveSetting } from './settings/shared.ts';
import { createStartActions } from './startActions.tsx';
import { byCompetition, matchGridLayout, matchSections, scrollToShow, sectionMove } from './matchesGridLogic.ts';
import {
  COMP_ALL, COMP_MORE, MATCHES_COPY, activeMatchChip, compChipId, compKeyOf, competitionChipActions, competitionMenuItems,
  competitionPatch, matchChipActions, matchesSummary,
} from './startLogic.ts';

/** Layout (1080p, spec 2026-10-22 §3.1): title, sport chips, competition chips, then a scrolling sectioned grid. */
const COLS = 4;
const TITLE_Y = LAYOUT.safeY + 16;
/** The summary follows the 40 px title "Matches". */
const SUMMARY_X = LAYOUT.safeX + 200;
const SPORTS_Y = 140;
const COMPS_Y = SPORTS_Y + BUTTON_H + 16;
const GRID_GAP_TOP = 28;
const WIDTH = LAYOUT.width - 2 * LAYOUT.safeX;
const FRAME = { cols: COLS, pitchX: COMPACT_W + WIDE_GAP, tileH: MATCH_GRID_H, rowGap: WIDE_GAP, labelH: 44, sectionGap: 16 } as const;
const NO_COMPS: MatchCompetitionChips = { chips: [], more: [] };

/** Matches in your guide, every match (the Start row's View all): sport chips, that sport's competitions, a grid. */
export function StartSportsScreen() {
  const [events, setEvents] = createSignal<SportsEventTile[]>([]);
  const [sports, setSports] = createSignal<MatchFilterChip[]>([]);
  const [comps, setComps] = createSignal<MatchCompetitionChips>(NO_COMPS);
  /** The chosen competition's key; undefined: all of the sport. Screen state only (spec §3.3). */
  const [comp, setComp] = createSignal<string | undefined>(undefined);
  const [index, setIndex] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [gridFocused, setGridFocused] = createSignal(false);
  const [sportsFocused, setSportsFocused] = createSignal(false);
  const [compsFocused, setCompsFocused] = createSignal(false);
  const chipsFocused = () => sportsFocused() || compsFocused();
  let gridNode: ElementNode | undefined;
  let sportsNode: ElementNode | undefined;
  let compsNode: ElementNode | undefined;
  let alive = true;

  const activeSport = () => activeMatchChip(sports(), settings()?.matchCategories ?? []);
  const sportLabel = () => sports().find((c) => c.id === activeSport())?.label;
  const compLabel = () => {
    const k = comp();
    return k === undefined ? undefined : [...comps().chips, ...comps().more].find((c) => c.id === k)?.label;
  };
  const shown = createMemo(() => byCompetition(events(), comp()));
  const grid = createMemo(() => matchSections(shown(), now()));
  const layout = createMemo(() => matchGridLayout(grid().sections, FRAME));
  const sportActions = () => matchChipActions(sports(), WIDTH);
  const compActions = () => (activeSport() === 'all' ? [] : competitionChipActions(sportLabel() ?? '', comps().chips, comps().more.length > 0, WIDTH));
  const compId = () => { const k = comp(); return k === undefined ? COMP_ALL : compChipId(k); };
  const gridTop = () => (compActions().length ? COMPS_Y + BUTTON_H + GRID_GAP_TOP : sportActions().length ? SPORTS_Y + BUTTON_H + GRID_GAP_TOP : SPORTS_Y);
  /** The grid never reaches the pointer-mode Back button (BOTTOM_ROW_Y) nor the safe bottom. */
  const viewH = () => (pointerMode() ? BOTTOM_ROW_Y : LAYOUT.height - LAYOUT.safeY) - gridTop();
  const visibleIdx = createMemo(() => {
    const s = scroll();
    const h = viewH();
    return layout().places.flatMap((p, i) => (p.y + MATCH_GRID_H >= s && p.y <= s + h ? [i] : []));
  });
  const summary = () => matchesSummary(compLabel() ?? sportLabel() ?? MATCHES_COPY.allSports, shown().length);
  const matchPrefs = () => {
    const st = settings();
    return { followedTeams: st?.followedTeams ?? [], pinnedCompetitions: st?.pinnedCompetitions ?? [], hiddenCompetitions: st?.hiddenCompetitions ?? [] };
  };

  const focusTile = (i: number) => {
    setIndex(i);
    const p = layout().places[i];
    if (p) setScroll((s) => scrollToShow(p.y, MATCH_GRID_H, FRAME.labelH, s, viewH()));
  };
  /** Never leave focus on an empty grid: the competition row if shown, else the sport row. */
  const rescue = () => {
    if (grid().order.length) return;
    queueMicrotask(() => { if (alive && gridFocused() && !screenOverlayOpen()) (compActions().length ? compsNode : sportActions().length ? sportsNode : undefined)?.setFocus(); });
  };
  let gen = 0;
  const load = async () => {
    const g = ++gen;
    const [list, filters] = await Promise.all([
      api.getSportsEvents().catch(() => [] as SportsEventTile[]),
      api.getMatchFilters().catch(() => ({ competitions: [], categories: [] })),
    ]);
    if (!alive || g !== gen) return;
    const sport = activeMatchChip(filters.categories, settings()?.matchCategories ?? []);
    batch(() => {
      setEvents(list);
      setSports(filters.categories);
      if (sport === 'all') { setComps(NO_COMPS); setComp(undefined); }
      setLoaded(true);
    });
    focusTile(Math.min(index(), Math.max(0, grid().order.length - 1)));
    rescue();
    if (sport === 'all') return;
    // The competitions arrive after the grid is on screen: never block the UI on them.
    const cs = await api.getMatchCompetitions(sport).catch(() => NO_COMPS);
    if (!alive || g !== gen) return;
    batch(() => {
      setComps(cs);
      const k = comp();
      if (k !== undefined && ![...cs.chips, ...cs.more].some((c) => c.id === k)) setComp(undefined);
    });
    // gridTop and viewH follow the competition row: scroll must match them.
    focusTile(Math.min(index(), Math.max(0, grid().order.length - 1)));
    rescue();
  };
  const actions = createStartActions({ alive: () => alive, reload: () => void load(), refocus: () => queueMicrotask(() => gridNode?.setFocus()) });
  const menu = createSheetChoice('matchesMenu', () => queueMicrotask(() => (compsNode ?? gridNode)?.setFocus()));

  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    if (screenOverlayOpen()) return true;
    const n = sectionMove(grid().sections, COLS, index(), key);
    if (n !== 'top') focusTile(n);
    else (compActions().length ? compsNode : sportActions().length ? sportsNode : undefined)?.setFocus();
    return true;
  };
  const open = () => {
    const e = grid().order[index()];
    if (e && !screenOverlayOpen()) void actions.openEvent(e);
    return true;
  };
  const resetGrid = () => { setIndex(0); setScroll(0); };
  const pickSport = async (id: string) => {
    await saveSetting({ matchCategories: id === 'all' ? [] : [id] });
    if (!alive) return;
    setComp(undefined);
    setComps(NO_COMPS);
    resetGrid();
    await load();
  };
  const pickComp = async (id: string) => {
    let key: string | undefined;
    if (id === COMP_MORE) {
      const choice = await menu.choose(MATCHES_COPY.more, comps().more.map((c) => ({ id: c.id, label: c.label })));
      if (!alive || !choice) return;
      key = choice;
    } else {
      key = id === COMP_ALL ? undefined : compKeyOf(id);
    }
    setComp(key);
    resetGrid();
  };
  const compOptions = async (id: string) => {
    const key = compKeyOf(id);
    const chip = key === undefined ? undefined : comps().chips.find((c) => c.id === key);
    if (!chip || screenOverlayOpen()) return;
    const choice = await menu.choose(chip.label, competitionMenuItems(chip.label, chip.id, matchPrefs()));
    if (!alive || (choice !== 'pin' && choice !== 'hide')) return;
    // Re-read: the lists may have changed while the menu was open. saveSetting shows its own toast on failure.
    await saveSetting(competitionPatch(choice, chip.id, matchPrefs()));
    if (!alive) return;
    if (choice === 'hide' && comp() === chip.id) { setComp(undefined); resetGrid(); }
    await load();
    // The competition row may be gone now (no chips left): focus must not stay on a removed bar.
    if (alive && compActions().length === 0) queueMicrotask(() => (grid().order.length ? gridNode : sportsNode)?.setFocus());
  };
  /** Back from a chip row returns to the grid; Back from the grid leaves. */
  const back = () => {
    if (chipsFocused() && grid().order.length) { gridNode?.setFocus(); return true; }
    router.back();
    return true;
  };

  onMount(() => {
    // A full screen like Start: Back from a Player opened here must not leave the stream playing fullscreen behind it.
    parkLiveForScreen('stop');
    void load();
    const off = onEvent('refreshed', () => void load());
    const stopTick = visibleInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => { off(); stopTick(); });
    // The chip rows do not exist yet; load() moves focus off the grid when it comes back empty (rescue).
    queueMicrotask(() => gridNode?.setFocus());
  });
  onCleanup(() => { alive = false; actions.close(); menu.close(); });

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={back}>
      <Text x={LAYOUT.safeX} y={TITLE_Y} fontSize={TYPE.title} {...STRONG} color={COLORS.text}>{MATCHES_COPY.title}</Text>
      <Show when={loaded()}>
        <Text x={SUMMARY_X} y={TITLE_Y + 12} width={WIDTH - (SUMMARY_X - LAYOUT.safeX)} maxWidth={WIDTH - (SUMMARY_X - LAYOUT.safeX)}
          contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{summary()}</Text>
      </Show>
      <Show when={sportActions().length > 0}>
        <ActionBar ref={(el) => { sportsNode = el; }} x={LAYOUT.safeX} y={SPORTS_Y} actions={sportActions()} initial={activeSport()} current={activeSport()}
          onAction={(id) => void pickSport(id)} onFocusChanged={setSportsFocused}
          onDown={() => { (compActions().length ? compsNode : grid().order.length ? gridNode : undefined)?.setFocus(); return true; }} />
      </Show>
      <Show when={compActions().length > 0}>
        <ActionBar ref={(el) => { compsNode = el; }} x={LAYOUT.safeX} y={COMPS_Y} actions={compActions()} initial={compId()} current={compId()}
          onAction={(id) => void pickComp(id)} onOptions={(id) => void compOptions(id)} onFocusChanged={setCompsFocused}
          onUp={() => { sportsNode?.setFocus(); return true; }} onDown={() => { if (grid().order.length) gridNode?.setFocus(); return true; }} />
      </Show>
      <Show when={loaded() && shown().length === 0}>
        <Text x={LAYOUT.safeX} y={gridTop() + 20} fontSize={TYPE.body} color={COLORS.muted}>{MATCHES_COPY.empty}</Text>
      </Show>
      <View ref={(el) => { gridNode = el; }} x={LAYOUT.safeX} y={gridTop()} width={WIDTH} height={Math.max(1, viewH())} clipping
        onFocusChanged={(f: boolean) => setGridFocused(f)}
        onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')} onEnter={open}>
        {/* The column has a real height: a node with none takes its parent's and the renderer would drop its children. */}
        <View y={-scroll()} width={WIDTH} height={Math.max(1, layout().height)}>
          <For each={layout().labels}>{(l) => (
            <Text x={0} y={l.y + 8} fontSize={TYPE.meta} {...STRONG} color={COLORS.muted}>{l.label}</Text>
          )}</For>
          <For each={visibleIdx()}>{(i) => {
            const e = () => grid().order[i]!;
            const p = () => layout().places[i]!;
            return <WideTile x={p().x} y={p().y} cell={{ type: 'event', event: e() }} compact detail={e().competition ?? e().subTitle ?? ''}
              lit={gridFocused() && i === index()} now={now()} />;
          }}</For>
        </View>
      </View>
      <View zIndex={60}>
        <actions.View />
        <menu.View />
      </View>
    </View>
  );
}
