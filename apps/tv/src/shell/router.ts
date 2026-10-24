/**
 * Screen stack plus overlay stack. Pure (no Solid, no Lightning) so it is unit-tested; the shell mirrors it
 * into signals through `subscribe` / `subscribeOverlays`.
 *
 * Back is layered: `back()` closes the top overlay first (calling its `onClose`), then pops the screen. On the
 * root screen it changes nothing and returns `'root'`; the shell then asks to confirm exit.
 */
export type ScreenId = 'addSource' | 'countries' | 'home' | 'player' | 'search' | 'settings' | 'vod' | 'vodGrid' | 'movieDetail' | 'seriesDetail' | 'vodPlay' | 'start' | 'startSports' | 'multiview';
export type ScreenParams = Record<string, unknown>;
export interface ScreenEntry { screen: ScreenId; params: ScreenParams }
export type BackResult = 'overlay' | 'screen' | 'root';
/** How the screen stack last changed: `back` is a screen pop or `backTo`. */
export type ScreenChange = 'push' | 'replace' | 'reset' | 'back';

export interface Router {
  push(screen: ScreenId, params?: ScreenParams): void;
  /** Replaces the top screen (pushes when the stack is empty). */
  replace(screen: ScreenId, params?: ScreenParams): void;
  /** Clears the stack and opens `screen` as the root. */
  reset(screen: ScreenId, params?: ScreenParams): void;
  /** `params` are merged into the screen revealed by a screen pop (not by closing an overlay). */
  back(params?: ScreenParams): BackResult;
  /**
   * Returns to the topmost `screen` in the stack: closes every overlay (calling its `onClose`), pops the screens above
   * it in one change and merges `params` into it. Subscribers are told even when it was already on top, so it re-reads
   * the params. False (nothing changed) when `screen` is not in the stack. Hand-offs use it to reach the root Live TV
   * without stacking a second one.
   */
  backTo(screen: ScreenId, params?: ScreenParams): boolean;
  current(): ScreenEntry | undefined;
  /** The screen `n` (default 1) under the current one; `below()` is what a screen pop reveals (undefined on the root). */
  below(n?: number): ScreenEntry | undefined;
  depth(): number;
  /** How the current screen was reached (undefined before the first screen); overlays do not change it. */
  lastChange(): ScreenChange | undefined;
  /** Registers an overlay on top (moving it there if `id` is already open). The remover does not call `onClose`. */
  pushOverlay(id: string, onClose: () => void): () => void;
  removeOverlay(id: string): void;
  topOverlay(): string | undefined;
  overlays(): string[];
  subscribe(fn: (current: ScreenEntry | undefined) => void): () => void;
  subscribeOverlays(fn: (ids: string[]) => void): () => void;
}

interface Overlay { id: string; onClose: () => void; token: object }

export function createRouter(): Router {
  const stack: ScreenEntry[] = [];
  let layers: Overlay[] = [];
  let change: ScreenChange | undefined;
  const screenFns = new Set<(c: ScreenEntry | undefined) => void>();
  const overlayFns = new Set<(ids: string[]) => void>();

  const emitScreen = () => { for (const fn of [...screenFns]) fn(stack[stack.length - 1]); };
  const emitOverlays = () => { const ids = layers.map((o) => o.id); for (const fn of [...overlayFns]) fn(ids); };
  const entry = (screen: ScreenId, params?: ScreenParams): ScreenEntry => ({ screen, params: params ?? {} });

  const router: Router = {
    push(screen, params) {
      stack.push(entry(screen, params));
      change = 'push';
      emitScreen();
    },
    replace(screen, params) {
      if (stack.length > 0) stack.pop();
      stack.push(entry(screen, params));
      change = 'replace';
      emitScreen();
    },
    reset(screen, params) {
      stack.length = 0;
      stack.push(entry(screen, params));
      change = 'reset';
      emitScreen();
    },
    back(params) {
      const top = layers[layers.length - 1];
      if (top) {
        layers = layers.slice(0, -1);
        try {
          top.onClose();
        } catch (err) {
          console.error('Overlay close failed', err);
        }
        emitOverlays();
        return 'overlay';
      }
      if (stack.length > 1) {
        stack.pop();
        const revealed = stack[stack.length - 1];
        if (params && revealed) revealed.params = { ...revealed.params, ...params };
        change = 'back';
        emitScreen();
        return 'screen';
      }
      return 'root';
    },
    backTo(screen, params) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i]!.screen !== screen) i--;
      if (i < 0) return false;
      while (layers.length > 0) router.back();
      stack.length = i + 1;
      const target = stack[i]!;
      if (params) target.params = { ...target.params, ...params };
      change = 'back';
      emitScreen();
      return true;
    },
    current: () => stack[stack.length - 1],
    below: (n = 1) => stack[stack.length - 1 - n],
    depth: () => stack.length,
    lastChange: () => change,
    pushOverlay(id, onClose) {
      const token = {};
      layers = [...layers.filter((o) => o.id !== id), { id, onClose, token }];
      emitOverlays();
      return () => {
        const before = layers.length;
        layers = layers.filter((o) => o.token !== token);
        if (layers.length !== before) emitOverlays();
      };
    },
    removeOverlay(id) {
      const before = layers.length;
      layers = layers.filter((o) => o.id !== id);
      if (layers.length !== before) emitOverlays();
    },
    topOverlay: () => layers[layers.length - 1]?.id,
    overlays: () => layers.map((o) => o.id),
    subscribe(fn) {
      screenFns.add(fn);
      return () => { screenFns.delete(fn); };
    },
    subscribeOverlays(fn) {
      overlayFns.add(fn);
      return () => { overlayFns.delete(fn); };
    },
  };
  return router;
}

/** The app's single router. */
export const router = createRouter();
