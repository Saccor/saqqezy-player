/**
 * Screen stack plus overlay stack. Pure (no Solid, no Lightning) so it is unit-tested; the shell mirrors it
 * into signals through `subscribe` / `subscribeOverlays`.
 *
 * Back is layered: `back()` closes the top overlay first (calling its `onClose`), then pops the screen. On the
 * root screen it changes nothing and returns `'root'`; the shell then asks to confirm exit.
 */
export type ScreenId = 'addSource' | 'home' | 'player' | 'guide' | 'search' | 'settings' | 'vod' | 'vodGrid' | 'movieDetail' | 'seriesDetail' | 'vodPlay' | 'start' | 'startSports';
export type ScreenParams = Record<string, unknown>;
export interface ScreenEntry { screen: ScreenId; params: ScreenParams }
export type BackResult = 'overlay' | 'screen' | 'root';

export interface Router {
  push(screen: ScreenId, params?: ScreenParams): void;
  /** Replaces the top screen (pushes when the stack is empty). */
  replace(screen: ScreenId, params?: ScreenParams): void;
  /** Clears the stack and opens `screen` as the root. */
  reset(screen: ScreenId, params?: ScreenParams): void;
  /** `params` are merged into the screen revealed by a screen pop (not by closing an overlay). */
  back(params?: ScreenParams): BackResult;
  current(): ScreenEntry | undefined;
  depth(): number;
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
  const screenFns = new Set<(c: ScreenEntry | undefined) => void>();
  const overlayFns = new Set<(ids: string[]) => void>();

  const emitScreen = () => { for (const fn of [...screenFns]) fn(stack[stack.length - 1]); };
  const emitOverlays = () => { const ids = layers.map((o) => o.id); for (const fn of [...overlayFns]) fn(ids); };
  const entry = (screen: ScreenId, params?: ScreenParams): ScreenEntry => ({ screen, params: params ?? {} });

  const router: Router = {
    push(screen, params) {
      stack.push(entry(screen, params));
      emitScreen();
    },
    replace(screen, params) {
      if (stack.length > 0) stack.pop();
      stack.push(entry(screen, params));
      emitScreen();
    },
    reset(screen, params) {
      stack.length = 0;
      stack.push(entry(screen, params));
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
        emitScreen();
        return 'screen';
      }
      return 'root';
    },
    current: () => stack[stack.length - 1],
    depth: () => stack.length,
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
