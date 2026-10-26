import type { SeriesView, VodPlayable } from '@iptv/app-api';
import { VOD_COPY } from '../copy.ts';

/** Movies play launcher, shared by the browse hero and the movie detail. No Solid, no Lightning: the screen wires it. */

export const CANT_PLAY = VOD_COPY.cantPlay;

export interface LaunchDeps {
  /** False once the screen is gone. */
  alive: () => boolean;
  /** A screen overlay is open (`screenOverlayOpen`); a press behind one (or one opened during the wait) must not act. */
  overlayOpen: () => boolean;
  getPlayable: (itemId: string, seriesId?: string) => Promise<VodPlayable | undefined>;
  /** Opens the player (`router.push('vodPlay', { playable, fromStart })`). */
  push: (playable: VodPlayable, fromStart: boolean) => void;
  toast: (message: string) => void;
}

export interface LaunchOpts { seriesId?: string; fromStart?: boolean }

export interface VodLauncher {
  /** Asks for the playable and opens the player, or toasts that it can't play. Ignored while a press is in flight. */
  play: (itemId: string, opts?: LaunchOpts) => Promise<void>;
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
    play: async (itemId, opts) => {
      if (busy || !deps.alive() || deps.overlayOpen()) return;
      busy = true;
      const mine = ++gen;
      let p: VodPlayable | undefined;
      try {
        p = await deps.getPlayable(itemId, opts?.seriesId);
      } catch (err) {
        console.warn('Play failed', err instanceof Error ? err.name : 'Error');
        if (deps.alive() && mine === gen) deps.toast(CANT_PLAY);
        return;
      } finally {
        if (mine === gen) busy = false;
      }
      if (!deps.alive() || mine !== gen || deps.overlayOpen()) return;
      if (p) deps.push(p, opts?.fromStart === true);
      else deps.toast(CANT_PLAY);
    },
  };
}

export interface SeriesPlayDeps {
  seriesId: string;
  /** The series view when it has already loaded. */
  view: () => SeriesView | undefined;
  /** Loads the view (or joins the load in flight). */
  load: () => Promise<SeriesView | undefined>;
  /** False once the press no longer applies after the wait (screen gone, focus moved, an overlay opened). */
  still: () => boolean;
  launcher: VodLauncher;
  /** No primary episode after loading (no episodes, or the load failed). */
  noPrimary: () => void;
}

/** Plays a series' primary episode, loading the view on demand when the press comes before it has loaded. */
export async function playSeriesPrimary(d: SeriesPlayDeps): Promise<void> {
  if (d.launcher.busy()) return;
  let v = d.view();
  if (!v) {
    try {
      v = await d.load();
    } catch {
      v = undefined;
    }
    if (!d.still() || d.launcher.busy()) return;
  }
  const p = v?.primary;
  // A combined series shows one version's episodes: they play under that version's id.
  if (p) await d.launcher.play(p.episodeId, { seriesId: v?.versionId || d.seriesId });
  else d.noPrimary();
}
