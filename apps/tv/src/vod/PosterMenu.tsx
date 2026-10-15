import { Show, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import type { EpisodeView, VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { ContextMenu } from '../components/ContextMenu.tsx';
import { router } from '../shell/router.ts';
import { showToast } from '../shell/Toast.tsx';
import { SAVE_FAILED } from './favToggle.ts';
import { buildEpisodeMenu, buildPosterMenu, runEpisodeAction, runPosterAction, type PosterAction } from './posterMenuLogic.ts';

const MENU_ID = 'posterMenu';

/**
 * The poster options menu for a screen: `open(tile, inContinue)` for a title, `openEpisode(ep, seriesId)` for an episode
 * card, and `View` placed last in the screen's tree.
 */
export function createPosterMenu(opts: { refocus: () => void; onChanged: () => void }) {
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
  const open = (tile: VodTile, inContinue: boolean) =>
    show({ title: tile.title, items: buildPosterMenu(tile, inContinue), run: (a) => runPosterAction(a, tile, api) });
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
