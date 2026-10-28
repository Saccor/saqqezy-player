import { createSignal } from 'solid-js';
import type { VodTile } from '@iptv/app-api';
import { VOD_COPY } from '../copy.ts';

/** The detail screens' Favourite button. No Lightning: the screen wires it. */

export const SAVE_FAILED = VOD_COPY.saveFailed;

export interface FavToggleDeps {
  /** False once the screen is gone. */
  alive: () => boolean;
  /** Re-reads the screen's view; the override is cleared by the screen when a reload lands (`clear`). */
  reload: () => Promise<void>;
  setFavourite: (id: string, on: boolean) => Promise<void>;
  toast: (message: string) => void;
}

export interface FavToggle {
  /** The tile with the saved state applied over it until a reload lands. */
  apply: (t: VodTile | undefined) => VodTile | undefined;
  /** A reload landed: its tile is the truth again. */
  clear: () => void;
  /** Saves the flipped state, shows it at once, then reloads; toasts when saving fails. Ignored while one is saving. */
  toggle: (t: VodTile) => Promise<void>;
}

/**
 * The override is set after a successful save, so a failed reload still shows the right state. It belongs to the title
 * it was saved for (the browse hero's focus may move on meanwhile). A press while a save is running is ignored.
 */
export function createFavToggle(deps: FavToggleDeps): FavToggle {
  const [override, setOverride] = createSignal<{ id: string; on: boolean } | undefined>(undefined);
  let busy = false;
  return {
    apply: (t) => {
      const o = override();
      return t && o?.id === t.id ? { ...t, favourite: o.on } : t;
    },
    clear: () => setOverride(undefined),
    toggle: async (t) => {
      if (busy) return;
      busy = true;
      try {
        try {
          await deps.setFavourite(t.id, !t.favourite);
        } catch (err) {
          console.warn('Favourite failed', err instanceof Error ? err.name : 'Error');
          if (deps.alive()) deps.toast(SAVE_FAILED);
          return;
        }
        if (!deps.alive()) return;
        setOverride({ id: t.id, on: !t.favourite });
        await deps.reload();
      } finally {
        busy = false;
      }
    },
  };
}
