/**
 * The layers of a cross-fading image (two stacked image nodes). Pure: no Solid, no Lightning.
 *
 * The bottom layer is the last image that finished fading in (`shown`); a new image goes on top at alpha 0 and fades in
 * once its texture has loaded, then the layers under it go. At most two layers: an image that arrives while another is
 * still fading replaces the fading one, so the bottom is never a half-faded picture.
 */
export interface FadeLayer { id: number; url: string; shown: boolean }

/** `url` becomes the image (undefined: no image, every layer goes). `id` is a fresh id for a new layer. */
export function pushLayer(layers: readonly FadeLayer[], url: string | undefined, id: number): FadeLayer[] {
  if (url === undefined) return [];
  const top = layers[layers.length - 1];
  if (top?.url === url) return layers as FadeLayer[];
  const base = [...layers].reverse().find((l) => l.shown);
  if (base?.url === url) return [base];
  return base ? [base, { id, url, shown: false }] : [{ id, url, shown: false }];
}

/** Layer `id` has faded in: it is shown and the layers under it go. A layer already gone changes nothing. */
export function settleLayer(layers: readonly FadeLayer[], id: number): FadeLayer[] {
  const i = layers.findIndex((l) => l.id === id);
  if (i < 0) return layers as FadeLayer[];
  return [{ ...layers[i]!, shown: true }, ...layers.slice(i + 1)];
}

/** Layer `id` failed to load: it goes, the layers under it stay. */
export function dropLayer(layers: readonly FadeLayer[], id: number): FadeLayer[] {
  return layers.some((l) => l.id === id) ? layers.filter((l) => l.id !== id) : (layers as FadeLayer[]);
}
