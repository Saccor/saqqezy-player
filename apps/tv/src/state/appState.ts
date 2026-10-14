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

/** How long `api.init()` may take before the shell shows the load error. */
export const INIT_TIMEOUT_MS = 10_000;

/** True when the last `bootstrap` attempt failed or timed out; the shell shows a full-screen Retry state. */
const [initFailed, setInitFailed] = createSignal(false);
export { initFailed };

let bootAttempt = 0;

/**
 * Loads `InitState` from the worker and opens the root screen. A failure or a 10 s timeout never routes to
 * Add source (saved sources may still exist): it sets `initFailed` so the shell can offer Retry. Only the
 * newest attempt counts; a late answer from an earlier, timed-out attempt is ignored.
 */
export async function bootstrap(
  api: { init(): Promise<InitState> },
  router: Pick<Router, 'reset'>,
  timeoutMs: number = INIT_TIMEOUT_MS,
): Promise<void> {
  const attempt = ++bootAttempt;
  setInitFailed(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const s = await Promise.race([
      api.init(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs);
      }),
    ]);
    if (attempt !== bootAttempt) return;
    setInitState(s);
    const root = initialRoute(s);
    router.reset(root.screen, root.params);
  } catch (err) {
    if (attempt !== bootAttempt) return;
    console.error('Startup failed', err instanceof Error ? err.message === 'Timed out' ? 'timeout' : err.name : 'Error');
    setInitFailed(true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
