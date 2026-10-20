import { createSignal } from 'solid-js';
import { worseCooldown, type AppEvent, type CompanionStatus, type InitState, type SourceCooldown } from '@iptv/app-api';
// Type-only: @iptv/core must stay out of the main-thread bundle (it lives in the worker chunk).
import type { AppSettings } from '@iptv/core';
import type { SupervisorStatus } from '@iptv/player';
import { detectPlatform, type HeaderSupport, type PlatformId } from '@iptv/platform';
import { tvHeaderSupport } from '../net/headerSupport.ts';
import type { Router } from '../shell/router.ts';
import { bootRoutes, initialRoute, offlineAfter, sourcesReaction, toastFor, toastPriority, type SourcesChanged } from './events.ts';

/** App-wide state shared by the shell and the screens. */
const [initState, setInitState] = createSignal<InitState | undefined>(undefined);
const [offline, setOffline] = createSignal(false);
const [startupMs, setStartupMs] = createSignal<number | undefined>(undefined);
const [supervisorStatus, setSupervisorStatus] = createSignal<SupervisorStatus | undefined>(undefined);

export { initState, offline, startupMs, supervisorStatus, setSupervisorStatus };

/**
 * The phone companion session, from the worker's `companion` events (the worker starts `idle`). Home shows a
 * badge while connected; the pairing page reads it for its status line and countdown.
 */
const [companionStatus, setCompanionStatus] = createSignal<CompanionStatus>({ state: 'idle' });
export { companionStatus, setCompanionStatus };

export const platformId: PlatformId = detectPlatform(
  navigator.userAgent,
  globalThis as unknown as { tizen?: unknown; webOS?: unknown },
);

/** Which of a source's User-Agent and Referer this device can send, and with what (fixed per launch). */
export const headerSupportHere: HeaderSupport = tvHeaderSupport(platformId, import.meta.env.DEV);

/**
 * Current settings, reactive: from `InitState` until the Settings screen changes one (`patchSettings`).
 * Undefined until `api.init()` has answered. The clock, Player and Settings read it directly; Home and the
 * Guide get offset/format changes through the worker, which applies them to every answer.
 */
export const settings = (): AppSettings | undefined => initState()?.settings;

const CLEAR: SourceCooldown = { state: 'clear' };
/**
 * The latest `cooldown` event per key: a source id, or a stream host's key (`streamKey`). The worker announces every
 * change, so an event is never older than an `InitState` answer or a playable (which only read the state); events
 * that arrive before the first `InitState` are kept too.
 */
const [cooldownEvents, setCooldownEvents] = createSignal<ReadonlyMap<string, SourceCooldown>>(new Map());
/** The host key of the stream on screen (or held), set by the playback controller. */
const [streamKey, setStreamKey] = createSignal<string | undefined>(undefined);

/** The active source's own cooldown (API, playlist, EPG, and every stream): the latest event, else `InitState`'s. */
const sourceCooldown = (): SourceCooldown => {
  const s = initState();
  const id = s?.activeSourceId;
  return (id !== undefined ? cooldownEvents().get(id) : undefined) ?? s?.cooldown ?? CLEAR;
};

/**
 * A stream's cooldown: its host's (`PlayableChannel.cooldownKey`) or the active source's, whichever blocks longer
 * (spec 2026-10-16-source-retry §5). A host refusal pauses only the streams on that host.
 */
export function cooldownOf(key: string | undefined, seed?: SourceCooldown): SourceCooldown {
  const host = key !== undefined ? cooldownEvents().get(key) ?? seed ?? CLEAR : CLEAR;
  return worseCooldown(sourceCooldown(), host);
}

/**
 * The current stream changed: the cooldown copy and the hold follow its host. `seed` is the playable's cooldown (a
 * wait read from storage after a reload); it counts only until the worker announces that key.
 */
export function setStreamCooldown(key: string | undefined, seed?: SourceCooldown): void {
  if (key !== undefined && seed && seed.state !== 'clear' && !cooldownEvents().has(key)) {
    setCooldownEvents((m) => new Map(m).set(key, seed));
  }
  setStreamKey(key);
}

/**
 * The current stream's cooldown (its host's or the active source's). While it is not `clear`, the stream does not
 * open and Home and the Player show the cooldown copy with Retry.
 */
export const cooldown = (): SourceCooldown => cooldownOf(streamKey());

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
  router: Pick<Router, 'reset' | 'push'>,
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
    const [root, ...over] = bootRoutes(s);
    router.reset(root!.screen, root!.params);
    for (const e of over) router.push(e.screen, e.params);
  } catch (err) {
    if (attempt !== bootAttempt) return;
    console.error('Startup failed', err instanceof Error ? err.message === 'Timed out' ? 'timeout' : err.name : 'Error');
    setInitFailed(true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What `wireEvents` needs to follow source changes made from the phone. */
export interface SourceFollowDeps {
  api: { init(): Promise<InitState> };
  router: Pick<Router, 'reset' | 'current'>;
  /** Whether a channel is playing, and stopping it. */
  playing(): boolean;
  stopPlayback(): void;
}

/**
 * A paired phone switched, added, edited or deleted a source: re-reads `InitState`, stops a stream that belonged to
 * a source that is gone or no longer active, and fixes the route. Home and the Guide re-read their own lists on the
 * same event. Idempotent: applying the same state twice is harmless.
 */
async function followSources(e: SourcesChanged, deps: SourceFollowDeps): Promise<void> {
  const route = deps.router.current()?.screen;
  const reaction = sourcesReaction(e, initState(), route, deps.playing());
  if (!reaction.applyState) return;
  if (reaction.stopPlayback) deps.stopPlayback();
  try {
    const next = await deps.api.init();
    setInitState(next);
    if (reaction.resetToAddSource || next.sources.length === 0) {
      if (deps.router.current()?.screen !== 'addSource') deps.router.reset('addSource', {});
      return;
    }
    const screen = deps.router.current()?.screen;
    if ((reaction.leavePlayer && screen === 'player') || (reaction.openHome && screen === 'addSource')) {
      const root = initialRoute(next);
      deps.router.reset(root.screen, root.params);
    }
  } catch (err) {
    console.warn('Follow source change failed', err instanceof Error ? err.name : 'Error');
  }
}

/**
 * Subscribes the shell to worker events (toasts, offline badge, companion status, source changes). Returns an
 * unsubscribe function. Without `follow` a source change only shows its toast.
 */
export function wireEvents(
  on: (type: string, fn: (payload: unknown) => void) => () => void,
  toast: (text: string, priority?: number) => void,
  follow?: SourceFollowDeps,
): () => void {
  const handle = (payload: unknown) => {
    const e = payload as AppEvent;
    if (e.type === 'companion') {
      setCompanionStatus(e.status);
      return;
    }
    if (e.type === 'cooldown') {
      setCooldownEvents((m) => new Map(m).set(e.streamKey ?? e.sourceId, e.cooldown));
      return;
    }
    if (e.type === 'sourcesChanged' && follow) void followSources(e, follow);
    setOffline((prev) => offlineAfter(prev, e));
    const text = toastFor(e);
    if (text) toast(text, toastPriority(e));
  };
  // `layoutChanged` / `sourcesChanged` from a companion show "Updated from your phone" on any screen; Home also re-reads its list.
  const offs = (['refreshed', 'refreshFailed', 'offline', 'layoutChanged', 'sourcesChanged', 'companion', 'cooldown'] as const).map((t) => on(t, handle));
  return () => { for (const off of offs) off(); };
}
