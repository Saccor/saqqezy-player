import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import type { SportsEventTile } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { WIDE_GAP, WIDE_H, WIDE_W, WideTile } from '../components/WideTile.tsx';
import { parkLiveForScreen } from '../playback/parkLiveForScreen.ts';
import { screenOverlayOpen } from '../shell/logic.ts';
import { router } from '../shell/router.ts';
import { COLORS, LAYOUT, TYPE } from '../shell/theme.ts';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { createStartActions } from './startActions.tsx';
import { gridMove } from './startLogic.ts';

const COLS = 5;
const TOP = 200;
const PITCH_X = WIDE_W + WIDE_GAP;
const PITCH_Y = WIDE_H + WIDE_GAP + 8;
const VISIBLE_ROWS = 4;

/** Sports in your guide, every event (the Start row's See all). */
export function StartSportsScreen() {
  const [events, setEvents] = createSignal<SportsEventTile[]>([]);
  const [index, setIndex] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let node: ElementNode | undefined;
  let alive = true;
  const load = async () => {
    const list = await api.getSportsEvents().catch(() => [] as SportsEventTile[]);
    if (!alive) return;
    setEvents(list);
    setLoaded(true);
    setIndex((i) => Math.min(i, Math.max(0, list.length - 1)));
  };
  const actions = createStartActions({ alive: () => alive, reload: () => void load(), refocus: () => queueMicrotask(() => node?.setFocus()) });
  const firstRow = () => Math.max(0, Math.floor(index() / COLS) - VISIBLE_ROWS + 1);
  const shown = () => events().slice(firstRow() * COLS, (firstRow() + VISIBLE_ROWS) * COLS);
  const move = (key: 'up' | 'down' | 'left' | 'right') => {
    if (screenOverlayOpen()) return true;
    const n = gridMove(events().length, COLS, index(), key);
    if (n !== 'top') setIndex(n);
    return true;
  };
  const open = () => {
    const e = events()[index()];
    if (e && !screenOverlayOpen()) void actions.openEvent(e);
    return true;
  };
  onMount(() => {
    // A full screen like Start: Back from a Player opened here must not leave the stream playing fullscreen behind it.
    parkLiveForScreen('stop');
    void load();
    const off = onEvent('refreshed', () => void load());
    const stopTick = visibleInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => { off(); stopTick(); });
    queueMicrotask(() => node?.setFocus());
  });
  onCleanup(() => { alive = false; actions.close(); });
  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={() => { router.back(); return true; }}>
      <Text x={LAYOUT.safeX} y={LAYOUT.safeY + 40} fontSize={TYPE.title} color={COLORS.text}>Sports in your guide</Text>
      <Show when={loaded() && events().length === 0}>
        <Text x={LAYOUT.safeX} y={TOP + 20} fontSize={TYPE.body} color={COLORS.muted}>No sports in your guide right now.</Text>
      </Show>
      <View ref={(el) => { node = el; }} x={LAYOUT.safeX} y={TOP} width={LAYOUT.width - 2 * LAYOUT.safeX} height={VISIBLE_ROWS * PITCH_Y}
        onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => move('right')} onEnter={open}>
        <For each={shown()}>{(e, i) => {
          const at = () => firstRow() * COLS + i();
          return <WideTile x={(at() % COLS) * PITCH_X} y={(Math.floor(at() / COLS) - firstRow()) * PITCH_Y}
            cell={{ type: 'event', event: e }} lit={at() === index()} now={now()} />;
        }}</For>
      </View>
      <actions.View />
    </View>
  );
}
