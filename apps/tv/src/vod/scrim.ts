/**
 * Fade textures for the hero art: a tiny canvas gradient (from the background colour to fully transparent) used as an
 * image. Lightning's `linearGradient` shader paints the node colour where the gradient is transparent, so it cannot fade
 * art into the background; a texture can. Built once per direction and cached as a data URL.
 */
export type ScrimDirection = 'left' | 'down' | 'player' | 'banner';

/**
 * Alpha stops from the opaque edge (0) to the far edge (1). 'player': the VOD controls' band, dark enough for white
 * text on the brightest picture across its lower part, fading out only in its top third. 'banner': the live info
 * banner's fade (460 px from the bottom edge, more with the pointer lift); its text sits in the lower ~64 %, which stays
 * at 0.8 alpha or more, and only the band above the text fades out.
 */
const STOPS: Record<ScrimDirection, [number, number][]> = {
  left: [[0, 1], [0.1, 1], [0.7, 0], [1, 0]],
  down: [[0, 1], [1, 0]],
  player: [[0, 0.92], [0.45, 0.85], [0.7, 0.6], [1, 0]],
  banner: [[0, 0.92], [0.4, 0.9], [0.65, 0.8], [1, 0]],
};

const cache = new Map<ScrimDirection, string>();

/** `rgb`: the background colour as 0xRRGGBB. 'left': opaque at the left edge; 'down', 'player' and 'banner': at the bottom edge. */
export function scrimTexture(dir: ScrimDirection, rgb: number): string | undefined {
  const hit = cache.get(dir);
  if (hit) return hit;
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  const long = 256;
  canvas.width = dir === 'left' ? long : 1;
  canvas.height = dir === 'left' ? 1 : long;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  const grad = dir === 'left' ? ctx.createLinearGradient(0, 0, long, 0) : ctx.createLinearGradient(0, long, 0, 0);
  for (const [at, a] of STOPS[dir]) grad.addColorStop(at, `rgba(${r},${g},${b},${a})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/png');
  cache.set(dir, url);
  return url;
}
