import { For, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { imageSrc } from '../images/imageSrc.ts';
import { tween } from '../shell/motion.ts';
import { MOTION } from '../shell/theme.ts';
import { failLayer, pushLayer, settleLayer, type FadeLayer } from './fadeLogic.ts';

/**
 * A new layer's starting alpha: invisible, but above 0, because the renderer does not load the texture of a node with
 * alpha 0 (it is not renderable), so its `loaded` event would never come.
 */
const START_ALPHA = MOTION.startAlpha;
/**
 * Cover fitting (renderer 3.7 `textureOptions.resizeMode`): the image fills the box at its own aspect, centred, and the
 * overflow is cropped through the texture coordinates. A 2:3 poster in the wide strip box is never stretched.
 */
const COVER = { resizeMode: { type: 'cover' } } as const;

/**
 * An image box that cross-fades (cover-fitted, never stretched): a new `url` is drawn on a second image node above the current one and fades in over
 * 260 ms (`MOTION.backdrop`, the fade curve) once its texture has loaded; then the old node goes. No `url`: nothing is drawn. `onFailed` reports an image
 * that could not load, once per layer; when it was the new (top) image every layer goes, so the box is empty and the
 * screen's fallback can show.
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
    let fading = false;
    const id = p.id;
    const url = layers().find((l) => l.id === id)?.url ?? '';
    const onLoaded = () => {
      if (!node || fading || !alive) return;
      fading = true;
      // Through the motion helper: the fade curve, capped under reduced motion, snapped when motion is off.
      tween(node, { alpha: 1 }, MOTION.backdrop, () => { if (alive) setLayers((ls) => settleLayer(ls, id)); });
    };
    let failed = false;
    const onFailed = () => {
      if (!alive || failed) return;
      failed = true;
      setLayers((ls) => failLayer(ls, id));
      props.onFailed?.(url);
    };
    return (
      <View ref={(el) => { node = el; }} zIndex={p.z} width={props.width} height={props.height} alpha={START_ALPHA}
        src={imageSrc(url, props.width, props.height)} textureOptions={COVER} onEvent={{ loaded: onLoaded, failed: onFailed }} />
    );
  };

  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <For each={layers().map((l) => l.id)}>{(id, i) => <Layer id={id} z={i()} />}</For>
    </View>
  );
}
