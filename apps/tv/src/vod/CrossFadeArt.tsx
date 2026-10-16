import { For, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { dropLayer, pushLayer, settleLayer, type FadeLayer } from './fadeLogic.ts';

/** How long a new image takes to fade in (spec §6). */
export const ART_FADE_MS = 200;
/**
 * A new layer's starting alpha: invisible, but above 0, because the renderer does not load the texture of a node with
 * alpha 0 (it is not renderable), so its `loaded` event would never come.
 */
const START_ALPHA = 0.001;

/**
 * An image box that cross-fades: a new `url` is drawn on a second image node above the current one and fades in over
 * 200 ms once its texture has loaded; then the old node goes. No `url`: nothing is drawn. `onFailed` reports an image
 * that could not load (its layer goes; the one under it stays).
 */
export function CrossFadeArt(props: { url: string | undefined; x: number; y: number; width: number; height: number; onFailed?: (url: string) => void }) {
  const [layers, setLayers] = createSignal<FadeLayer[]>([]);
  let nextId = 0;
  let alive = true;
  createEffect(on(() => props.url, (u) => setLayers((ls) => pushLayer(ls, u, ++nextId))));
  onCleanup(() => { alive = false; });

  /** One image node per layer id (keyed by id: settling a layer must not remount its node). */
  const Layer = (p: { id: number; z: number }) => {
    let node: ElementNode | undefined;
    let fade: { stop(): unknown; waitUntilStopped(): Promise<void> } | undefined;
    const id = p.id;
    const url = layers().find((l) => l.id === id)?.url ?? '';
    const onLoaded = () => {
      if (!node || fade || !alive) return;
      fade = node.animate({ alpha: 1 }, { duration: ART_FADE_MS, easing: 'ease-in-out' }).start();
      void fade.waitUntilStopped().then(() => { if (alive) setLayers((ls) => settleLayer(ls, id)); });
    };
    const onFailed = () => {
      if (!alive) return;
      setLayers((ls) => dropLayer(ls, id));
      props.onFailed?.(url);
    };
    onCleanup(() => fade?.stop());
    return (
      <View ref={(el) => { node = el; }} zIndex={p.z} width={props.width} height={props.height} alpha={START_ALPHA}
        src={rawViaDevProxy(url)} onEvent={{ loaded: onLoaded, failed: onFailed }} />
    );
  };

  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <For each={layers().map((l) => l.id)}>{(id, i) => <Layer id={id} z={i()} />}</For>
    </View>
  );
}
