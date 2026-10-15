import { createSignal } from 'solid-js';
import type { VodTile } from '@iptv/app-api';

/** The detail screens' Favourite button. No Lightning: the screen wires it. */

export const SAVE_FAILED = "Couldn't save that. Try again.";

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
  /** Saves the flipped state, shows it at once, then reloads; toasts when saving fails. */
  toggle: (t: VodTile) => Promise<void>;
}

/** The override is set after a successful save, so a failed reload still shows the right state. */
export function createFavToggle(deps: FavToggleDeps): FavToggle {
  const [override, setOverride] = createSignal<boolean | undefined>(undefined);
  return {
    apply: (t) => {
      const f = override();
      return t && f !== undefined ? { ...t, favourite: f } : t;
    },
    clear: () => setOverride(undefined),
    toggle: async (t) => {
      try {
        await deps.setFavourite(t.id, !t.favourite);
      } catch (err) {
        console.warn('Favourite failed', err instanceof Error ? err.name : 'Error');
        if (deps.alive()) deps.toast(SAVE_FAILED);
        return;
      }
      if (!deps.alive()) return;
      setOverride(!t.favourite);
      await deps.reload();
    },
  };
}
