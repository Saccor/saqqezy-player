import { Show, Text, View, activeElement, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { useFocusManager } from '@lightningtv/solid/primitives';
import { profileFor } from '@iptv/platform';
import { PointerBar } from './components/PointerBar.tsx';
import { shellBack } from './input/pointer.ts';
import { api, onEvent } from './api.ts';
import { LIGHTNING_KEY_MAP } from './input/keys.ts';
import { otherSlots, playback } from './playback/playback.ts';
import { AddSourceScreen } from './screens/AddSource.tsx';
import { LiveTvScreen } from './screens/live/LiveTv.tsx';
import { MovieDetailScreen } from './screens/MovieDetail.tsx';
import { PlaceholderScreen } from './screens/Placeholder.tsx';
import { SeriesDetailScreen } from './screens/SeriesDetail.tsx';
import { PlayerScreen } from './screens/Player.tsx';
import { SearchScreen } from './screens/Search.tsx';
import { VodBrowseScreen } from './screens/VodBrowse.tsx';
import { StartScreen } from './screens/Start.tsx';
import { StartSportsScreen } from './screens/StartSports.tsx';
import { VodGridScreen } from './screens/VodGrid.tsx';
import { VodPlayScreen } from './screens/VodPlay.tsx';
import { Clock } from './shell/Clock.tsx';
import { ConfirmDialog } from './shell/ConfirmDialog.tsx';
import { DebugOverlay } from './shell/DebugOverlay.tsx';
import { InitError } from './shell/InitError.tsx';
import { LazyScreen } from './shell/LazyScreen.tsx';
import { isLazyScreen, LAZY_SCREENS, lazyModule, preloadInTurn, type LazyModule, type LazyScreenId } from './shell/lazyModule.ts';
import type { ScreenEntry } from './shell/router.ts';
import {
  BOTTOM_ROW_H, BOTTOM_ROW_Y, deferWordmark, EXIT_OVERLAY_ID, fullscreenVideoRoute, SHELL_BACK_LABEL, SHELL_BACK_W, screenOverlayOpen, shellBackShown, shellBackX,
  OFFLINE_BADGE_W, OFFLINE_BADGE_X, railRoute, showWordmark, WORDMARK_MAX_WAIT_MS,
} from './shell/logic.ts';
import { deviceCountry } from './platform/deviceCountry.ts';
import { rootBack, exitApp } from './shell/platformExit.ts';
import { screenUnderlay } from './shell/motionLogic.ts';
import { router } from './shell/router.ts';
import { COLORS, LAYOUT, TYPE } from './shell/theme.ts';
import { Toast, showToast } from './shell/Toast.tsx';
import { Wordmark } from './shell/Wordmark.tsx';
import { reloadSourceLimit } from './state/activeLimit.ts';
import { screenEnter, setMotionLevel } from './shell/motion.ts';
import { onBackOnline } from './state/backOnline.ts';
import { bootstrap, cooldown, cooldownForStream, initFailed, initState, offline, platformId, settings, startupMs, wireEvents } from './state/appState.ts';
import { afterFrame } from './video/afterFrame.ts';
import { createVodPreloader, idleSchedule } from './vod/preload.ts';

const EXIT_ID = EXIT_OVERLAY_ID;
/** What Back at the root does on this platform (our dialog, LG's platform back, or leave). */
const EXIT_POLICY = profileFor(platformId).exitPolicy;
const BADGE_H = 48;

type EntryProps = { entry: ScreenEntry };
/**
 * Rare screens: loaded on first use, or in idle time after the first channel row (spec 2026-10-26 §0.3). Live TV, the
 * Player, Start, Search, Add source (the first-run screen) and the Movies/Series screens stay in the start bundle.
 */
const LAZY: Record<LazyScreenId, LazyModule<EntryProps>> = {
  settings: lazyModule<EntryProps>(() => import('./screens/Settings.tsx').then((m) => m.SettingsScreen)),
  countries: lazyModule<EntryProps>(() => import('./screens/Countries.tsx').then((m) => m.CountriesScreen)),
  multiview: lazyModule<EntryProps>(() => import('./screens/multiview/Multiview.tsx').then((m) => m.MultiviewScreen)),
};

function OfflineBadge() {
  return (
    <View x={OFFLINE_BADGE_X} y={LAYOUT.safeY - 4} width={OFFLINE_BADGE_W} height={BADGE_H}
      color={COLORS.surface} borderRadius={BADGE_H / 2} border={{ width: 2, color: COLORS.muted }} zIndex={10}>
      <Text y={(BADGE_H - TYPE.meta) / 2 - 3} width={OFFLINE_BADGE_W} maxWidth={OFFLINE_BADGE_W} contain="width" textAlign="center"
        maxLines={1} fontSize={TYPE.meta} color={COLORS.text}>{'Offline · saved list'}</Text>
    </View>
  );
}

/**
 * App shell: screen stack, layered Back (overlays first, then screens, then the exit question), toasts,
 * brand wordmark, offline badge, clock and debug HUD. Playback lives in the `playback` singleton (src/playback/playback.ts).
 */
export function App() {
  useFocusManager(LIGHTNING_KEY_MAP);
  // Movies tab warm-up: once live playback is up, load the stored movie catalogue in idle time (no network).
  // Movies only: preloading series too would double the resident catalogue memory (one resident kind).
  const preloadVod = createVodPreloader({ preload: () => api.preloadVod('movie'), schedule: idleSchedule });
  createEffect(() => preloadVod(playback.status()?.kind, initState()?.activeSourceId));
  // Settings › Display › Motion (unset: the system's reduced-motion preference).
  createEffect(() => setMotionLevel(settings()?.motion));
  // The failure text names the Xtream account's connection limit: read it for the active source, and again after a
  // refusal (a refresh may have learnt a new limit since).
  const refused = () => {
    const s = playback.status();
    return s?.kind === 'failed' && s.reason === 'refused';
  };
  createEffect(on(() => [initState(), refused()] as const, ([state, r], prev) => {
    if (state && (prev === undefined || prev[0]?.activeSourceId !== state.activeSourceId || (r && !prev[1]))) void reloadSourceLimit();
  }));

  const [current, setCurrent] = createSignal(router.current());
  onCleanup(router.subscribe(setCurrent));
  // Rare screens compile in idle time once the first screen (whichever it is) has painted, so their first open does
  // not wait. One shot.
  let rarePreloaded = false;
  createEffect(() => {
    if (rarePreloaded || current() === undefined) return;
    rarePreloaded = true;
    afterFrame(() => void preloadInTurn(LAZY_SCREENS.map((id) => LAZY[id]), idleSchedule));
  });
  const [overlayIds, setOverlayIds] = createSignal(router.overlays());
  onCleanup(router.subscribeOverlays(setOverlayIds));
  // The wordmark's canvas is drawn after the cold start (first Home rows), or after a short wait at most.
  const [wordmarkWaitedOut, setWordmarkWaitedOut] = createSignal(false);
  const wordmarkTimer = setTimeout(() => setWordmarkWaitedOut(true), WORDMARK_MAX_WAIT_MS);
  onCleanup(() => clearTimeout(wordmarkTimer));
  const wordmarkDeferred = () => deferWordmark({
    route: current()?.screen, initFailed: initFailed(), startupMarked: startupMs() !== undefined, waitedOut: wordmarkWaitedOut(),
  });

  const [exitOpen, setExitOpen] = createSignal(false);
  let screenHost: ElementNode | undefined;
  // A pushed screen fades in (not Back, cold start or video screens); after the new screen's nodes exist.
  createEffect(on(current, (entry, from) => { if (screenHost) screenEnter(screenHost, entry, from); }, { defer: true }));
  let focusBeforeDialog: ElementNode | undefined;

  const closeExit = () => {
    setExitOpen(false);
    const back = focusBeforeDialog;
    focusBeforeDialog = undefined;
    // After the dialog's nodes are gone, return focus to where it was (or to the current screen).
    queueMicrotask(() => ((back?.rendered ? back : undefined) ?? screenHost)?.setFocus());
  };
  const openExit = () => {
    focusBeforeDialog = activeElement();
    setExitOpen(true);
    router.pushOverlay(EXIT_ID, closeExit);
  };
  const answerExit = (yes: boolean) => {
    router.removeOverlay(EXIT_ID);
    closeExit();
    if (yes) exitApp(platformId);
  };

  // Every Back that no focused element handled lands here. At the root it follows the platform's exit rule; a held
  // Back (repeated keydown) never opens or answers anything there.
  const onBack = (e?: KeyboardEvent) => {
    // The repeats of the held Back that opened the exit question must not close it again.
    if (e?.repeat === true && exitOpen()) return true;
    if (router.back() !== 'root') return true;
    if (rootBack(EXIT_POLICY, platformId, e?.repeat === true) === 'dialog') openExit();
    return true;
  };

  // The active source started cooling down (or a stream began reconnecting while it is): stop a stream that is not
  // playing, so the supervisor's retries send nothing. A stream that plays keeps playing. When the cooldown ends
  // (the wait ran out, or Retry), the channel it held back opens.
  createEffect(on(() => cooldown().state, (state, prev) => {
    if (state !== 'clear') playback.holdForCooldown();
    else if (prev !== undefined && prev !== 'clear') playback.resumeHeld();
  }));
  createEffect(() => {
    if (cooldown().state !== 'clear' && playback.status()) playback.holdForCooldown();
  });
  // Multiview windows without sound: the same hold and resume, each by its own stream's host.
  createEffect(() => {
    for (const s of otherSlots()) {
      const coolingState = () => cooldownForStream(s.playback.current()).state;
      createEffect(on(coolingState, (state, prev) => {
        if (state !== 'clear') s.playback.holdForCooldown();
        else if (prev !== undefined && prev !== 'clear') s.playback.resumeHeld();
      }));
      createEffect(() => {
        if (coolingState() !== 'clear' && s.playback.status()) s.playback.holdForCooldown();
      });
    }
  });

  onMount(() => {
    onCleanup(wireEvents(onEvent, showToast, {
      api, router, playing: () => playback.current() !== undefined, stopPlayback: () => playback.stop(),
    }));
    // Back online: an unreachable wait of the active source was our own outage, so it ends (the worker decides).
    onCleanup(onBackOnline(globalThis.window, () => {
      api.networkOnline().catch((err: unknown) => console.warn('Back-online retry failed', err instanceof Error ? err.name : 'Error'));
    }));
    void bootstrap(api, router);
    // Your countries: this TV's country goes first in the grid. Asynchronous on Tizen, so it never delays the boot.
    void deviceCountry().then((code) => api.setDeviceCountry(code)).catch((err: unknown) => {
      console.warn('Device country failed', err instanceof Error ? err.name : 'Error');
    });
  });
  onCleanup(() => playback.stop());

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}>
      {/* Opaque under every non-video screen, so the video plane (a frozen frame too) never shows through a fade-in. */}
      <Show when={current() && screenUnderlay(current()!.screen)}>
        <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} zIndex={-1} />
      </Show>
      <View ref={screenHost} width={LAYOUT.width} height={LAYOUT.height} forwardFocus={0}>
        <Show when={current()} keyed fallback={
          <Show when={initFailed()} fallback={<View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} />}>
            <InitError onRetry={() => void bootstrap(api, router)} />
          </Show>
        }>
          {(entry) => (isLazyScreen(entry.screen)
            ? <LazyScreen module={LAZY[entry.screen]} props={{ entry }} />
            : entry.screen === 'addSource' ? <AddSourceScreen entry={entry} />
            : entry.screen === 'home' ? <LiveTvScreen entry={entry} />
            : entry.screen === 'player' ? <PlayerScreen entry={entry} />
            : entry.screen === 'search' ? <SearchScreen entry={entry} />
            : entry.screen === 'start' ? <StartScreen entry={entry} />
            : entry.screen === 'startSports' ? <StartSportsScreen />
            : entry.screen === 'vod' ? <VodBrowseScreen entry={entry} />
            : entry.screen === 'vodGrid' ? <VodGridScreen entry={entry} />
            : entry.screen === 'movieDetail' ? <MovieDetailScreen entry={entry} />
            : entry.screen === 'seriesDetail' ? <SeriesDetailScreen entry={entry} />
            : entry.screen === 'vodPlay' ? <VodPlayScreen entry={entry} /> : <PlaceholderScreen entry={entry} />)}
        </Show>
      </View>
      {/*
        Pointer mode only: every screen except Home and the Player (it has its own) gets a Back button, the first button
        of the bottom row (the screen hides its hint line then and puts its own buttons after it).
      */}
      <Show when={shellBackShown(current()?.screen)}>
        <PointerBar x={shellBackX(current()?.screen)} y={BOTTOM_ROW_Y} height={BOTTOM_ROW_H} zIndex={45} global
          items={[{ id: 'shellBack', label: SHELL_BACK_LABEL, width: SHELL_BACK_W, onPress: shellBack }]} />
      </Show>
      <Wordmark visible={showWordmark(current()?.screen, playback.rectIsFullscreen(), screenOverlayOpen(overlayIds()))}
        defer={wordmarkDeferred()} />
      {/* Badge and clock are App-level, so they draw above everything a screen draws: off over fullscreen video and while a screen's modal is open. */}
      <Show when={offline() && !fullscreenVideoRoute(current()?.screen) && !screenOverlayOpen(overlayIds())}><OfflineBadge /></Show>
      {/*
        Hidden until settings are loaded, so a disabled clock never flashes. Not over fullscreen video: the Player's info
        banner has its own clock (two clocks showed together) and VodPlay's bar is the only chrome on the picture.
      */}
      <Show when={settings()?.showClock === true && !fullscreenVideoRoute(current()?.screen) && !screenOverlayOpen(overlayIds()) && !railRoute(current()?.screen)}><Clock /></Show>
      <Toast />
      <Show when={exitOpen()}>
        <ConfirmDialog message="Exit the app?" onYes={() => answerExit(true)} onNo={() => answerExit(false)} />
      </Show>
      <DebugOverlay />
    </View>
  );
}
