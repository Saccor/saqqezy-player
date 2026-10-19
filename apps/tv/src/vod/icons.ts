/**
 * Transport icons for the VOD player: white glyphs on a transparent canvas, used as image textures (a node's `color`
 * tints them). Drawn once per kind and cached as data URLs, like `scrim.ts`: no icon font, no glyphs a TV font lacks.
 */
export type IconKind = 'play' | 'pause' | 'back10' | 'fwd10' | 'back30' | 'fwd30' | 'volume' | 'mute';

const SIZE = 96;
const cache = new Map<IconKind, string>();

function draw(ctx: CanvasRenderingContext2D, kind: IconKind): void {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  if (kind === 'play') {
    ctx.beginPath();
    ctx.moveTo(30, 18);
    ctx.lineTo(80, 48);
    ctx.lineTo(30, 78);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (kind === 'pause') {
    ctx.fillRect(24, 18, 16, 60);
    ctx.fillRect(56, 18, 16, 60);
    return;
  }
  if (kind === 'volume' || kind === 'mute') {
    // A speaker; with sound, two arcs; muted, a cross.
    ctx.beginPath();
    ctx.moveTo(14, 36);
    ctx.lineTo(32, 36);
    ctx.lineTo(54, 16);
    ctx.lineTo(54, 80);
    ctx.lineTo(32, 60);
    ctx.lineTo(14, 60);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    if (kind === 'mute') {
      ctx.beginPath();
      ctx.moveTo(64, 34);
      ctx.lineTo(86, 62);
      ctx.moveTo(86, 34);
      ctx.lineTo(64, 62);
      ctx.stroke();
      return;
    }
    for (const r of [14, 28]) {
      ctx.beginPath();
      ctx.arc(56, 48, r, -Math.PI / 3.2, Math.PI / 3.2, false);
      ctx.stroke();
    }
    return;
  }
  // A circular arrow (back: counter-clockwise, arrowhead at the top left; forward: mirrored) around "10" or "30".
  const fwd = kind === 'fwd10' || kind === 'fwd30';
  const seconds = kind.endsWith('30') ? '30' : '10';
  ctx.save();
  if (fwd) {
    ctx.translate(SIZE, 0);
    ctx.scale(-1, 1);
  }
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  // From the arrowhead at about 11 o'clock, clockwise round to about 9 o'clock (an open arc of ~300°).
  ctx.arc(48, 50, 36, -Math.PI * 0.62, Math.PI * 0.95, false);
  ctx.stroke();
  // The arrowhead at the arc's start, pointing back along it (counter-clockwise).
  const a = -Math.PI * 0.62;
  const hx = 48 + 36 * Math.cos(a);
  const hy = 50 + 36 * Math.sin(a);
  ctx.beginPath();
  ctx.moveTo(hx - 16, hy - 4);
  ctx.lineTo(hx + 6, hy - 14);
  ctx.lineTo(hx + 4, hy + 10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(seconds, 48, 52);
}

/** The icon's texture URL; undefined without a DOM or 2D canvas. */
export function iconTexture(kind: IconKind): string | undefined {
  const hit = cache.get(kind);
  if (hit) return hit;
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  draw(ctx, kind);
  const url = canvas.toDataURL('image/png');
  cache.set(kind, url);
  return url;
}
