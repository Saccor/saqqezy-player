import { Show, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import type { EpisodeView, SeriesView, VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { ContextMenu } from '../components/ContextMenu.tsx';
import { screenOverlayOpen } from '../shell/logic.ts';
import { router } from '../shell/router.ts';
import { showToast } from '../shell/Toast.tsx';
import { SAVE_FAILED } from './favToggle.ts';
import { createVodLauncher, playSeriesPrimary, type VodLauncher } from './launch.ts';
import { buildEpisodeMenu, buildPosterMenu, runEpisodeAction, runPosterAction, type PosterAction } from './posterMenuLogic.ts';

const MENU_ID = 'posterMenu';

/** How the menu's Play runs on a screen; all optional. */
export interface PosterMenuPlay {
  /** The screen's launcher (its busy guard and source-change cancel are shared); default: the menu's own. */
  launcher?: VodLauncher;
  /** A series' view the screen already holds (its primary episode plays without a load). */
  seriesView?: (seriesId: string) => SeriesView | undefined;
  /** A series view Play loaded (the screen may keep it). */
  onSeriesView?: (v: SeriesView) => void;
  /** False once a series Play no longer applies after its load (e.g. focus moved off the title). Default: true. */
  still?: (seriesId: string) => boolean;
}

/**
 * The poster options menu for a screen: `open(tile, inContinue)` for a title, `openEpisode(ep, seriesId)` for an episode
 * card, and `View` placed last in the screen's tree. Play (the first item) plays a movie, or a series' primary episode.
 */
export function createPosterMenu(opts: { refocus: () => void; onChanged: () => void; play?: PosterMenuPlay }) {
  const [state, setState] = createSignal<{
    title: string;
    items: { action: PosterAction; label: string }[];
    run: (a: PosterAction) => Promise<boolean>;
  } | undefined>(undefined);
  let node: ElementNode | undefined;
  let remove: (() => void) | undefined;
  let alive = true;
  const dismiss = () => {
    setState(undefined);
    remove = undefined;
    node = undefined;
    if (!alive) return;
    queueMicrotask(() => opts.refocus());
  };
  const show = (s: NonNullable<ReturnType<typeof state>>) => {
    setState(s);
    // Back closes the menu like Cancel (the router calls `dismiss`).
    remove = router.pushOverlay(MENU_ID, dismiss);
    queueMicrotask(() => node?.setFocus());
  };
  const launcher = opts.play?.launcher ?? createVodLauncher({
    alive: () => alive,
    overlayOpen: screenOverlayOpen,
    getPlayable: (id, seriesId) => api.getVodPlayable(id, seriesId),
    push: (playable, fromStart) => router.push('vodPlay', { playable, fromStart }),
    toast: showToast,
  });
  /** A series Play press waiting for the view to load (a second press meanwhile is ignored). */
  let seriesPlayPending = false;
  const playSeries = async (t: VodTile) => {
    if (seriesPlayPending) return;
    seriesPlayPending = true;
    try {
      await playSeriesPrimary({
        seriesId: t.id,
        view: () => opts.play?.seriesView?.(t.id),
        load: async () => {
          const v = await api.getSeries(t.id);
          if (alive && v) opts.play?.onSeriesView?.(v);
          return v;
        },
        still: () => alive && (opts.play?.still?.(t.id) ?? true) && !screenOverlayOpen() && state() === undefined,
        launcher,
        // No episodes (or the load failed): the detail opens instead.
        noPrimary: () => router.push('seriesDetail', { id: t.id, tile: t }),
      });
    } finally {
      seriesPlayPending = false;
    }
  };
  /** Play from the menu (it has closed by now): a movie plays; a series plays its primary episode, loading the view first. */
  const play = (t: VodTile) => {
    if (!alive || screenOverlayOpen()) return;
    if (t.kind !== 'series') void launcher.play(t.id);
    else void playSeries(t);
  };
  const open = (tile: VodTile, inContinue: boolean) =>
    show({
      title: tile.title, items: buildPosterMenu(tile, inContinue),
      run: async (a) => {
        if (a !== 'play') return runPosterAction(a, tile, api);
        play(tile);
        return false;
      },
    });
  const openEpisode = (ep: EpisodeView, seriesId: string) =>
    show({ title: ep.title, items: buildEpisodeMenu(ep), run: (a) => runEpisodeAction(a, ep, seriesId, api) });
  const choose = async (a: PosterAction) => {
    const s = state();
    remove?.();
    remove = undefined;
    dismiss();
    if (!s) return;
    try {
      if ((await s.run(a)) && alive) opts.onChanged();
    } catch (err) {
      console.warn('Poster action failed', err instanceof Error ? err.name : 'Error');
      showToast(SAVE_FAILED);
    }
  };
  onCleanup(() => { alive = false; remove?.(); });
  const View = () => (
    <Show when={state()} keyed>
      {(s) => <ContextMenu ref={(el) => { node = el; }} title={s.title} items={s.items} cancel="cancel" onChoose={(a) => void choose(a)} />}
    </Show>
  );
  return { open, openEpisode, isOpen: () => state() !== undefined, View };
}
