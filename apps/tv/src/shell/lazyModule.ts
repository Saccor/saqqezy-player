import type { Component } from 'solid-js';
import type { ScreenId } from './router.ts';

/** Props of a lazily loaded screen (Solid's `Component` needs an object-like props type). */
export type ScreenProps = Record<string, unknown>;

/** A screen module loaded on first use (or earlier, in idle time). */
export interface LazyModule<P extends ScreenProps> { load(): Promise<Component<P>>; loaded(): Component<P> | undefined }

/** Imports once and caches; concurrent loads share one import; a failed import can be tried again. */
export function lazyModule<P extends ScreenProps>(importer: () => Promise<Component<P>>): LazyModule<P> {
  let comp: Component<P> | undefined;
  let pending: Promise<Component<P>> | undefined;
  return {
    load() {
      if (comp) return Promise.resolve(comp);
      pending ??= importer().then(
        (c) => { comp = c; return c; },
        (err: unknown) => { pending = undefined; throw err; },
      );
      return pending;
    },
    loaded: () => comp,
  };
}

/** Loads `mods` one per `schedule` slot (idle time), so a rare screen's first open does not compile on the key. */
export async function preloadInTurn(mods: ReadonlyArray<{ load(): Promise<unknown> }>, schedule: (run: () => void) => void): Promise<void> {
  for (const m of mods) {
    await new Promise<void>((resolve) => schedule(resolve));
    await m.load().catch(() => undefined);
  }
}

/**
 * Reloads the app. Startup returns to the last channel, so this is a cheap way back to a working state.
 * On hosted targets (Titan OS, the web build) a reload while offline shows the browser's error page.
 */
function reloadApp(): void {
  location.reload();
}

/**
 * Try again on "Couldn't open this screen". Browsers cache a failed `import()` per URL (calling it again rejects
 * without a request), so only a reload fetches the screen's code again. `reload` is injectable for tests.
 */
export function tryAgain(reload: () => void = reloadApp): void {
  reload();
}

/**
 * When a lazy screen opens with nothing mounted yet (loading, or the load failed): its host takes focus at once. It is
 * opened from inside another screen, and the focus manager would otherwise keep the destroyed screen's focus path, so
 * keys would reach that screen and Try again could not be reached. A screen that is already loaded focuses itself.
 */
export function shouldFocusHostOnMount(mounted: unknown): boolean {
  return mounted === undefined;
}

/**
 * After a lazy screen mounts (or its failure view appears): pass focus down again only while the empty host still
 * holds it. A screen that claimed focus on mount (Multiview opens its channel picker) keeps it.
 */
export function shouldRefocusHost<T>(alive: boolean, active: T | undefined, host: T | undefined): boolean {
  return alive && host !== undefined && active === host;
}

/**
 * Rare screens, loaded on first use (spec 2026-10-26 §0.3), in idle-preload order. The VOD player (movies, series,
 * catch-up) comes first; Settings carries its pages and the pairing page (with the QR library). Order: most likely first.
 */
export const LAZY_SCREENS = ['vodPlay', 'settings', 'countries', 'multiview'] as const satisfies readonly ScreenId[];
export type LazyScreenId = (typeof LAZY_SCREENS)[number];

/**
 * Used only by tests, where it pins the rule: screens a cold start or a key on the first frame can show: never lazy (Watch and the guide live in `home`; Add
 * source is the first screen on a first run).
 */
export const FIRST_FRAME_SCREENS: readonly ScreenId[] = ['home', 'player', 'start', 'vod', 'vodGrid', 'search', 'addSource'];

export function isLazyScreen(id: ScreenId): id is LazyScreenId {
  return (LAZY_SCREENS as readonly ScreenId[]).includes(id);
}
