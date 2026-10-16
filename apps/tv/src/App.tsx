import { Show, Text, View, activeElement, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { useFocusManager } from '@lightningtv/solid/primitives';
import { PointerBar } from './components/PointerBar.tsx';
import { shellBack } from './input/pointer.ts';
import { api, onEvent } from './api.ts';
import { LIGHTNING_KEY_MAP } from './input/keys.ts';
import { playback } from './playback/playback.ts';
import { AddSourceScreen } from './screens/AddSource.tsx';
import { GuideScreen } from './screens/Guide.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { MovieDetailScreen } from './screens/MovieDetail.tsx';
import { PlaceholderScreen } from './screens/Placeholder.tsx';
import { SeriesDetailScreen } from './screens/SeriesDetail.tsx';
import { PlayerScreen } from './screens/Player.tsx';
import { SearchScreen } from './screens/Search.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { VodBrowseScreen } from './screens/VodBrowse.tsx';
import { VodGridScreen } from './screens/VodGrid.tsx';
import { VodPlayScreen } from './screens/VodPlay.tsx';
import { Clock } from './shell/Clock.tsx';
import { ConfirmDialog } from './shell/ConfirmDialog.tsx';
import { DebugOverlay } from './shell/DebugOverlay.tsx';
import { InitError } from './shell/InitError.tsx';
import {
  BOTTOM_ROW_H, BOTTOM_ROW_Y, deferWordmark, EXIT_OVERLAY_ID, SHELL_BACK_LABEL, SHELL_BACK_W, screenOverlayOpen, shellBackShown, shellBackX,
  showWordmark, WORDMARK_MAX_WAIT_MS,
} from './shell/logic.ts';
import { exitApp } from './shell/platformExit.ts';
import { router } from './shell/router.ts';
import { COLORS, FONT, LAYOUT } from './shell/theme.ts';
import { Toast, showToast } from './shell/Toast.tsx';
import { Wordmark } from './shell/Wordmark.tsx';
import { reloadSourceLimit } from './state/activeLimit.ts';
import { onBackOnline } from './state/backOnline.ts';
import { bootstrap, cooldown, initFailed, initState, offline, platformId, settings, startupMs, wireEvents } from './state/appState.ts';
import { createVodPreloader, idleSchedule } from './vod/preload.ts';

const EXIT_ID = EXIT_OVERLAY_ID;
const BADGE_W = 400;
const BADGE_H = 48;

function OfflineBadge() {
  return (
    <View x={LAYOUT.width - LAYOUT.safeX - 120 - LAYOUT.gap - BADGE_W} y={LAYOUT.safeY - 4} width={BADGE_W} height={BADGE_H}
      color={COLORS.surface} borderRadius={BADGE_H / 2} border={{ width: 2, color: COLORS.muted }} zIndex={10}>
      <Text y={(BADGE_H - FONT.small) / 2 - 3} width={BADGE_W} maxWidth={BADGE_W} contain="width" textAlign="center"
        fontSize={FONT.small} color={COLORS.text}>{'Offline – showing saved list'}</Text>
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

  // Every Back that no focused element handled lands here.
  const onBack = () => {
    if (router.back() === 'root') openExit();
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

  onMount(() => {
    onCleanup(wireEvents(onEvent, showToast, {
      api, router, playing: () => playback.current() !== undefined, stopPlayback: () => playback.stop(),
    }));
    // Back online: an unreachable wait of the active source was our own outage, so it ends (the worker decides).
    onCleanup(onBackOnline(globalThis.window, () => {
      api.networkOnline().catch((err: unknown) => console.warn('Back-online retry failed', err instanceof Error ? err.name : 'Error'));
    }));
    void bootstrap(api, router);
  });
  onCleanup(() => playback.stop());

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}>
      <View ref={screenHost} width={LAYOUT.width} height={LAYOUT.height} forwardFocus={0}>
        <Show when={current()} keyed fallback={
          <Show when={initFailed()} fallback={<View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} />}>
            <InitError onRetry={() => void bootstrap(api, router)} />
          </Show>
        }>
          {(entry) => (entry.screen === 'addSource'
            ? <AddSourceScreen entry={entry} />
            : entry.screen === 'home' ? <HomeScreen entry={entry} />
            : entry.screen === 'player' ? <PlayerScreen entry={entry} />
            : entry.screen === 'guide' ? <GuideScreen entry={entry} />
            : entry.screen === 'search' ? <SearchScreen />
            : entry.screen === 'settings' ? <SettingsScreen />
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
      <Show when={offline()}><OfflineBadge /></Show>
      {/* Hidden until settings are loaded, so a disabled clock never flashes. */}
      <Show when={settings()?.showClock === true}><Clock /></Show>
      <Toast />
      <Show when={exitOpen()}>
        <ConfirmDialog message="Exit the app?" onYes={() => answerExit(true)} onNo={() => answerExit(false)} />
      </Show>
      <DebugOverlay />
    </View>
  );
}
