import { Show, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import type { VodTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { ContextMenu } from '../components/ContextMenu.tsx';
import { router } from '../shell/router.ts';
import { showToast } from '../shell/Toast.tsx';
import { buildPosterMenu, runPosterAction, type PosterAction } from './posterMenuLogic.ts';

const MENU_ID = 'posterMenu';

/** The poster options menu for a screen: `open(tile, inContinue)`, and `View` placed last in the screen's tree. */
export function createPosterMenu(opts: { refocus: () => void; onChanged: () => void }) {
  const [state, setState] = createSignal<{ tile: VodTile; items: { action: PosterAction; label: string }[] } | undefined>(undefined);
  let node: ElementNode | undefined;
  let remove: (() => void) | undefined;
  const dismiss = () => {
    setState(undefined);
    queueMicrotask(() => opts.refocus());
  };
  const open = (tile: VodTile, inContinue: boolean) => {
    setState({ tile, items: buildPosterMenu(tile, inContinue) });
    // Back closes the menu like Cancel (the router calls `dismiss`).
    remove = router.pushOverlay(MENU_ID, dismiss);
    queueMicrotask(() => node?.setFocus());
  };
  const choose = async (a: PosterAction) => {
    const s = state();
    remove?.();
    remove = undefined;
    dismiss();
    if (!s) return;
    try {
      if (await runPosterAction(a, s.tile, api)) opts.onChanged();
    } catch {
      showToast("Couldn't save that. Try again.");
    }
  };
  onCleanup(() => { remove?.(); router.removeOverlay(MENU_ID); });
  const View = () => (
    <Show when={state()} keyed>
      {(s) => <ContextMenu ref={(el) => { node = el; }} title={s.tile.title} items={s.items} cancel="cancel" onChoose={(a) => void choose(a)} />}
    </Show>
  );
  return { open, isOpen: () => state() !== undefined, View };
}
