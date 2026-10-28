import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { GROUP_ALL } from '@iptv/core';
import { api } from '../../api.ts';
import { Sheet } from '../../components/Sheet.tsx';
import { fromMenuItem } from '../../components/sheetLogic.ts';
import { MULTIVIEW_COPY } from '../../copy.ts';
import {
  clearWindowNote, connectionMemory, deviceWindowMax, otherSlots, playback, pool, setInMultiview,
} from '../../playback/playback.ts';
import { createLayerSet } from '../../shell/layerSet.ts';
import { router, type ScreenEntry } from '../../shell/router.ts';
import { COLORS, LAYOUT, RADIUS, SPACE, TYPE } from '../../shell/theme.ts';
import { FocusRing } from '../../components/FocusRing.tsx';
import { initState, settings } from '../../state/appState.ts';
import { volumeStep } from '../../video/volume.ts';
import { layout } from './layout.ts';
import { MultiviewPicker } from './MultiviewPicker.tsx';
import { WindowChrome, WindowHit } from './MultiviewChrome.tsx';
import {
  CHROME_IDLE_MS, SOUND_REST_MS, addWindow, click, enterFullScreen, exitFullScreen, focusRested, idle, layoutInput, moveFocus,
  pickerHint, playingSince, pointerFocus, soundToPlaying, start, steadyPlaying, wake, type MvState, type MvWindow,
} from './mvLogic.ts';
import { createMvHealth } from './mvHealth.ts';
import { createMvMenu } from './mvMenu.ts';
import { createMultiviewSession } from './session.ts';
import { tileProfile } from './tileProfile.ts';
import { addBlockedText, canAddWindow, deviceCeiling, windowLimit } from './windows.ts';

const MENU_ID = 'multiviewMenu';
const PICKER_ID = 'multiviewPicker';

/**
 * Multiview (spec 2026-10-20-multiview; owner decisions §12 and 2026-10-22): several live channels at once on desktop.
 * The windows are playback slots placed at `layout()`'s rects; this screen draws the chrome over them (ring, sound
 * disc, label, status; `MultiviewChrome.tsx`) and drives the state in `mvLogic`. The sound is the pool's primary slot
 * and follows the focus (D-pad or hover) after a 400 ms rest. Leaving keeps the window with sound playing full screen:
 * no reconnect. Failures, Retry and "Watch this one instead" live in `mvHealth.ts`.
 */
export function MultiviewScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { channelId?: string };
  const limit = () => windowLimit(deviceCeiling(deviceWindowMax()), settings()?.maxWindows ?? 'auto');
  const [state, setState] = createSignal<MvState | undefined>(undefined);
  const [picker, setPicker] = createSignal<{ mode: 'add' } | { mode: 'change'; index: number } | undefined>(undefined);
  const [menu, setMenu] = createSignal<number | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());
  /** Channel names by id, for the labels (from the playables we opened). */
  const [names, setNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  const remember = (id: string, name: string) => setNames((m) => new Map(m).set(id, name));
  let root: ElementNode | undefined;
  let menuNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let pickerBack: (() => boolean) | undefined;
  let alive = true;
  /** Opened over nothing yet: Back from the first picker leaves multiview. */
  let entryPicker = false;

  const session = createMultiviewSession({
    pool, setInMultiview,
    fetch: async (id) => {
      const ch = await api.getPlayable(id);
      if (ch) remember(ch.id, ch.name);
      return ch;
    },
    profile: (cls) => {
      const p = tileProfile(cls, false);
      return { hls: p.hls, mpegts: p.mpegts };
    },
  });

  const geometry = createMemo(() => {
    const s = state();
    return s ? layout(layoutInput(s, limit())) : undefined;
  });
  const update = (next: MvState) => {
    setState(next);
    session.apply(next, limit());
  };

  // ---- timers: the sound follows a resting focus; the chrome sleeps when idle ----
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { const s = state(); if (alive && s && menu() === undefined && !picker()) setState(idle(s)); }, CHROME_IDLE_MS);
  };
  createEffect(on(() => state()?.focus, () => {
    if (restTimer !== undefined) clearTimeout(restTimer);
    restTimer = setTimeout(() => {
      const s = state();
      // The sound never moves onto a window that shows a failure.
      if (alive && s && !(typeof s.focus === 'number' && failure(s.focus))) update(focusRested(s));
    }, SOUND_REST_MS);
  }, { defer: true }));

  /** A key arrived: wakes the chrome; true when that is all it does. */
  const woke = (): boolean => {
    armIdle();
    const s = state();
    if (!s) return true;
    const r = wake(s);
    if (r.consumed) setState(r.state);
    return r.consumed;
  };

  // ---- windows ----
  const health = createMvHealth({ alive: () => alive, state, update, session, now });
  const { watch, freeingSlot, unyield, windowAt, slotOf, forgetReopen, failure } = health;
  const onScreen = (channelId: string) => state()?.windows.some((w) => w.channelId === channelId) ?? false;
  const canAdd = () => {
    const s = state();
    const r = canAddWindow({ deviceMax: deviceCeiling(deviceWindowMax()), userMax: settings()?.maxWindows ?? 'auto', open: s?.windows.length ?? 0 });
    if (r.ok) return { ok: true as const };
    return { ok: false as const, reason: addBlockedText(r) };
  };

  const leave = (keep?: MvWindow) => {
    if (!alive) return;
    watch.cancel();
    if (keep && keep.slot !== pool.primary()) pool.setPrimary(keep.slot);
    closeOverlays();
    session.leave();
    const row = playback.currentRowId();
    alive = false;
    router.back(row ? { channelId: row } : undefined);
  };

  const pickChannel = async (channelId: string) => {
    const mode = picker();
    closePicker();
    // Acting on a window meanwhile: a pending "Watch this one instead" opens nothing later.
    watch.cancel();
    const s = state();
    if (!s || !mode) return;
    const existing = s.windows.findIndex((w) => w.channelId === channelId);
    if (existing >= 0) {
      update(click(s, existing));
      return;
    }
    if (mode.mode === 'change') {
      const w = s.windows[mode.index];
      if (!w) return;
      forgetReopen(w.slot);
      clearWindowNote(w.slot);
      unyield(w.slot);
      const changed = await session.changeChannel(w, channelId);
      const cur = state();
      if (alive && changed && cur) update({ ...cur, windows: cur.windows.map((x, k) => (k === mode.index ? changed : x)) });
      return;
    }
    if (!canAdd().ok) return;
    const target = layout(layoutInput(addWindow(s, { slot: -1, channelId }), limit())).tiles.find((t) => t.tile === s.windows.length);
    if (!target) return;
    const opened = await session.openWindow(channelId, s.windows, target);
    const cur = state();
    if (!alive || !opened || !cur) return;
    clearWindowNote(opened.slot);
    update(addWindow(cur, opened));
  };

  const zap = (delta: 1 | -1) => {
    const s = state();
    if (!s || s.focus === 'empty') return true;
    const w = s.windows[s.focus];
    if (!w) return true;
    const i = s.focus;
    watch.cancel();
    api.neighbour(GROUP_ALL, w.channelId, delta).then(async (ch) => {
      if (!ch || !alive) return;
      remember(ch.id, ch.name);
      forgetReopen(w.slot);
      clearWindowNote(w.slot);
      unyield(w.slot);
      const changed = await session.changeChannel(w, ch.id);
      const cur = state();
      if (alive && changed && cur) update({ ...cur, windows: cur.windows.map((x, k) => (k === i ? changed : x)) });
    }).catch(() => undefined);
    return true;
  };

  // ---- overlays ----
  const layers = createLayerSet();
  const closeOverlays = () => { layers.remove(MENU_ID); layers.remove(PICKER_ID); setMenu(undefined); setPicker(undefined); };
  const focusRoot = () => queueMicrotask(() => root?.setFocus());

  const openPicker = (mode: { mode: 'add' } | { mode: 'change'; index: number }) => {
    setMenu(undefined);
    layers.remove(MENU_ID);
    setPicker(mode);
    const layer = () => layers.open(PICKER_ID, () => {
      // Back first clears a search query (the picker stays); only then does it close.
      if (pickerBack?.()) { layer(); return; }
      setPicker(undefined);
      // Back from the first picker with nothing picked: back to the full-screen player.
      if (entryPicker && (state()?.windows.length ?? 0) <= 1) leave();
      else focusRoot();
    });
    layer();
    queueMicrotask(() => pickerNode?.setFocus());
  };
  const closePicker = () => {
    entryPicker = false;
    layers.remove(PICKER_ID);
    setPicker(undefined);
    focusRoot();
  };

  const openMenu = (i?: number) => {
    const s = state();
    if (!s) return true;
    const at = i ?? s.focus;
    if (at === 'empty') {
      openPicker({ mode: 'add' });
      return true;
    }
    setMenu(at);
    layers.open(MENU_ID, () => { setMenu(undefined); focusRoot(); });
    queueMicrotask(() => menuNode?.setFocus());
    return true;
  };
  const closeMenu = () => { layers.remove(MENU_ID); setMenu(undefined); focusRoot(); };

  const { menuEntries, choose } = createMvMenu({
    state, menu, health, canAdd, update, session, leave, closeMenu,
    openPicker: (index) => openPicker(index === undefined ? { mode: 'add' } : { mode: 'change', index }),
  });

  /** Every slot, read reactively (a new window or a sound move re-runs the effect). */
  const slotsNow = () => {
    otherSlots();
    return pool.slots();
  };
  // The most windows playing at once on this source (Diagnostics -> Connections): a window counts after 10 s of
  // steady play, so one that opened and failed at once is not counted. A later cut verdict corrects any overcount.
  let since = new Map<number, number>();
  createEffect(() => {
    now(); // re-checked every second
    const t = Date.now();
    since = playingSince(since, slotsNow().map((s) => ({ n: s.n, playing: s.playback.status()?.kind === 'playing' })), t);
    const playing = steadyPlaying(since, t);
    const source = initState()?.activeSourceId;
    if (source && playing > 0) connectionMemory.seen(source, playing);
  });

  // ---- failures ----
  health.trackFailures(slotsNow);
  // The window with sound failed: the sound goes to one that has not (never silent over a message).
  createEffect(() => {
    const s = state();
    if (!s) return;
    const next = soundToPlaying(s, s.windows.map((_, i) => failure(i) === undefined));
    if (next !== s) update(next);
  });
  const starting = (i: number) => {
    const k = slotOf(i)?.playback.status()?.kind;
    return k === 'loading' || k === 'reconnecting';
  };
  const nameOf = (i: number) => {
    const w = windowAt(i);
    if (!w) return '';
    return slotOf(i)?.playback.current()?.name ?? names().get(w.channelId) ?? '';
  };

  // ---- keys ----
  const arrow = (dir: 'left' | 'right' | 'up' | 'down') => () => {
    if (woke()) return true;
    const s = state();
    const g = geometry();
    if (s && g && s.fullScreen === undefined) setState(moveFocus(s, dir, g));
    return true;
  };
  const onEnter = () => {
    if (woke()) return true;
    return openMenu();
  };
  const onBack = () => {
    if (router.topOverlay() !== undefined) return false;
    const s = state();
    if (s?.fullScreen !== undefined) {
      update(exitFullScreen(s));
      armIdle();
      return true;
    }
    leave();
    return true;
  };
  const onLongOk = () => {
    const s = state();
    if (!s || s.focus === 'empty') return true;
    update(s.fullScreen === undefined ? enterFullScreen(s, s.focus) : exitFullScreen(s));
    return true;
  };

  if (import.meta.env.DEV) (globalThis as { __multiview?: unknown }).__multiview = { state, menu, picker, freeingSlot, pickerInfo: () => pickerInfo(), overlays: () => router.overlays() };
  onMount(() => {
    const first = session.enter();
    if (!first) {
      alive = false;
      router.back();
      return;
    }
    const cur = playback.current();
    if (cur) remember(cur.id, cur.name);
    update(start(first));
    armIdle();
    root?.setFocus();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(tick));
    if (params.channelId && params.channelId !== first.channelId) {
      setPicker({ mode: 'add' });
      void pickChannel(params.channelId);
    } else {
      entryPicker = true;
      openPicker({ mode: 'add' });
    }
  });
  onCleanup(() => {
    watch.cancel();
    if (alive) {
      // Left another way (a hand-off, the sleep timer): the window with sound keeps playing as the single player.
      alive = false;
      session.leave();
    }
    if (restTimer !== undefined) clearTimeout(restTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    layers.removeAll();
  });

  /** The picker's info line (decision 12.2: it warns, it never blocks). */
  const pickerInfo = (): string | undefined => {
    const p = picker();
    const s = state();
    if (!p || !s) return undefined;
    const open = p.mode === 'add' ? s.windows.length : s.windows.length - 1;
    const lines = pickerHint({ open, freeing: freeingSlot() !== undefined }).map((key) => MULTIVIEW_COPY[key]);
    return lines.length > 0 ? lines.join(' ') : undefined;
  };

  const chrome = () => state()?.chromeAwake ?? true;
  const full = () => state()?.fullScreen;
  const tiles = () => geometry()?.tiles.filter((t) => full() === undefined || t.tile === full()) ?? [];

  return (
    <View ref={(el) => { root = el; }} width={LAYOUT.width} height={LAYOUT.height} onBack={onBack} onEnter={onEnter}
      onLeft={arrow('left')} onRight={arrow('right')} onUp={arrow('up')} onDown={arrow('down')}
      onLongOk={onLongOk} onMenu={() => openMenu()} onChannelUp={() => zap(1)} onChannelDown={() => zap(-1)}
      onInfo={() => { woke(); return true; }} onPlay={() => true} onPause={() => true}>
      <For each={tiles()}>{(t) => (
        <WindowHit rect={full() === t.tile ? { x: 0, y: 0, w: LAYOUT.width, h: LAYOUT.height } : t.rect}
          onHover={() => { const s = state(); if (s && full() === undefined && s.focus !== t.tile) { armIdle(); setState(pointerFocus(s, t.tile)); } }}
          onClick={() => { const s = state(); armIdle(); if (s && full() === undefined) update(click(s, t.tile)); }}
          onDoubleClick={() => { const s = state(); if (s) update(full() === undefined ? enterFullScreen(s, t.tile) : exitFullScreen(s)); }}
          onMenu={() => { openMenu(t.tile); }}
          onWheel={(dy) => { if (dy !== 0) volumeStep(dy < 0 ? 1 : -1); return true; }} />
      )}</For>
      <For each={tiles()}>{(t) => (
        <WindowChrome t={t} full={full()} awake={chrome()}
          focused={state()?.focus === t.tile && full() === undefined}
          sound={state()?.sound === t.tile && (state()?.windows.length ?? 0) > 1}
          fail={failure(t.tile)}
          freeing={freeingSlot() !== undefined && freeingSlot() === windowAt(t.tile)?.slot}
          starting={starting(t.tile)} name={nameOf(t.tile)}
          watchInstead={health.retryKind(t.tile) === 'watchInstead'} />
      )}</For>
      <Show when={geometry()?.empty && full() === undefined && chrome() ? geometry()!.empty : undefined}>{(e) => (
        <View x={e().rect.x} y={e().rect.y} width={e().rect.w} height={e().rect.h} color={COLORS.surface} borderRadius={RADIUS.card}>
          <Text y={e().rect.h / 2 - SPACE.xl} width={e().rect.w} contain="width" textAlign="center" fontSize={TYPE.title} color={COLORS.subtle}>+</Text>
          <Show when={state()?.focus === 'empty'}>
            <Text y={e().rect.h / 2 + SPACE.l} width={e().rect.w} contain="width" textAlign="center" fontSize={TYPE.body} color={COLORS.text}>{MULTIVIEW_COPY.addChannel}</Text>
          </Show>
        </View>
      )}</Show>
      <Show when={state()?.focus === 'empty' && full() === undefined && chrome() ? geometry()?.empty : undefined}>{(e) => (
        <View x={e().rect.x} y={e().rect.y}>
          <FocusRing w={e().rect.w} h={e().rect.h} radius={RADIUS.card} lit clear />
        </View>
      )}</Show>
      <Show when={menu() !== undefined}>
        <Sheet ref={(el) => { menuNode = el; }} title={nameOf(menu() ?? 0) || MULTIVIEW_COPY.entry} rows={menuEntries().map(fromMenuItem)}
          follow="id" backLayerId={MENU_ID} onSelect={(_, i) => { const it = menuEntries()[i]; if (it) choose(it.action); }} />
      </Show>
      <Show when={picker()}>
        <MultiviewPicker ref={(el) => { pickerNode = el; }} backRef={(fn) => { pickerBack = fn; }}
          title={picker()?.mode === 'change' ? MULTIVIEW_COPY.changeChannel : MULTIVIEW_COPY.addChannel}
          info={pickerInfo()} now={now()} onScreen={onScreen} onPick={(id) => { void pickChannel(id); }} />
      </Show>
    </View>
  );
}
