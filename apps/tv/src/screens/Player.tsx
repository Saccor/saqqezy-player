import { sendKey } from '../input/keys.ts';
import { Show, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { api, onEvent } from '../api.ts';
import { COMMON_COPY, PLAYER_COPY, SOURCE_COPY } from '../copy.ts';
import { Sheet } from '../components/Sheet.tsx';
import { useNotice } from '../components/Notice.tsx';
import { KeyValuePanel } from '../components/KeyValuePanel.tsx';
import { PlayerBanner } from './playerBanner.tsx';
import { PlayerPointerOverlay } from '../components/PlayerPointerOverlay.tsx';
import { VolumeOsd } from '../components/VolumeOsd.tsx';
import { pointerMode, setPointerAutoHide, usePointerTarget } from '../input/pointer.ts';
import { cooling, retrySource } from '../playback/cooldown.ts';
import { playback, player, previewHold, sleepTimer, supervisor } from '../playback/playback.ts';
import type { SleepState } from '../playback/sleepTimer.ts';
import { rowIdOf } from '../playback/sourceLogic.ts';
import { mediaBadges } from '../playback/mediaBadges.ts';
import { Dialog } from '../components/Dialog.tsx';
import { createLayerSet } from '../shell/layerSet.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { LAYOUT, MOTION } from '../shell/theme.ts';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { cooldown, settings } from '../state/appState.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
import { cooldownCopy, freshNow } from '../state/cooldownLogic.ts';
import {
  bannerLift, bannerNowNextStale, isModalOpen, livePill, playerAutoHide, playerOverlayShown, playerLeave, playerStatusText,
  wheelZapAllowed,
} from './playerLogic.ts';
import { createChannelSwitch } from './player/createChannelSwitch.ts';
import { INFO_ID, OPTIONS_ID, createPlayerOptions, liveLangs, sessionAspectNow } from './player/createPlayerOptions.ts';
import { PlayerCentreMessage } from './player/PlayerCentreMessage.tsx';

const BANNER_MS = MOTION.autoHide;
const FLASH_MS = 2000;
const SLEEP_ID = 'stillWatching';
/** DEV-only (`?sleepTest=1`): sleep choices run in seconds-scale (x0.05) so the dialog can be reached quickly. */
const SLEEP_SCALE = import.meta.env.DEV && new URLSearchParams(location.search).has('sleepTest') ? 0.05 : 1;

/**
 * Full-screen player. The stream is the shared `playback` one (Home already started it and switched the rect),
 * so entering never reconnects. Zapping, number entry, the banner, the Red previous-channel toggle, the options
 * menu (audio, aspect, sleep timer, stream info, favourite) and the reconnect/failed status live here; the channel
 * changes are in `player/createChannelSwitch.ts` and the Options sheet in `player/createPlayerOptions.ts`.
 */
export function PlayerScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { channelId?: string; groupId?: string };

  const [bannerOn, setBannerOn] = createSignal(true);
  const [digits, setDigits] = createSignal('');
  const [flash, setFlash] = createSignal<string | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());
  const [pillTick, setPillTick] = createSignal(0);
  const pill = createMemo(() => { pillTick(); return livePill(playback.status(), supervisor.liveInfo()); });
  // What is playing, as badges in the banner: re-read on the pill's 1 s tick, redrawn only when a badge changes.
  const badges = createMemo((): string[] => {
    pillTick();
    if (!bannerOn()) return [];
    const languages = liveLangs();
    return mediaBadges({ info: player.streamInfo(), audio: playback.audioTracks(), text: playback.textTracks(), ...(languages ? { languages } : {}) });
  }, [], { equals: (a, b) => a.join('|') === b.join('|') });
  const [sleep, setSleep] = createSignal<SleepState>({ kind: 'off' });
  const [sleepMinutes, setSleepMinutes] = createSignal(0);

  let root: ElementNode | undefined;
  let alive = true;
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const layers = createLayerSet();

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

  // ---- channel switching and the Options sheet ----

  const channels = createChannelSwitch({
    alive: () => alive, channelId: params.channelId, groupId: params.groupId, showBanner, flashMessage,
    onDigits: (t) => { setDigits(t); if (t) setFlash(undefined); },
  });
  const { shown, zap, jumpTo, previous, numbers } = channels;

  const options = createPlayerOptions({
    alive: () => alive, layers, now, shown, setShown: channels.setShown, sleep, sleepMinutes, setSleepMinutes, sleepScale: SLEEP_SCALE,
    focusRoot, beforeOpen: () => { numbers.clear(); hideBanner(); }, jumpTo,
  });
  const { menuPage, openMenu } = options;

  // ---- sleep timer ----

  // The timer itself is the app's (`playback.sleepTimer`): this screen attaches to it on mount and mirrors its state.
  const onSleepChange = (s: SleepState) => {
    const wasAsking = sleep().kind === 'asking';
    setSleep(s);
    if (s.kind === 'asking') {
      if (!wasAsking) layers.open(SLEEP_ID, keepWatching);
    } else layers.remove(SLEEP_ID);
    if (s.kind === 'off') setSleepMinutes(0);
    else if (s.kind === 'armed') setSleepMinutes(Math.round(s.minutes / SLEEP_SCALE));
  };

  /** "Keep watching" (button or Back): focus returns to the options menu when it is open, else to the root. */
  function keepWatching() {
    sleepTimer.stillWatching();
    if (!options.focusMenuIfOpen()) focusRoot();
  }

  /** Closes this screen's layers, then pops it. Home below focuses `lastChannelId`; Start or Search get no param. */
  const leave = (lastChannelId?: string) => {
    layers.removeAll();
    while (router.topOverlay() !== undefined) router.back();
    router.back(playerLeave(router.below()?.screen, lastChannelId).params);
  };

  /** The sleep timer ran out (or "Stop"): stop playback and return to the screen below (Home: on the last watched channel, held). */
  function sleepStop() {
    const last = playback.currentRowId() ?? rowIdOf(shown());
    playback.stop();
    if (playerLeave(router.below()?.screen, last).holdPreview) previewHold.set();
    leave(last);
  }

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
    if (bannerOn() && pill()?.behind) {
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
  /**
   * Back to Live TV, the root `home` (past a Search below the Player), in one stack change; never a second Live TV.
   * `focusChannelId` is the row Live TV focuses. Without a Live TV in the stack it is a plain leave.
   */
  const returnToLive = (focusChannelId?: string) => {
    layers.removeAll();
    if (!router.backTo('home', focusChannelId !== undefined ? { focusChannelId } : undefined)) leave(focusChannelId);
  };
  /** `⛶ Window` and double click: back to Live TV with the small video. */
  const toHome = () => returnToLive();
  /** `▦ Guide`: Live TV is the guide; it opens on the channel now playing. */
  const openGuide = () => returnToLive(playback.currentRowId() ?? params.channelId);
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
    const t = Date.now();
    if (!wheelZapAllowed(lastWheelZap, t)) return true;
    lastWheelZap = t;
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
    player.setAspect(sessionAspectNow());
    showBanner();
    // The shared timer: an armed one (from a Player before Live TV) shows its minutes, an open question
    // reopens its dialog. Else the default (Settings > Playback) is armed for this fullscreen session.
    const detachSleep = sleepTimer.attach({ onChange: onSleepChange, onExpire: () => { if (alive) sleepStop(); } });
    onCleanup(detachSleep);
    const defaultSleep = settings()?.sleepTimerMinutes ?? 0;
    if (defaultSleep > 0 && sleepTimer.state().kind === 'off' && !sleepTimer.userOff()) sleepTimer.set(defaultSleep * SLEEP_SCALE);
    // The previous screen's focused node is gone: take focus so the keys reach this screen.
    root?.setFocus();
    // The ticks sleep while the page is hidden (visibleInterval).
    const stopTick = visibleInterval(() => setNow(Date.now()), 30_000);
    const stopInfo = visibleInterval(options.tickInfo, 1000);
    const stopPill = visibleInterval(() => { if (bannerOn()) setPillTick((v) => v + 1); }, 1000);
    // A background short-EPG answer for the playing channel: the visible banner re-reads its now/next.
    const offNowNext = onEvent('nowNextUpdated', (e) => {
      const id = playback.currentRowId();
      const stream = playback.current()?.id;
      if (!id || !stream || !bannerNowNextStale((e as { channelIds: string[] }).channelIds, id, rowIdOf(shown()), bannerOn())) return;
      // The stream on screen exactly: the banner of a combined channel never swaps to another stream's playable.
      api.getPlayable(stream, { exact: true }).then((ch) => {
        if (alive && ch && rowIdOf(shown()) === id && playback.current()?.id === stream) channels.setShown(ch);
      }).catch(() => undefined);
    });
    onCleanup(() => { stopTick(); stopInfo(); stopPill(); offNowNext(); });
    // Pointer mode ends after 3 s without movement here, unless the pointer is over an overlay button or a modal is open.
    onCleanup(setPointerAutoHide(() => playerAutoHide({ overButton: overButton() || overVolume(), modalOpen: modal() })));

    const curRow = playback.currentRowId();
    if (curRow !== undefined && curRow === params.channelId) {
      channels.adopt(curRow);
    } else if (params.channelId) {
      const id = params.channelId;
      void jumpTo(() => api.getPlayable(id));
    }
  });

  onCleanup(() => {
    alive = false;
    channels.dispose();
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    layers.removeAll();
    for (const id of [OPTIONS_ID, INFO_ID, SLEEP_ID]) router.removeOverlay(id);
    // Home's preview uses the default picture.
    player.setAspect('auto');
  });

  const coolCopy = createMemo(() => cooldownCopy(cooldown(), freshNow(now())));
  // The cooldown message replaces the stream status: nothing is open while it shows.
  const status = createMemo(() => (coolCopy() ? undefined : playerStatusText(playback.status(), activeMaxConnections())));
  useNotice(() => {
    const s = status();
    return s?.kind === 'toast' ? { id: 'player-status', kind: 'wait', text: s.text, spinner: true } : undefined;
  });
  useNotice(() => {
    const c = coolCopy();
    return c ? { id: 'player-cooldown', kind: 'error', text: c.text, action: COMMON_COPY.tryAgain, onAction: () => { void retrySource(); } } : undefined;
  });
  useNotice(() => {
    if (digits()) return { id: 'player-number', kind: 'wait', text: digits(), numeral: true };
    const f = flash();
    return f ? { id: 'player-number', kind: 'info', text: f } : undefined;
  });
  const showClock = () => settings()?.showClock === true;

  return (
    <View ref={root} width={LAYOUT.width} height={LAYOUT.height} onBack={onBack} onEnter={onEnter}
      onStop={() => { sendKey('Back'); return true; }} onPlay={() => true} onPause={() => true}
      onUp={unlessModal(() => zap(1))} onDown={unlessModal(() => zap(-1))}
      onChannelUp={unlessModal(() => zap(1))} onChannelDown={unlessModal(() => zap(-1))}
      onLeft={() => true} onRight={() => true}
      onInfo={unlessModal(() => { if (bannerOn()) hideBanner(); else showBanner(); return true; })}
      onMenu={unlessModal(openMenu)} onLongOk={unlessModal(openMenu)} onRed={unlessModal(previous)} {...digitHandlers}>
      <PlayerCentreMessage status={status()} />

      <Show when={bannerOn() ? shown() : undefined}>{(ch) => (
        <PlayerBanner channel={ch()} now={now()} showClock={showClock()} live={pill()} lift={bannerLift(overlayShown())} badges={badges()} />
      )}</Show>

      <PlayerPointerOverlay visible={overlayShown()} onHoverChange={setOverButton}
        onBack={() => leave()} onChannelUp={() => zap(1)} onChannelDown={() => zap(-1)} onPrevious={previous}
        onInfo={toggleBanner} onOptions={openMenu} onGuide={openGuide} onWindow={toHome}
        onWheel={pointerWheel} onContextMenu={pointerOptions} />

      {/* Desktop volume: + and - keys; with the pointer bar hidden a change shows a short top-right pill. */}
      <VolumeOsd inBar={overlayShown()} onHoverChange={setOverVolume} />

      <Show when={options.infoOn()}>
        <KeyValuePanel x={LAYOUT.safeX} y={LAYOUT.safeY} width={600} title={PLAYER_COPY.streamInfo} lines={options.infoLines()} framed />
      </Show>

      <Show when={menuPage()} keyed>{(page) => (
        <Sheet ref={options.menuRef} title={page === 'audio' ? PLAYER_COPY.audioTrack : page === 'source' ? SOURCE_COPY.choose : PLAYER_COPY.options}
          rows={options.menuRows()} onSelect={(r) => options.choose(r.id)} scrim={false} swallow="player" zIndex={40} />
      )}</Show>

      <Show when={sleep().kind === 'asking' ? sleep() : undefined}>{(s) => (
        <Dialog title={PLAYER_COPY.stillWatching} line={PLAYER_COPY.stoppingIn((s() as { secondsLeft: number }).secondsLeft)}
          yes={PLAYER_COPY.stop} no={PLAYER_COPY.keepWatching}
          onYes={() => { layers.remove(SLEEP_ID); sleepTimer.set(0); sleepStop(); }}
          onNo={() => { layers.remove(SLEEP_ID); keepWatching(); }} />
      )}</Show>
    </View>
  );
}
