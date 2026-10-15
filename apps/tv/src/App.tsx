import { Show, Text, View, activeElement, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { useFocusManager } from '@lightningtv/solid/primitives';
import { Button } from './components/Button.tsx';
import { pointerMode, shellBack } from './input/pointer.ts';
import { api, onEvent } from './api.ts';
import { LIGHTNING_KEY_MAP } from './input/keys.ts';
import { playback } from './playback/playback.ts';
import { AddSourceScreen } from './screens/AddSource.tsx';
import { GuideScreen } from './screens/Guide.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { PlaceholderScreen } from './screens/Placeholder.tsx';
import { PlayerScreen } from './screens/Player.tsx';
import { SearchScreen } from './screens/Search.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { Clock } from './shell/Clock.tsx';
import { ConfirmDialog } from './shell/ConfirmDialog.tsx';
import { DebugOverlay } from './shell/DebugOverlay.tsx';
import { InitError } from './shell/InitError.tsx';
import {
  deferWordmark, EXIT_OVERLAY_ID, SHELL_BACK_LABEL, screenOverlayOpen, shellBackShown, showWordmark, WORDMARK_MAX_WAIT_MS,
} from './shell/logic.ts';
import { exitApp } from './shell/platformExit.ts';
import { router } from './shell/router.ts';
import { COLORS, FONT, LAYOUT } from './shell/theme.ts';
import { Toast, showToast } from './shell/Toast.tsx';
import { Wordmark } from './shell/Wordmark.tsx';
import { bootstrap, initFailed, offline, platformId, settings, startupMs, wireEvents } from './state/appState.ts';

const EXIT_ID = EXIT_OVERLAY_ID;
const BADGE_W = 400;
const BADGE_H = 48;
/** The pointer-mode Back button, top left. */
const SHELL_BACK_W = 200;

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

  onMount(() => {
    onCleanup(wireEvents(onEvent, showToast, {
      api, router, playing: () => playback.current() !== undefined, stopPlayback: () => playback.stop(),
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
            : entry.screen === 'settings' ? <SettingsScreen /> : <PlaceholderScreen entry={entry} />)}
        </Show>
      </View>
      {/* Pointer mode only: every screen except Home and the Player (it has its own) gets a Back button. */}
      <Show when={pointerMode() && shellBackShown(current()?.screen)}>
        <View x={LAYOUT.safeX} y={LAYOUT.safeY} zIndex={45}>
          <Button width={SHELL_BACK_W} label={SHELL_BACK_LABEL} onPress={shellBack} pointerLayer="overlay" pointerGlobal />
        </View>
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
