import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { PlayableChannel } from '@iptv/app-api';
import type { AspectMode } from '@iptv/player';
import { api, onEvent } from '../api.ts';
import { CooldownNotice } from '../components/CooldownNotice.tsx';
import { BANNER_H, InfoBanner } from '../components/InfoBanner.tsx';
import { NumberEntry } from '../components/NumberEntry.tsx';
import { OptionsMenu, type OptionItem } from '../components/OptionsMenu.tsx';
import { StreamInfoPanel } from '../components/StreamInfoPanel.tsx';
import { PlayerPointerOverlay } from '../components/PlayerPointerOverlay.tsx';
import { VolumeOsd } from '../components/VolumeOsd.tsx';
import { pointerMode, setPointerAutoHide, usePointerTarget } from '../input/pointer.ts';
import { withFailTest } from '../dev/failTest.ts';
import { channelHistory } from '../playback/channelHistory.ts';
import { cooling, retrySource } from '../playback/cooldown.ts';
import { createNumberEntry } from '../playback/numberEntry.ts';
import { devResume } from '../playback/devResume.ts';
import { playback, player, previewHold, supervisor } from '../playback/playback.ts';
import { createSleepTimer, nextSleepOption, type SleepState } from '../playback/sleepTimer.ts';
import { streamInfoLines } from '../playback/streamInfo.ts';
import { createZapper } from '../playback/zapper.ts';
import { ConfirmDialog } from '../shell/ConfirmDialog.tsx';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast, useToastFloor } from '../shell/Toast.tsx';
import { cooldown, settings } from '../state/appState.ts';
import { MESSAGE_BOXES, messageLines, messageTop } from '../components/messageFit.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
import { cooldownCopy, freshNow } from '../state/cooldownLogic.ts';
import {
  aspectLabel, bannerLift, bannerNowNextStale, createJumpGuard, isModalOpen, livePill, nextAspect, playerAutoHide, playerOverlayShown,
  playerStatusText, sleepLabel, wheelZapAllowed,
} from './playerLogic.ts';

const GROUP_ALL = 'all';
const BANNER_MS = 4000;
const ZAP_DELAY_MS = 300;
const NUMBER_IDLE_MS = 1500;
const FLASH_MS = 2000;
const OPTIONS_ID = 'playerOptions';
const INFO_ID = 'streamInfo';
const SLEEP_ID = 'stillWatching';
/** DEV-only (`?sleepTest=1`): sleep choices run in seconds-scale (x0.05) so the dialog can be reached quickly. */
const SLEEP_SCALE = import.meta.env.DEV && new URLSearchParams(location.search).has('sleepTest') ? 0.05 : 1;

/** Session-only choices (not persisted): aspect for every channel, audio track per channel. */
let sessionAspect: AspectMode = 'auto';
const audioChoice = new Map<string, string>();

/** Wraps channel lookups; in DEV, `?failTest=1` turns channel 1 into an unreachable stream. */
function lookup(p: Promise<PlayableChannel | undefined>): Promise<PlayableChannel | undefined> {
  return import.meta.env.DEV ? p.then(withFailTest) : p;
}

function Spinner(props: { x: number; y: number }) {
  const [tick, setTick] = createSignal(0);
  const t = setInterval(() => setTick((v) => (v + 1) % 8), 120);
  onCleanup(() => clearInterval(t));
  const dots = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <View x={props.x} y={props.y} width={36} height={36}>
      <For each={dots}>{(i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <View x={15 + Math.cos(a) * 13} y={15 + Math.sin(a) * 13} width={6} height={6} borderRadius={3}
            color={(i - tick() + 8) % 8 === 0 ? COLORS.focus : COLORS.muted} />
        );
      }}</For>
    </View>
  );
}

/**
 * Full-screen player. The stream is the shared `playback` one (Home already started it and switched the rect),
 * so entering never reconnects. Zapping, number entry, the banner, the Red previous-channel toggle, the options
 * menu (audio, aspect, sleep timer, stream info, favourite) and the reconnect/failed status live here.
 */
export function PlayerScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { channelId?: string; groupId?: string };
  let zapGroup = params.groupId ?? GROUP_ALL;

  const initial = playback.current();
  const [shown, setShown] = createSignal<PlayableChannel | undefined>(
    initial && initial.id === params.channelId ? initial : undefined,
  );
  const [bannerOn, setBannerOn] = createSignal(true);
  const [digits, setDigits] = createSignal('');
  const [flash, setFlash] = createSignal<string | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());
  const [menuPage, setMenuPage] = createSignal<'main' | 'audio' | undefined>(undefined);
  const [infoOn, setInfoOn] = createSignal(false);
  const [infoTick, setInfoTick] = createSignal(0);
  const [pillTick, setPillTick] = createSignal(0);
  const pill = createMemo(() => { pillTick(); return livePill(playback.status(), supervisor.liveInfo()); });
  const [aspect, setAspect] = createSignal<AspectMode>(sessionAspect);
  const [sleep, setSleep] = createSignal<SleepState>({ kind: 'off' });
  const [sleepMinutes, setSleepMinutes] = createSignal(0);

  let root: ElementNode | undefined;
  let menuNode: ElementNode | undefined;
  let alive = true;
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const removers = new Map<string, () => void>();
  const jumps = createJumpGuard();
  // Channels that were found by falling back to "All": committing one switches the zap group.
  const fallbackGroup = new WeakSet<PlayableChannel>();

  const focusRoot = () => queueMicrotask(() => { if (alive) root?.setFocus(); });

  // ---- banner ----

  const showBanner = () => {
    setNow(Date.now());
    setPillTick((v) => v + 1); // the pill is read fresh whenever the banner (re)appears
    setBannerOn(true);
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => setBannerOn(false), BANNER_MS);
  };
  const hideBanner = () => {
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    bannerTimer = undefined;
    setBannerOn(false);
  };
  const flashMessage = (text: string) => {
    setFlash(text);
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(undefined), FLASH_MS);
  };

  // ---- channel switching ----

  /** Plays `ch` now (the stream restarts only when it is a different or failed channel). */
  const commit = (ch: PlayableChannel) => {
    if (!alive) return;
    playback.playChannel(ch);
    setShown(ch);
    channelHistory.visit(ch.id);
    zapper.setCurrent(ch.id);
    if (fallbackGroup.has(ch)) zapGroup = GROUP_ALL;
    showBanner();
    api.markWatched(ch.id, zapGroup).catch(() => undefined);
  };

  /** Neighbour within the zap group; a channel outside it (after number entry) falls back to "All". */
  const neighbour = async (anchor: string, offset: number) => {
    const inGroup = await lookup(api.neighbour(zapGroup, anchor, offset));
    if (inGroup || zapGroup === GROUP_ALL) return inGroup;
    const inAll = await lookup(api.neighbour(GROUP_ALL, anchor, offset));
    if (inAll) fallbackGroup.add(inAll);
    return inAll;
  };

  const zapper = createZapper<PlayableChannel>({
    delayMs: ZAP_DELAY_MS,
    resolve: neighbour,
    onPreview: (ch) => { if (alive) { setShown(ch); showBanner(); } },
    onCommit: commit,
    onMiss: () => { if (alive) setShown(playback.current() ?? shown()); },
  });

  const zap = (delta: number) => {
    numbers.clear();
    jumps.bump();
    zapper.press(delta);
    return true;
  };

  const jumpTo = async (load: () => Promise<PlayableChannel | undefined>, missText?: string) => {
    devResume.release(); // the user started a channel (spec §3.1)
    const mine = jumps.bump();
    try {
      const ch = await lookup(load());
      if (!alive || !jumps.isCurrent(mine)) return;
      if (ch) {
        zapper.cancel();
        commit(ch);
      } else if (missText) {
        flashMessage(missText);
      }
    } catch (err) {
      console.warn('Channel change failed', err instanceof Error ? err.name : 'Error');
    }
  };

  const numbers = createNumberEntry({
    idleMs: NUMBER_IDLE_MS,
    maxDigits: 4,
    onChange: (t) => { setDigits(t); if (t) setFlash(undefined); },
    onSubmit: (n) => void jumpTo(() => api.byNumber(n), `No channel ${n}`),
  });

  const previous = () => {
    const prev = channelHistory.previous();
    if (prev) void jumpTo(() => api.getPlayable(prev), 'Previous channel not available');
    return true;
  };

  // ---- audio track memory ----

  createEffect(on(() => [playback.status()?.kind, playback.current()?.id] as const, ([kind, id]) => {
    if (kind !== 'playing' || !id) return;
    const want = audioChoice.get(id);
    if (want !== undefined && player.audioTracks().some((t) => t.id === want && !t.active)) player.selectAudioTrack(want);
  }));

  // ---- sleep timer ----

  const sleepTimer = createSleepTimer({
    onChange: (s) => {
      const wasAsking = sleep().kind === 'asking';
      setSleep(s);
      if (s.kind === 'asking') {
        if (!wasAsking) openOverlay(SLEEP_ID, keepWatching);
      } else removeOverlay(SLEEP_ID);
      if (s.kind === 'off') setSleepMinutes(0);
    },
    onExpire: () => { if (alive) sleepStop(); },
  });

  /** "Keep watching" (button or Back): focus returns to the options menu when it is open, else to the root. */
  function keepWatching() {
    sleepTimer.stillWatching();
    if (menuPage()) queueMicrotask(() => { if (alive) menuNode?.setFocus(); });
    else focusRoot();
  }

  /** Closes this screen's layers, then pops it (back to Home, which focuses `lastChannelId`). */
  const leave = (lastChannelId?: string) => {
    for (const id of [...removers.keys()]) removeOverlay(id);
    while (router.topOverlay() !== undefined) router.back();
    router.back(lastChannelId !== undefined ? { focusChannelId: lastChannelId } : undefined);
  };

  /** The sleep timer ran out (or "Stop"): stop playback and return to Home on the last watched channel. */
  function sleepStop() {
    const last = playback.current()?.id ?? shown()?.id;
    playback.stop();
    previewHold.set();
    leave(last);
  }

  // ---- overlays ----

  function openOverlay(id: string, onClose: () => void) {
    removers.get(id)?.();
    removers.set(id, router.pushOverlay(id, () => { removers.delete(id); onClose(); }));
  }
  function removeOverlay(id: string) {
    const r = removers.get(id);
    removers.delete(id);
    r?.();
  }

  const closeMenu = () => {
    removeOverlay(OPTIONS_ID);
    setMenuPage(undefined);
    focusRoot();
  };
  const openMenu = () => {
    if (menuPage()) return true;
    numbers.clear();
    hideBanner();
    setMenuPage('main');
    openOverlay(OPTIONS_ID, onMenuClosed);
    queueMicrotask(() => menuNode?.setFocus());
    return true;
  };
  const onMenuClosed = () => { setMenuPage(undefined); focusRoot(); };
  const setInfo = (visible: boolean) => {
    setInfoOn(visible);
    if (visible) {
      openOverlay(INFO_ID, () => setInfoOn(false));
      // Keep the menu as the top layer, so Back closes it before the panel.
      if (menuPage()) openOverlay(OPTIONS_ID, onMenuClosed);
    } else {
      removeOverlay(INFO_ID);
    }
  };

  const menuItems = createMemo<OptionItem[]>(() => {
    now();
    const page = menuPage();
    if (page === 'audio') {
      const tracks = player.audioTracks();
      if (tracks.length === 0) return [{ id: 'back', label: 'No other audio tracks' }];
      return [
        ...tracks.map((t) => ({ id: `track:${t.id}`, label: t.label, value: t.active ? 'Selected' : '' })),
        { id: 'back', label: 'Back' },
      ];
    }
    const active = player.audioTracks().find((t) => t.active);
    return [
      { id: 'audio', label: 'Audio track', value: active?.label ?? 'Default' },
      { id: 'aspect', label: 'Aspect ratio', value: aspectLabel(aspect()) },
      { id: 'sleep', label: 'Sleep timer', value: sleepLabel(sleepMinutes(), sleep().kind === 'armed' ? sleepTimer.minutesLeft() : undefined) },
      { id: 'info', label: 'Stream info', value: infoOn() ? 'On' : 'Off' },
      { id: 'favourite', label: shown()?.favourite ? 'Remove from favourites' : 'Add to favourites' },
    ];
  });

  const choose = (id: string) => {
    if (id === 'audio') {
      setMenuPage('audio');
      queueMicrotask(() => menuNode?.setFocus());
    } else if (id === 'back') {
      setMenuPage('main');
      queueMicrotask(() => menuNode?.setFocus());
    } else if (id.startsWith('track:')) {
      const trackId = id.slice('track:'.length);
      player.selectAudioTrack(trackId);
      const cur = playback.current();
      if (cur) audioChoice.set(cur.id, trackId);
      setMenuPage('main');
      queueMicrotask(() => menuNode?.setFocus());
    } else if (id === 'aspect') {
      const next = nextAspect(aspect());
      sessionAspect = next;
      setAspect(next);
      player.setAspect(next);
    } else if (id === 'sleep') {
      const next = nextSleepOption(sleepMinutes());
      setSleepMinutes(next);
      sleepTimer.set(next * SLEEP_SCALE);
    } else if (id === 'info') {
      setInfo(!infoOn());
    } else if (id === 'favourite') {
      const ch = shown();
      closeMenu();
      if (!ch) return;
      api.toggleFavourite(ch.id).then((on) => {
        if (!alive) return;
        if (shown()?.id === ch.id) setShown({ ...ch, favourite: on });
        showToast(on ? 'Added to favourites' : 'Removed from favourites');
      }).catch(() => showToast("Couldn't change this channel."));
    }
  };

  const infoLines = () => {
    infoTick();
    return streamInfoLines(player.streamInfo(), player.currentUrl(), playback.status());
  };

  // ---- keys ----

  const modal = () => isModalOpen(sleep().kind, menuPage());
  /** Keys that the dialog / options menu own: swallowed here while one is open. */
  const unlessModal = (fn: () => boolean) => () => (modal() ? true : fn());
  const onEnter = () => {
    if (numbers.submit()) return true;
    // While the source cools down, OK is Retry (the centre message says so).
    if (cooling()) {
      void retrySource();
      return true;
    }
    // Behind live with the banner up: OK jumps to live (the pill says so) and keeps the banner.
    if (bannerOn()) setPillTick((v) => v + 1); // act on a fresh pill, not one up to 1 s old
    if (bannerOn() && pill()?.hint) {
      supervisor.goLive();
      showBanner();
      return true;
    }
    if (bannerOn()) hideBanner();
    else showBanner();
    return true;
  };
  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    if (numbers.active()) { numbers.clear(); return true; }
    if (bannerOn()) { hideBanner(); return true; }
    return false; // back to Home
  };
  const digitHandlers = Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [`onDigit${d}`, unlessModal(() => { numbers.digit(d); return true; })]),
  );

  // ---- pointer (mouse, pointer remote) ----

  const [overButton, setOverButton] = createSignal(false);
  /** The pointer is over the volume pill (counts as a button for the auto-hide). */
  const [overVolume, setOverVolume] = createSignal(false);
  const overlayShown = () => playerOverlayShown(pointerMode(), modal());
  // Toasts ("Added to favourites", guide refresh failures) end above the banner, which they would otherwise cover.
  useToastFloor(() => (bannerOn() && shown()
    ? LAYOUT.height - LAYOUT.safeY - BANNER_H - bannerLift(overlayShown()) - LAYOUT.gap
    : undefined));
  /** `⛶ Window` and double click: back to Home with the small video (past a Guide or Search below the Player). */
  const toHome = () => {
    leave();
    while (router.depth() > 1 && router.current()?.screen !== 'home') router.back();
  };
  /** `▦ Guide`. The entry keeps the channel now playing, so Back from the Guide does not jump to the first one. */
  const openGuide = () => {
    const cur = playback.current();
    if (cur) params.channelId = cur.id;
    params.groupId = zapGroup;
    router.push('guide', { groupId: zapGroup });
  };
  const toggleBanner = () => {
    if (bannerOn()) hideBanner();
    else showBanner();
  };
  // The whole screen, registered before the overlay's buttons (screen layer too, so they win where they are drawn
  // without making the Player modal): wheel zaps (down = Ch+), right click opens Options, double click is `⛶ Window`.
  const pointerOptions = () => { if (!modal()) openMenu(); };
  let lastWheelZap: number | undefined;
  const pointerWheel = (dy: number) => {
    if (dy === 0 || modal()) return true;
    const now = Date.now();
    if (!wheelZapAllowed(lastWheelZap, now)) return true;
    lastWheelZap = now;
    zap(dy > 0 ? 1 : -1);
    return true;
  };
  usePointerTarget({
    node: () => root,
    onDoubleClick: () => { if (!modal()) toHome(); },
    onContextMenu: pointerOptions,
    onWheel: pointerWheel,
  });

  // ---- lifecycle ----

  onMount(() => {
    playback.setRect('fullscreen');
    player.setAspect(sessionAspect);
    showBanner();
    // Default sleep timer (Settings > Playback): armed for each fullscreen session.
    const defaultSleep = settings()?.sleepTimerMinutes ?? 0;
    if (defaultSleep > 0) {
      setSleepMinutes(defaultSleep);
      sleepTimer.set(defaultSleep * SLEEP_SCALE);
    }
    // The previous screen's focused node is gone: take focus so the keys reach this screen.
    root?.setFocus();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const infoTimer = setInterval(() => { if (infoOn()) setInfoTick((v) => v + 1); }, 1000);
    const pillTimer = setInterval(() => { if (bannerOn()) setPillTick((v) => v + 1); }, 1000);
    // A background short-EPG answer for the playing channel: the visible banner re-reads its now/next.
    const offNowNext = onEvent('nowNextUpdated', (e) => {
      const id = playback.current()?.id;
      if (!id || !bannerNowNextStale((e as { channelIds: string[] }).channelIds, id, shown()?.id, bannerOn())) return;
      api.getPlayable(id).then((ch) => {
        if (alive && ch && shown()?.id === id && playback.current()?.id === id) setShown(ch);
      }).catch(() => undefined);
    });
    onCleanup(() => { clearInterval(tick); clearInterval(infoTimer); clearInterval(pillTimer); offNowNext(); });
    // Pointer mode ends after 3 s without movement here, unless the pointer is over an overlay button or a modal is open.
    onCleanup(setPointerAutoHide(() => playerAutoHide({ overButton: overButton() || overVolume(), modalOpen: modal() })));

    const cur = playback.current();
    if (cur && cur.id === params.channelId) {
      channelHistory.visit(cur.id);
      zapper.setCurrent(cur.id);
    } else if (params.channelId) {
      const id = params.channelId;
      void jumpTo(() => api.getPlayable(id));
    }
  });

  onCleanup(() => {
    alive = false;
    zapper.cancel();
    numbers.clear();
    sleepTimer.dispose();
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    for (const id of [...removers.keys()]) removeOverlay(id);
    for (const id of [OPTIONS_ID, INFO_ID, SLEEP_ID]) router.removeOverlay(id);
    // Home's preview uses the default picture.
    player.setAspect('auto');
  });

  const coolCopy = createMemo(() => cooldownCopy(cooldown(), freshNow(now()), pointerMode()));
  // The cooldown message replaces the stream status: nothing is open while it shows.
  const status = createMemo(() => (coolCopy() ? undefined : playerStatusText(playback.status(), activeMaxConnections())));
  const showClock = () => settings()?.showClock === true;
  const TOAST_W = 460;
  const CENTRE_W = 1100;
  const CENTRE_BOX = MESSAGE_BOXES.player;
  const centreH = (text: string) => Math.max(160, messageLines(text, CENTRE_BOX) * CENTRE_BOX.lineH + 80);

  return (
    <View ref={root} width={LAYOUT.width} height={LAYOUT.height} onBack={onBack} onEnter={onEnter}
      onStop={() => (onBack() ? true : (leave(), true))} onPlay={() => true} onPause={() => true}
      onUp={unlessModal(() => zap(1))} onDown={unlessModal(() => zap(-1))}
      onChannelUp={unlessModal(() => zap(1))} onChannelDown={unlessModal(() => zap(-1))}
      onLeft={() => true} onRight={() => true}
      onInfo={unlessModal(() => { if (bannerOn()) hideBanner(); else showBanner(); return true; })}
      onMenu={unlessModal(openMenu)} onLongOk={unlessModal(openMenu)} onRed={unlessModal(previous)} {...digitHandlers}>
      <Show when={status()} keyed>{(s) => (
        s.kind === 'toast'
          ? (
            <View x={(LAYOUT.width - TOAST_W) / 2} y={LAYOUT.safeY} width={TOAST_W} height={64} color={COLORS.panel}
              borderRadius={32} zIndex={25}>
              <Spinner x={22} y={14} />
              <Text x={72} y={(64 - FONT.body) / 2 - 4} fontSize={FONT.body} color={COLORS.text}>{s.text}</Text>
            </View>
          )
          : (
            // A refusal that names the account's limit runs to three lines: the box grows for it.
            <View x={(LAYOUT.width - CENTRE_W) / 2} y={(LAYOUT.height - centreH(s.text)) / 2} width={CENTRE_W} height={centreH(s.text)}
              color={COLORS.panel} borderRadius={LAYOUT.radius * 2} zIndex={4}>
              <Text x={40} y={messageTop(s.text, CENTRE_BOX, centreH(s.text))} width={CENTRE_W - 80}
                maxWidth={CENTRE_W - 80} contain="width" textAlign="center" maxLines={CENTRE_BOX.maxLines} lineHeight={CENTRE_BOX.lineH}
                fontSize={FONT.heading} color={COLORS.text}>{s.text}</Text>
            </View>
          )
      )}</Show>

      <Show when={coolCopy()}>{(c) => (
        <CooldownNotice x={(LAYOUT.width - 1100) / 2} y={(LAYOUT.height - 240) / 2} width={1100} height={240}
          text={c().text} hint={c().hint} fontSize={FONT.heading} onRetry={() => { void retrySource(); }} />
      )}</Show>

      <Show when={bannerOn() ? shown() : undefined}>{(ch) => (
        <InfoBanner channel={ch()} now={now()} showClock={showClock()} live={pill()} lift={bannerLift(overlayShown())} />
      )}</Show>

      <Show when={digits() || flash()}>
        <NumberEntry text={digits()} message={digits() ? undefined : flash()} />
      </Show>

      <PlayerPointerOverlay visible={overlayShown()} onHoverChange={setOverButton}
        onBack={() => leave()} onChannelUp={() => zap(1)} onChannelDown={() => zap(-1)} onPrevious={previous}
        onInfo={toggleBanner} onOptions={openMenu} onGuide={openGuide} onWindow={toHome}
        onWheel={pointerWheel} onContextMenu={pointerOptions} />

      {/* Desktop volume: + and - keys; with the pointer bar hidden a change shows a short top-right pill. */}
      <VolumeOsd inBar={overlayShown()} onHoverChange={setOverVolume} />

      <Show when={infoOn()}>
        <StreamInfoPanel lines={infoLines()} />
      </Show>

      <Show when={menuPage()} keyed>{(page) => (
        <OptionsMenu ref={(el) => { menuNode = el; }} title={page === 'audio' ? 'Audio track' : 'Options'}
          items={menuItems()} onChoose={choose} />
      )}</Show>

      <Show when={sleep().kind === 'asking' ? sleep() : undefined}>{(s) => (
        <ConfirmDialog
          message={`Still watching? Stopping in ${(s() as { secondsLeft: number }).secondsLeft} s`}
          yes="Stop" no="Keep watching"
          onYes={() => { removeOverlay(SLEEP_ID); sleepTimer.set(0); sleepStop(); }}
          onNo={() => { removeOverlay(SLEEP_ID); keepWatching(); }} />
      )}</Show>
    </View>
  );
}
