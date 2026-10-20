import { Show, View, type ElementNode, type JSX } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { router } from '../shell/router.ts';
import { OptionsMenu, type OptionItem } from './OptionsMenu.tsx';

/**
 * A promise-based action menu as a router overlay (Back answers undefined). Same behaviour as Settings' `choose`.
 * `close()` removes it silently (the screen is going away); `close({ answer: true })` closes it like Back from code:
 * the pending choice answers undefined and focus returns to the screen.
 */
export function createChoiceMenu(id: string, refocus: () => void) {
  const [state, setState] = createSignal<{ title: string; items: OptionItem[]; answer: (v?: string) => void } | undefined>();
  let node: ElementNode | undefined;
  let removeLayer: (() => void) | undefined;
  const close = (o?: { answer?: boolean }) => {
    const s = state();
    if (o?.answer && s) { s.answer(undefined); return; }
    removeLayer?.(); removeLayer = undefined; setState(undefined);
  };
  const choose = (title: string, items: OptionItem[]) => new Promise<string | undefined>((resolve) => {
    const answer = (v?: string) => { close(); refocus(); resolve(v === 'cancel' ? undefined : v); };
    setState({ title, items, answer });
    removeLayer = router.pushOverlay(id, () => { removeLayer = undefined; setState(undefined); refocus(); resolve(undefined); });
    queueMicrotask(() => node?.setFocus());
  });
  const MenuView = (): JSX.Element => (
    <Show when={state()}>{(s) => (
      <View zIndex={80}><OptionsMenu ref={(el) => { node = el; }} title={s().title} items={s().items} onChoose={(v) => s().answer(v)} /></View>
    )}</Show>
  );
  return { choose, close, isOpen: () => state() !== undefined, View: MenuView };
}
