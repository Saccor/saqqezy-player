import { Show, Text, View, activeElement, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { useFocusManager } from '@lightningtv/solid/primitives';
import { api, onEvent } from './api.ts';
import { LIGHTNING_KEY_MAP } from './input/keys.ts';
import { playback } from './playback/playback.ts';
import { AddSourceScreen } from './screens/AddSource.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { PlaceholderScreen } from './screens/Placeholder.tsx';
import { Clock } from './shell/Clock.tsx';
import { ConfirmDialog } from './shell/ConfirmDialog.tsx';
import { DebugOverlay } from './shell/DebugOverlay.tsx';
import { exitApp } from './shell/platformExit.ts';
import { router } from './shell/router.ts';
import { COLORS, FONT, LAYOUT } from './shell/theme.ts';
import { Toast, showToast } from './shell/Toast.tsx';
import { bootstrap, offline, platformId, settings, wireEvents } from './state/appState.ts';

const EXIT_ID = 'exitConfirm';
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
 * offline badge, clock and debug HUD. Playback lives in the `playback` singleton (src/playback/playback.ts).
 */
export function App() {
  useFocusManager(LIGHTNING_KEY_MAP);

  const [current, setCurrent] = createSignal(router.current());
  onCleanup(router.subscribe(setCurrent));

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
    onCleanup(wireEvents(onEvent, showToast));
    void bootstrap(api, router, showToast);
  });
  onCleanup(() => playback.stop());

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}>
      <View ref={screenHost} width={LAYOUT.width} height={LAYOUT.height} forwardFocus={0}>
        <Show when={current()} keyed fallback={<View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} />}>
          {(entry) => (entry.screen === 'addSource'
            ? <AddSourceScreen />
            : entry.screen === 'home' ? <HomeScreen entry={entry} /> : <PlaceholderScreen entry={entry} />)}
        </Show>
      </View>
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
