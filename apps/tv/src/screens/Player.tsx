import { sendKey } from '../input/keys.ts';
import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { PlayableChannel } from '@iptv/app-api';
import type { AspectMode } from '@iptv/player';
import { api, onEvent } from '../api.ts';
import { CATCHUP_COPY, FAV_COPY, MULTIVIEW_COPY, SOURCE_COPY, favChangedToast, favToggleLabel } from '../copy.ts';
import { CooldownNotice } from '../components/CooldownNotice.tsx';
import { BANNER_H, InfoBanner } from '../components/InfoBanner.tsx';
import { NumberEntry } from '../components/NumberEntry.tsx';
import { OptionsMenu, type OptionItem } from '../components/OptionsMenu.tsx';
import { StatusPill } from '../components/StatusPill.tsx';
import { StreamInfoPanel } from '../components/StreamInfoPanel.tsx';
import { PlayerPointerOverlay } from '../components/PlayerPointerOverlay.tsx';
import { VolumeOsd } from '../components/VolumeOsd.tsx';
import { pointerMode, setPointerAutoHide, usePointerTarget } from '../input/pointer.ts';
import { withFailTest } from '../dev/failTest.ts';
import { channelHistory } from '../playback/channelHistory.ts';
import { cooling, retrySource } from '../playback/cooldown.ts';
import { createNumberEntry } from '../playback/numberEntry.ts';
import { devResume } from '../playback/devResume.ts';
import { deviceWindowMax, playback, player, pool, previewHold, sleepTimer, supervisor } from '../playback/playback.ts';
import { nextSleepOption, type SleepState } from '../playback/sleepTimer.ts';
import { rowIdOf, sourceOptions } from '../playback/sourceLogic.ts';
import { mediaBadges } from '../playback/mediaBadges.ts';
import { streamInfoLines } from '../playback/streamInfo.ts';
import { createZapper } from '../playback/zapper.ts';
import { ConfirmDialog } from '../shell/ConfirmDialog.tsx';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, MOTION, RADIUS, STRONG, TYPE } from '../shell/theme.ts';
import { showToast, useToastFloor } from '../shell/Toast.tsx';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { cooldown, settings } from '../state/appState.ts';
import { MESSAGE_BOXES, messageLines, messageTop } from '../components/messageFit.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
import { cooldownCopy, freshNow } from '../state/cooldownLogic.ts';
import { channelLanguageInput, pickAudioTrack, trackKey, trackLabels } from '../vod/tracks.ts';
import {
  aspectLabel, bannerLift, bannerNowNextStale, createJumpGuard, isModalOpen, livePill, nextAspect, playerAutoHide, playerOverlayShown,
  multiviewOffered, playerLeave, playerStatusText, sleepLabel, wheelZapAllowed,
} from './playerLogic.ts';
import { deviceCeiling, windowLimit } from './multiview/windows.ts';

const GROUP_ALL = 'all';
const BANNER_MS = MOTION.autoHide;
const ZAP_DELAY_MS = 300;
const NUMBER_IDLE_MS = 1500;
const FLASH_MS = 2000;
const OPTIONS_ID = 'playerOptions';
const INFO_ID = 'streamInfo';
const SLEEP_ID = 'stillWatching';
/** DEV-only (`?sleepTest=1`): sleep choices run in seconds-scale (x0.05) so the dialog can be reached quickly. */
const SLEEP_SCALE = import.meta.env.DEV && new URLSearchParams(location.search).has('sleepTest') ? 0.05 : 1;

/** Session-only choice (not persisted): aspect for every channel. */
let sessionAspect: AspectMode = 'auto';
/**
 * The audio track chosen per channel (a `trackKey`), read from the worker once per channel and kept here for the
 * session: `has` means the worker was asked, an undefined value means it remembers nothing.
 */
const audioChoice = new Map<string, string | undefined>();

/** Wraps channel lookups; in DEV, `?failTest=1` turns channel 1 into an unreachable stream. */
function lookup(p: Promise<PlayableChannel | undefined>): Promise<PlayableChannel | undefined> {
  return import.meta.env.DEV ? p.then(withFailTest) : p;
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
    initial && rowIdOf(initial) === params.channelId ? initial : undefined,
  );
  const [bannerOn, setBannerOn] = createSignal(true);
  const [digits, setDigits] = createSignal('');
  const [flash, setFlash] = createSignal<string | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());
  const [menuPage, setMenuPage] = createSignal<'main' | 'audio' | 'source' | undefined>(undefined);
  const [infoOn, setInfoOn] = createSignal(false);
  const [infoTick, setInfoTick] = createSignal(0);
  const [pillTick, setPillTick] = createSignal(0);
  const pill = createMemo(() => { pillTick(); return livePill(playback.status(), supervisor.liveInfo()); });
  /** The channel's (or its group's) language prefix, for audio tracks that name no language. */
  const liveLangs = () => {
    const c = playback.current();
    return channelLanguageInput(c?.name, c?.group);
  };
  // What is playing, as badges in the banner: re-read on the pill's 1 s tick, redrawn only when a badge changes.
  const badges = createMemo((): string[] => {
    pillTick();
    if (!bannerOn()) return [];
    const languages = liveLangs();
    return mediaBadges({ info: player.streamInfo(), audio: playback.audioTracks(), text: playback.textTracks(), ...(languages ? { languages } : {}) });
  }, [], { equals: (a, b) => a.join('|') === b.join('|') });
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
    // The row, not the stream: a combined channel's streams take turns under one row.
    const row = rowIdOf(ch)!;
    channelHistory.visit(row);
    zapper.setCurrent(row);
    if (fallbackGroup.has(ch)) zapGroup = GROUP_ALL;
    showBanner();
    api.markWatched(row, zapGroup).catch(() => undefined);
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

  /**
   * Once a channel plays: the remembered track for it, else the preferred language from Settings (`pickAudioTrack`;
   * a language pick is applied but not remembered as the user's choice). The memory is read from the worker the first
   * time a channel plays this session.
   */
  const applyAudio = async (id: string) => {
    if (!audioChoice.has(id)) {
      const key = await api.getLiveAudio(id).catch(() => undefined);
      if (!audioChoice.has(id)) audioChoice.set(id, key);
    }
    if (!alive || playback.current()?.id !== id || playback.status()?.kind !== 'playing') return;
    const t = pickAudioTrack(player.audioTracks(), audioChoice.get(id), settings()?.audioLanguage ?? 'auto');
    if (t && !t.active) player.selectAudioTrack(t.id);
  };

  createEffect(on(() => [playback.status()?.kind, playback.current()?.id] as const, ([kind, id]) => {
    if (kind !== 'playing' || !id) return;
    void applyAudio(id);
  }));

  // ---- sleep timer ----

  // The timer itself is the app's (`playback.sleepTimer`): this screen attaches to it on mount and mirrors its state.
  const onSleepChange = (s: SleepState) => {
    const wasAsking = sleep().kind === 'asking';
    setSleep(s);
    if (s.kind === 'asking') {
      if (!wasAsking) openOverlay(SLEEP_ID, keepWatching);
    } else removeOverlay(SLEEP_ID);
    if (s.kind === 'off') setSleepMinutes(0);
    else if (s.kind === 'armed') setSleepMinutes(Math.round(s.minutes / SLEEP_SCALE));
  };

  /** "Keep watching" (button or Back): focus returns to the options menu when it is open, else to the root. */
  function keepWatching() {
    sleepTimer.stillWatching();
    if (menuPage()) queueMicrotask(() => { if (alive) menuNode?.setFocus(); });
    else focusRoot();
  }

  /** Closes this screen's own layers (without their close handlers: the screen is going away). */
  const closeLayers = () => { for (const id of [...removers.keys()]) removeOverlay(id); };

  /** Closes this screen's layers, then pops it. Home below focuses `lastChannelId`; Start or Search get no param. */
  const leave = (lastChannelId?: string) => {
    closeLayers();
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
      if (tracks.length === 0) return [{ id: 'back', label: 'No audio track list for this stream' }];
      if (tracks.length === 1) return [{ id: 'back', label: 'Only one audio track' }];
      const labels = trackLabels(tracks, 'audio', liveLangs());
      return [
        ...tracks.map((t, i) => ({ id: `track:${t.id}`, label: labels[i] ?? t.label, value: t.active ? 'Selected' : '' })),
        { id: 'back', label: 'Back' },
      ];
    }
    const cur = playback.current();
    const sources = cur?.sources ?? [];
    if (page === 'source') {
      return [
        ...sourceOptions(sources, cur?.id).map((o) => ({ id: `src:${o.id}`, label: o.label })),
        { id: 'back', label: 'Back' },
      ];
    }
    const tracks = player.audioTracks();
    const activeAt = tracks.findIndex((t) => t.active);
    return [
      { id: 'audio', label: 'Audio track', value: activeAt >= 0 ? trackLabels(tracks, 'audio', liveLangs())[activeAt] ?? 'Default' : 'Default' },
      { id: 'aspect', label: 'Aspect ratio', value: aspectLabel(aspect()) },
      { id: 'sleep', label: 'Sleep timer', value: sleepLabel(sleepMinutes(), sleep().kind === 'armed' ? sleepTimer.minutesLeft() : undefined) },
      { id: 'info', label: 'Stream info', value: infoOn() ? 'On' : 'Off' },
      // Several channels at once, where this device can play them (spec 2026-10-20-multiview §2.1).
      ...(multiviewOffered(windowLimit(deviceCeiling(deviceWindowMax()), settings()?.maxWindows ?? 'auto'))
        ? [{ id: 'multiview', label: MULTIVIEW_COPY.entry }] : []),
      { id: 'favourite', label: favToggleLabel(shown()?.favourite === true) },
      // Catch-up channel with a programme on now: play it from its start (spec 2026-10-20-catch-up §5.2).
      ...(shown()?.archiveDays !== undefined && shown()?.now ? [{ id: 'fromStart', label: CATCHUP_COPY.fromStart }] : []),
      // A combined channel: pick which of its streams plays.
      ...(sources.length > 1 ? [{ id: 'source', label: SOURCE_COPY.source, value: `${sources.length}` }] : []),
    ];
  });

  const choose = (id: string) => {
    if (id === 'multiview') {
      closeMenu();
      router.push('multiview', {});
      return;
    }
    if (id === 'audio' || id === 'source') {
      setMenuPage(id);
      queueMicrotask(() => menuNode?.setFocus());
    } else if (id.startsWith('src:')) {
      // Choose source: that stream plays now and first from now on (a new tune).
      const sourceId = id.slice('src:'.length);
      const row = playback.currentRowId();
      closeMenu();
      if (row) api.pickLiveSource(row, sourceId).catch(() => undefined);
      void jumpTo(() => api.getPlayable(sourceId, { exact: true }));
    } else if (id === 'back') {
      setMenuPage('main');
      queueMicrotask(() => menuNode?.setFocus());
    } else if (id.startsWith('track:')) {
      const trackId = id.slice('track:'.length);
      const t = player.audioTracks().find((x) => x.id === trackId);
      player.selectAudioTrack(trackId);
      const cur = playback.current();
      if (cur && t) {
        const key = trackKey(t);
        audioChoice.set(cur.id, key);
        api.setLiveAudio(cur.id, key).catch((err) => console.warn('Audio choice save failed', err));
      }
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
    } else if (id === 'fromStart') {
      const ch = shown();
      closeMenu();
      if (!ch?.now) return;
      api.getCatchupPlayable(ch.id, ch.now.start).then((r) => {
        if (!alive) return;
        if ('kind' in r) router.push('vodPlay', { catchup: r });
        else showToast(CATCHUP_COPY.notAvailable);
      }, (err) => console.warn('From the start failed', err instanceof Error ? err.name : 'Error'));
    } else if (id === 'favourite') {
      const ch = shown();
      closeMenu();
      if (!ch) return;
      api.toggleFavourite(ch.id).then((on) => {
        if (!alive) return;
        if (shown()?.id === ch.id) setShown({ ...ch, favourite: on });
        showToast(favChangedToast(on));
      }).catch(() => showToast(FAV_COPY.failed));
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
  /**
   * Back to Live TV, the root `home` (past a Search below the Player), in one stack change; never a second Live TV.
   * `focusChannelId` is the row Live TV focuses. Without a Live TV in the stack it is a plain leave.
   */
  const returnToLive = (focusChannelId?: string) => {
    closeLayers();
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
    const stopInfo = visibleInterval(() => { if (infoOn()) setInfoTick((v) => v + 1); }, 1000);
    const stopPill = visibleInterval(() => { if (bannerOn()) setPillTick((v) => v + 1); }, 1000);
    // A background short-EPG answer for the playing channel: the visible banner re-reads its now/next.
    const offNowNext = onEvent('nowNextUpdated', (e) => {
      const id = playback.currentRowId();
      const stream = playback.current()?.id;
      if (!id || !stream || !bannerNowNextStale((e as { channelIds: string[] }).channelIds, id, rowIdOf(shown()), bannerOn())) return;
      // The stream on screen exactly: the banner of a combined channel never swaps to another stream's playable.
      api.getPlayable(stream, { exact: true }).then((ch) => {
        if (alive && ch && rowIdOf(shown()) === id && playback.current()?.id === stream) setShown(ch);
      }).catch(() => undefined);
    });
    onCleanup(() => { stopTick(); stopInfo(); stopPill(); offNowNext(); });
    // Pointer mode ends after 3 s without movement here, unless the pointer is over an overlay button or a modal is open.
    onCleanup(setPointerAutoHide(() => playerAutoHide({ overButton: overButton() || overVolume(), modalOpen: modal() })));

    const curRow = playback.currentRowId();
    if (curRow !== undefined && curRow === params.channelId) {
      channelHistory.visit(curRow);
      zapper.setCurrent(curRow);
    } else if (params.channelId) {
      const id = params.channelId;
      void jumpTo(() => api.getPlayable(id));
    }
  });

  onCleanup(() => {
    alive = false;
    zapper.cancel();
    numbers.clear();
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
  const CENTRE_W = 1100;
  const CENTRE_BOX = MESSAGE_BOXES.player;
  const centreH = (text: string) => Math.max(160, messageLines(text, CENTRE_BOX) * CENTRE_BOX.lineH + 80);

  return (
    <View ref={root} width={LAYOUT.width} height={LAYOUT.height} onBack={onBack} onEnter={onEnter}
      onStop={() => { sendKey('Back'); return true; }} onPlay={() => true} onPause={() => true}
      onUp={unlessModal(() => zap(1))} onDown={unlessModal(() => zap(-1))}
      onChannelUp={unlessModal(() => zap(1))} onChannelDown={unlessModal(() => zap(-1))}
      onLeft={() => true} onRight={() => true}
      onInfo={unlessModal(() => { if (bannerOn()) hideBanner(); else showBanner(); return true; })}
      onMenu={unlessModal(openMenu)} onLongOk={unlessModal(openMenu)} onRed={unlessModal(previous)} {...digitHandlers}>
      <Show when={status()} keyed>{(s) => (
        s.kind === 'toast'
          ? <StatusPill text={s.text} spinner zIndex={25} />
          : (
            // A refusal that names the account's limit runs to three lines: the box grows for it.
            <View x={(LAYOUT.width - CENTRE_W) / 2} y={(LAYOUT.height - centreH(s.text)) / 2} width={CENTRE_W} height={centreH(s.text)}
              color={COLORS.panel} borderRadius={RADIUS.card} zIndex={4}>
              <Text x={40} y={messageTop(s.text, CENTRE_BOX, centreH(s.text))} width={CENTRE_W - 80}
                maxWidth={CENTRE_W - 80} contain="width" textAlign="center" maxLines={CENTRE_BOX.maxLines} lineHeight={CENTRE_BOX.lineH}
                fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{s.text}</Text>
            </View>
          )
      )}</Show>

      <Show when={coolCopy()}>{(c) => (
        <CooldownNotice x={(LAYOUT.width - 1100) / 2} y={(LAYOUT.height - 240) / 2} width={1100} height={240}
          text={c().text} hint={c().hint} fontSize={TYPE.body} onRetry={() => { void retrySource(); }} />
      )}</Show>

      <Show when={bannerOn() ? shown() : undefined}>{(ch) => (
        <InfoBanner channel={ch()} now={now()} showClock={showClock()} live={pill()} lift={bannerLift(overlayShown())} badges={badges()} />
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
        <OptionsMenu ref={(el) => { menuNode = el; }} title={page === 'audio' ? 'Audio track' : page === 'source' ? SOURCE_COPY.choose : 'Options'}
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
