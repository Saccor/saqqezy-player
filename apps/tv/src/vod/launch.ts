import type { VodPlayable } from '@iptv/app-api';

/** Movies play launcher, shared by the browse hero and the movie detail. No Solid, no Lightning: the screen wires it. */

export const CANT_PLAY = "This video can't play on this device.";

export interface LaunchDeps {
  /** False once the screen is gone. */
  alive: () => boolean;
  /** The shell's top overlay; a press behind one (or one opened during the wait) must not act. */
  topOverlay: () => unknown;
  getPlayable: (itemId: string) => Promise<VodPlayable | undefined>;
  /** Opens the player (`router.push('vodPlay', { playable })`). */
  push: (playable: VodPlayable) => void;
  toast: (message: string) => void;
}

export interface VodLauncher {
  /** Asks for the playable and opens the player, or toasts that it can't play. Ignored while a press is in flight. */
  play: (itemId: string) => Promise<void>;
  busy: () => boolean;
  /** Drops the press in flight: its answer neither opens the player nor toasts. */
  cancel: () => void;
}

/** One per screen: a generation and a busy flag guard against double presses and late answers. */
export function createVodLauncher(deps: LaunchDeps): VodLauncher {
  let gen = 0;
  let busy = false;
  return {
    busy: () => busy,
    cancel: () => { gen++; busy = false; },
    play: async (itemId) => {
      if (busy || !deps.alive() || deps.topOverlay() !== undefined) return;
      busy = true;
      const mine = ++gen;
      let p: VodPlayable | undefined;
      try {
        p = await deps.getPlayable(itemId);
      } catch (err) {
        console.warn('Play failed', err instanceof Error ? err.name : 'Error');
        if (deps.alive() && mine === gen) deps.toast(CANT_PLAY);
        return;
      } finally {
        if (mine === gen) busy = false;
      }
      if (!deps.alive() || mine !== gen || deps.topOverlay() !== undefined) return;
      if (p) deps.push(p);
      else deps.toast(CANT_PLAY);
    },
  };
}
