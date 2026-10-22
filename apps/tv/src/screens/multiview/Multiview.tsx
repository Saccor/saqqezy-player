import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { GROUP_ALL } from '@iptv/core';
import { api } from '../../api.ts';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu.tsx';
import { MULTIVIEW_COPY } from '../../copy.ts';
import { usePointerTarget } from '../../input/pointer.ts';
import {
  clearWindowNote, connectionMemory, deviceWindowMax, otherSlots, playback, pool, setInMultiview, windowNotes,
} from '../../playback/playback.ts';
import { tileFailure } from '../../playback/tileFailure.ts';
import { router, type ScreenEntry } from '../../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../../shell/theme.ts';
import { activeMaxConnections } from '../../state/activeLimit.ts';
import { initState, settings } from '../../state/appState.ts';
import { volumeStep } from '../../video/volume.ts';
import { layout, type Rect, type TileGeometry } from './layout.ts';
import { MultiviewPicker } from './MultiviewPicker.tsx';
import {
  CHROME_IDLE_MS, SOUND_REST_MS, addWindow, click, closeWindow, enterFullScreen, equalSize, exitFullScreen, focusRested, idle,
  layoutInput, makeLarge, menuItems, moveFocus, pointerFocus, soundToPlaying, start, togglePin, wake, type MenuId, type MvState,
  type MvWindow,
} from './mvLogic.ts';
import { createMultiviewSession } from './session.ts';
import { tileProfile } from './tileProfile.ts';
import { canAddWindow, deviceCeiling, windowLimit } from './windows.ts';

const MENU_ID = 'multiviewMenu';
const PICKER_ID = 'multiviewPicker';
type MenuAction = MenuId | 'retry' | 'cancel';

/** A window's pointer area: hover focuses it (the sound follows after the rest), click, double click, right click. */
function WindowHit(props: {
  rect: Rect; onHover: () => void; onClick: () => void; onDoubleClick: () => void; onMenu: () => void; onWheel: (dy: number) => boolean;
}) {
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node,
    onHover: (p) => { if (p) props.onHover(); },
    onClick: () => props.onClick(),
    onDoubleClick: () => props.onDoubleClick(),
    onContextMenu: () => props.onMenu(),
    onWheel: (dy) => props.onWheel(dy),
  });
  return <View ref={(el) => { node = el; }} x={props.rect.x} y={props.rect.y} width={props.rect.w} height={props.rect.h} />;
}

/**
 * Multiview (spec 2026-10-20-multiview; owner decisions §12 and 2026-10-22): several live channels at once on desktop.
 * The windows are playback slots placed at `layout()`'s rects; this screen draws the chrome over them (ring, sound
 * disc, label, status) and drives the state in `mvLogic`. The sound is the pool's primary slot and follows the focus
 * (D-pad or hover) after a 400 ms rest. Leaving keeps the window with sound playing full screen: no reconnect.
 */
export function MultiviewScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { channelId?: string };
  const limit = () => windowLimit(deviceCeiling(deviceWindowMax()), settings()?.maxWindows ?? 'auto');
  const [state, setState] = createSignal<MvState | undefined>(undefined);
  const [picker, setPicker] = createSignal<{ mode: 'add' } | { mode: 'change'; index: number } | undefined>(undefined);
  const [menu, setMenu] = createSignal<number | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());
  /** When each slot's stream failed (for Retry's 3 s rest). */
  const failedAt = new Map<number, number>();
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
  const windowAt = (i: number): MvWindow | undefined => state()?.windows[i];
  const slotOf = (i: number) => {
    const w = windowAt(i);
    return w ? pool.slots().find((s) => s.n === w.slot) : undefined;
  };
  const onScreen = (channelId: string) => state()?.windows.some((w) => w.channelId === channelId) ?? false;
  const canAdd = () => {
    const s = state();
    const r = canAddWindow({ deviceMax: deviceCeiling(deviceWindowMax()), userMax: settings()?.maxWindows ?? 'auto', open: s?.windows.length ?? 0 });
    if (r.ok) return { ok: true as const };
    return { ok: false as const, reason: r.reason === 'setting' ? MULTIVIEW_COPY.setting(r.limit) : MULTIVIEW_COPY.device(r.limit) };
  };

  const leave = (keep?: MvWindow) => {
    if (!alive) return;
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
      clearWindowNote(w.slot);
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

  const retry = (i: number) => {
    const w = windowAt(i);
    if (!w) return;
    clearWindowNote(w.slot);
    failedAt.delete(w.slot);
    void session.changeChannel(w, w.channelId);
  };

  const zap = (delta: 1 | -1) => {
    const s = state();
    if (!s || s.focus === 'empty') return true;
    const w = s.windows[s.focus];
    if (!w) return true;
    const i = s.focus;
    api.neighbour(GROUP_ALL, w.channelId, delta).then(async (ch) => {
      if (!ch || !alive) return;
      remember(ch.id, ch.name);
      clearWindowNote(w.slot);
      const changed = await session.changeChannel(w, ch.id);
      const cur = state();
      if (alive && changed && cur) update({ ...cur, windows: cur.windows.map((x, k) => (k === i ? changed : x)) });
    }).catch(() => undefined);
    return true;
  };

  // ---- overlays ----
  const removers = new Map<string, () => void>();
  const openOverlay = (id: string, onClose: () => void) => {
    removers.get(id)?.();
    removers.set(id, router.pushOverlay(id, () => { removers.delete(id); onClose(); }));
  };
  const removeOverlay = (id: string) => {
    const r = removers.get(id);
    removers.delete(id);
    r?.();
  };
  const closeOverlays = () => { removeOverlay(MENU_ID); removeOverlay(PICKER_ID); setMenu(undefined); setPicker(undefined); };
  const focusRoot = () => queueMicrotask(() => root?.setFocus());

  const openPicker = (mode: { mode: 'add' } | { mode: 'change'; index: number }) => {
    setMenu(undefined);
    removeOverlay(MENU_ID);
    setPicker(mode);
    const layer = () => openOverlay(PICKER_ID, () => {
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
    removeOverlay(PICKER_ID);
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
    openOverlay(MENU_ID, () => { setMenu(undefined); focusRoot(); });
    queueMicrotask(() => menuNode?.setFocus());
    return true;
  };
  const closeMenu = () => { removeOverlay(MENU_ID); setMenu(undefined); focusRoot(); };

  const menuEntries = createMemo<ContextMenuItem<MenuAction>[]>(() => {
    const s = state();
    const i = menu();
    if (!s || i === undefined) return [];
    const out: ContextMenuItem<MenuAction>[] = [];
    if (failure(i)?.retry.enabled) out.push({ action: 'retry', label: MULTIVIEW_COPY.retry });
    for (const it of menuItems(s, i, canAdd())) out.push({ action: it.id, label: it.disabled ? `${it.label}: ${it.disabled}` : it.label });
    out.push({ action: 'cancel', label: 'Cancel' });
    return out;
  });

  const choose = (action: MenuAction) => {
    const s = state();
    const i = menu();
    if (!s || i === undefined) { closeMenu(); return; }
    if (action === 'addChannel') {
      if (canAdd().ok) openPicker({ mode: 'add' });
      return;
    }
    if (action === 'changeChannel') { openPicker({ mode: 'change', index: i }); return; }
    closeMenu();
    if (action === 'retry') retry(i);
    else if (action === 'fullScreen') update(enterFullScreen(s, i));
    else if (action === 'makeLarge') update(makeLarge(s, i));
    else if (action === 'equalSize') update(equalSize(s));
    else if (action === 'keepSound' || action === 'soundFollows') update(togglePin(s, i));
    else if (action === 'closeWindow') {
      const w = s.windows[i];
      if (w) session.close(w);
      const next = closeWindow(s, i);
      if ('leave' in next) leave(next.leave);
      else update(next);
    }
  };

  /** Every slot, read reactively (a new window or a sound move re-runs the effect). */
  const slotsNow = () => {
    otherSlots();
    return pool.slots();
  };
  // The most windows playing at once on this source (Diagnostics -> Connections).
  createEffect(() => {
    const playing = slotsNow().filter((s) => s.playback.status()?.kind === 'playing').length;
    const source = initState()?.activeSourceId;
    if (source && playing > 0) connectionMemory.seen(source, playing);
  });

  // ---- failures ----
  createEffect(() => {
    for (const s of slotsNow()) {
      const kind = s.playback.status()?.kind;
      if (kind === 'failed' && !failedAt.has(s.n)) failedAt.set(s.n, Date.now());
      else if (kind !== 'failed') failedAt.delete(s.n);
    }
  });
  const failure = (i: number) => {
    const w = windowAt(i);
    const slot = slotOf(i);
    if (!w || !slot) return undefined;
    const note = windowNotes().get(w.slot);
    const st = slot.playback.status();
    const t = now();
    if (note?.deviceLimit) {
      return tileFailure({ reason: st?.kind === 'failed' ? st.reason : 'unsupported', deviceLimit: true, at: note.at, now: t });
    }
    if (note) {
      const kicked = note.kicked ?? (note.pingPong ? Math.max(1, (state()?.windows.length ?? 2) - 1) : undefined);
      return tileFailure({ reason: 'refused', ...(kicked !== undefined ? { kicked } : {}), escalated: note.escalated === true, at: note.at, now: t });
    }
    if (st?.kind !== 'failed') return undefined;
    const reported = activeMaxConnections();
    return tileFailure({
      reason: st.reason, at: failedAt.get(w.slot) ?? t, now: t,
      ...(st.httpStatus !== undefined ? { httpStatus: st.httpStatus } : {}),
      ...(reported !== undefined ? { maxConnections: reported } : {}),
    });
  };
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

  if (import.meta.env.DEV) (globalThis as { __multiview?: unknown }).__multiview = { state, menu, picker, overlays: () => router.overlays() };
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
    if (alive) {
      // Left another way (a hand-off, the sleep timer): the window with sound keeps playing as the single player.
      alive = false;
      session.leave();
    }
    if (restTimer !== undefined) clearTimeout(restTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    for (const id of [...removers.keys()]) removeOverlay(id);
  });

  const chrome = () => state()?.chromeAwake ?? true;
  const full = () => state()?.fullScreen;
  const tiles = () => geometry()?.tiles.filter((t) => full() === undefined || t.tile === full()) ?? [];

  const Chrome = (p: { t: TileGeometry }) => {
    const t = () => p.t;
    const r = () => (full() === t().tile ? { x: 0, y: 0, w: LAYOUT.width, h: LAYOUT.height } : t().rect);
    const large = () => full() === t().tile || t().sizeClass === 'large';
    const focused = () => state()?.focus === t().tile && full() === undefined;
    const sound = () => state()?.sound === t().tile && (state()?.windows.length ?? 0) > 1;
    const fail = () => failure(t().tile);
    const pad = () => (large() ? 24 : 16);
    const scrimH = () => (large() ? 128 : 72);
    return (
      <View>
        <Show when={focused() && chrome()}>
          <View x={t().ring.x} y={t().ring.y} width={t().ring.w} height={t().ring.h} borderRadius={18}
            border={{ width: 4, color: COLORS.focus }} />
        </Show>
        <Show when={fail()}>{(f) => (
          <View x={r().x} y={r().y} width={r().w} height={r().h} color={COLORS.surface} borderRadius={LAYOUT.radius}>
            <Text x={pad()} y={r().h / 2 - 60} width={r().w - pad() * 2} maxWidth={r().w - pad() * 2} contain="width" maxLines={3}
              textAlign="center" fontSize={large() ? TYPE.body : TYPE.meta} color={COLORS.text}>{f().text}</Text>
            <Text x={pad()} y={r().h / 2 + 40} width={r().w - pad() * 2} maxWidth={r().w - pad() * 2} contain="width" maxLines={1}
              textAlign="center" fontSize={TYPE.meta} color={COLORS.muted}>
              {f().retry.enabled ? `OK: ${MULTIVIEW_COPY.retry} · ${MULTIVIEW_COPY.closeWindow}` : `OK: ${MULTIVIEW_COPY.closeWindow}`}
            </Text>
          </View>
        )}</Show>
        <Show when={!fail() && starting(t().tile)}>
          <View x={r().x + pad()} y={r().y + pad()} width={160} height={40} borderRadius={20} color={COLORS.panel}>
            <Text x={16} y={7} fontSize={TYPE.meta} color={COLORS.text}>{MULTIVIEW_COPY.starting}</Text>
          </View>
        </Show>
        <Show when={sound()}>
          <View x={r().x + r().w - pad() - (large() ? 48 : 40)} y={r().y + pad()} width={large() ? 48 : 40} height={large() ? 48 : 40}
            borderRadius={large() ? 24 : 20} color={COLORS.panel} alpha={chrome() ? 1 : 0.7}>
            <Text y={large() ? 10 : 7} width={large() ? 48 : 40} contain="width" textAlign="center" fontSize={TYPE.meta} color={COLORS.text}>♪</Text>
          </View>
        </Show>
        <Show when={chrome() && !fail()}>
          <View x={r().x} y={r().y + r().h - scrimH()} width={r().w} height={scrimH()} color={COLORS.osd}>
            <Text x={pad()} y={scrimH() - (large() ? 72 : 52)} width={r().w - pad() * 2} maxWidth={r().w - pad() * 2} contain="width"
              maxLines={1} fontSize={large() ? TYPE.body : TYPE.meta} {...STRONG} color={COLORS.text}>{nameOf(t().tile)}</Text>
          </View>
        </Show>
      </View>
    );
  };

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
      <For each={tiles()}>{(t) => <Chrome t={t} />}</For>
      <Show when={geometry()?.empty && full() === undefined && chrome() ? geometry()!.empty : undefined}>{(e) => (
        <View x={e().rect.x} y={e().rect.y} width={e().rect.w} height={e().rect.h} color={COLORS.surface} borderRadius={LAYOUT.radius}>
          <Text y={e().rect.h / 2 - 30} width={e().rect.w} contain="width" textAlign="center" fontSize={TYPE.display} color={COLORS.subtle}>+</Text>
          <Show when={state()?.focus === 'empty'}>
            <Text y={e().rect.h / 2 + 30} width={e().rect.w} contain="width" textAlign="center" fontSize={TYPE.body} color={COLORS.text}>{MULTIVIEW_COPY.addChannel}</Text>
          </Show>
        </View>
      )}</Show>
      <Show when={state()?.focus === 'empty' && full() === undefined && chrome() ? geometry()?.empty : undefined}>{(e) => (
        <View x={e().ring.x} y={e().ring.y} width={e().ring.w} height={e().ring.h} borderRadius={18} border={{ width: 4, color: COLORS.focus }} />
      )}</Show>
      <Show when={menu() !== undefined}>
        <ContextMenu ref={(el) => { menuNode = el; }} title={nameOf(menu() ?? 0) || MULTIVIEW_COPY.entry}
          items={menuEntries()} cancel="cancel" onChoose={choose} />
      </Show>
      <Show when={picker()}>
        <MultiviewPicker ref={(el) => { pickerNode = el; }} backRef={(fn) => { pickerBack = fn; }}
          title={picker()?.mode === 'change' ? MULTIVIEW_COPY.changeChannel : MULTIVIEW_COPY.addChannel}
          now={now()} onScreen={onScreen} onPick={(id) => { void pickChannel(id); }} />
      </Show>
    </View>
  );
}
