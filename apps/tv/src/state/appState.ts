import { createSignal } from 'solid-js';
import type { AppEvent, InitState } from '@iptv/app-api';
// Type-only: @iptv/core must stay out of the main-thread bundle (it lives in the worker chunk).
import type { AppSettings } from '@iptv/core';
import type { SupervisorStatus } from '@iptv/player';
import { detectPlatform, type PlatformId } from '@iptv/platform';
import type { Router } from '../shell/router.ts';
import { initialRoute, offlineAfter, toastFor } from './events.ts';

/** App-wide state shared by the shell and the screens. */
const [initState, setInitState] = createSignal<InitState | undefined>(undefined);
const [offline, setOffline] = createSignal(false);
const [startupMs, setStartupMs] = createSignal<number | undefined>(undefined);
const [supervisorStatus, setSupervisorStatus] = createSignal<SupervisorStatus | undefined>(undefined);

export { initState, offline, startupMs, supervisorStatus, setSupervisorStatus };

export const platformId: PlatformId = detectPlatform(
  navigator.userAgent,
  globalThis as unknown as { tizen?: unknown; webOS?: unknown },
);

/**
 * Current settings, reactive: from `InitState` until the Settings screen changes one (`patchSettings`).
 * Undefined until `api.init()` has answered. The clock, Player and Settings read it directly; Home and the
 * Guide get offset/format changes through the worker, which applies them to every answer.
 */
export const settings = (): AppSettings | undefined => initState()?.settings;

/** Updates the cached settings (optimistically, then with `saveSettings`' sanitised answer). */
export function patchSettings(next: AppSettings): void {
  const s = initState();
  if (s) setInitState({ ...s, settings: next });
}

/** Replaces `InitState` after a call that returns a fresh one (set active, delete source, clear cache). */
export function applyInitState(next: InitState): void {
  setInitState(next);
}

/**
 * Startup metric: ms from navigation start to the first Home list render with cached rows. Home calls this
 * once that list is on screen; later calls are ignored.
 */
export function markStartup(): void {
  if (startupMs() === undefined) setStartupMs(performance.now());
}

/** Loads `InitState` from the worker and opens the root screen. */
export async function bootstrap(
  api: { init(): Promise<InitState> },
  router: Pick<Router, 'reset'>,
  toast: (text: string) => void,
): Promise<void> {
  try {
    const s = await api.init();
    setInitState(s);
    const root = initialRoute(s);
    router.reset(root.screen, root.params);
  } catch (err) {
    console.error('Startup failed', err instanceof Error ? err.name : 'Error');
    router.reset('addSource');
    toast("Couldn't load saved data.");
  }
}

/** Subscribes the shell to worker events (toasts, offline badge). Returns an unsubscribe function. */
export function wireEvents(
  on: (type: string, fn: (payload: unknown) => void) => () => void,
  toast: (text: string) => void,
): () => void {
  const handle = (payload: unknown) => {
    const e = payload as AppEvent;
    setOffline((prev) => offlineAfter(prev, e));
    const text = toastFor(e);
    if (text) toast(text);
  };
  const offs = (['refreshed', 'refreshFailed', 'offline'] as const).map((t) => on(t, handle));
  return () => { for (const off of offs) off(); };
}
