import { Show, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, on } from 'solid-js';
import { stopMotion, tween } from './motion.ts';
import { COLORS, LAYOUT, MOTION } from './theme.ts';
import { type Quad, curveLength, layoutLine, layoutOnCurve } from './wordmarkLayout.ts';

/**
 * The arched mark is designed in a 300x130 box: "SAQQEZY" on the arc `M40,95 Q150,10 260,95`, "PLAYER"
 * straight underneath. Only the inked band (box y `CROP_TOP`..`CROP_BOTTOM`) is drawn, so the empty top of the
 * box does not push the mark below the overscan-safe line.
 */
const BOX_W = 300;
const CROP_TOP = 22;
const CROP_BOTTOM = 114;
const ARC: Quad = { p0: { x: 40, y: 95 }, p1: { x: 150, y: 10 }, p2: { x: 260, y: 95 } };
const NAME = 'SAQQEZY';
const NAME_SIZE = 38;
const NAME_SPACING = 3;
const SUB = 'PLAYER';
const SUB_SIZE = 13;
const SUB_SPACING = 12;
const SUB_BASELINE = 112;
/** Heavy faces common to TV and desktop browsers; the generic family synthesises bold if none is present. */
const FONT_STACK = '"Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif';
/** Drawn at 2x the design size, so it stays sharp on a 4K panel scaled from the 1920x1080 design space. */
const RES = 2;

/** Drawn bounds in the 1920x1080 design space: centred, at the top of the overscan-safe area. */
const WORDMARK_W = BOX_W;
const WORDMARK_H = CROP_BOTTOM - CROP_TOP;
const WORDMARK_X = (LAYOUT.width - WORDMARK_W) / 2;
const WORDMARK_Y = LAYOUT.safeY;
/** First free design y below the mark; top-row content that crosses the centre starts here. */
export const WORDMARK_BOTTOM = WORDMARK_Y + WORDMARK_H;
/**
 * Horizontal zone reserved around the screen centre for the top row. Badges stay outside it; the drawn mark is
 * narrower and centred inside it.
 */
const WORDMARK_ZONE_W = 520;
export const WORDMARK_ZONE_X = (LAYOUT.width - WORDMARK_ZONE_W) / 2;

const css = (rgba: number) => `#${(rgba >>> 8).toString(16).padStart(6, '0')}`;

function glyphWidths(ctx: CanvasRenderingContext2D, text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(ctx.measureText(text.charAt(i)).width);
  return out;
}

/** Renders the mark to an offscreen canvas (transparent background) and returns it as a PNG data URL. */
function renderWordmark(): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = BOX_W * RES;
  canvas.height = WORDMARK_H * RES;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.scale(RES, RES);
  ctx.translate(0, -CROP_TOP);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // "SAQQEZY" along the arc, each glyph's baseline centred on the curve and turned to its tangent.
  let size = NAME_SIZE;
  ctx.font = `900 ${size}px ${FONT_STACK}`;
  let widths = glyphWidths(ctx, NAME);
  const room = curveLength(ARC) - 8;
  const run = widths.reduce((s, w) => s + w, 0) + NAME_SPACING * (widths.length - 1);
  if (run > room) {
    // A wider fallback face: shrink so the word still fits the arc.
    size = Math.floor(size * (room / run));
    ctx.font = `900 ${size}px ${FONT_STACK}`;
    widths = glyphWidths(ctx, NAME);
  }
  ctx.fillStyle = css(COLORS.text);
  layoutOnCurve(ARC, widths, NAME_SPACING).forEach((g, i) => {
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.angle);
    ctx.fillText(NAME.charAt(i), 0, 0);
    ctx.restore();
  });

  // "PLAYER" straight and centred below; per glyph, because canvas letterSpacing is newer than Chromium 76.
  ctx.font = `600 ${SUB_SIZE}px ${FONT_STACK.replace('"Arial Black", ', '')}`;
  ctx.fillStyle = css(COLORS.muted);
  layoutLine(glyphWidths(ctx, SUB), SUB_SPACING, BOX_W / 2).forEach((x, i) => {
    ctx.fillText(SUB.charAt(i), x, SUB_BASELINE);
  });

  return canvas.toDataURL('image/png');
}

let cached: string | undefined;
/** The rendered mark as a PNG data URL (2x), drawn once and cached. */
function wordmarkImage(): string | undefined {
  if (cached === undefined) cached = renderWordmark();
  return cached;
}

/**
 * "SAQQEZY" arched over "PLAYER": the brand wordmark, centred at the top. Lightning cannot set text on a
 * path, so it is drawn once to a 2D canvas and shown as an image texture. The shell renders it once above the
 * screen host; `visible` fades it in or out over 200 ms (it is hidden in the full-screen Player).
 *
 * `defer`: while true the canvas is not drawn at all, so it stays off the cold-start path (see `deferWordmark`).
 * Once false, it is drawn on the next animation frame and fades in.
 */
export function Wordmark(props: { visible: boolean; defer: boolean }) {
  let node: ElementNode | undefined;
  const [src, setSrc] = createSignal<string | undefined>(undefined);
  let drawRequested = false;
  createEffect(() => {
    if (props.defer || drawRequested) return;
    drawRequested = true;
    const draw = () => {
      const image = wordmarkImage();
      if (!image) return;
      // Appears from transparent: the same fade as `visible`, so the late draw is not a pop.
      if (node && props.visible) {
        stopMotion(node);
        node.alpha = 0;
        setSrc(image);
        tween(node, { alpha: 1 }, MOTION.wordmark);
      } else {
        setSrc(image);
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw);
    else setTimeout(draw, 0);
  });
  // Fade through the motion helper (the `transition` prop calls `animateProp`, which renderer 3.7 lacks). A toggle
  // mid-fade continues from the current alpha: the old `fade.stop()` reset it to the previous fade's start first, and
  // could stop a pooled controller that already drove another node.
  createEffect(on(() => props.visible, (visible, prev) => {
    if (!node) return;
    const alpha = visible ? 1 : 0;
    if (prev === undefined) { stopMotion(node); node.alpha = alpha; return; }
    tween(node, { alpha }, MOTION.wordmark);
  }));

  return (
    <View ref={node} x={WORDMARK_X} y={WORDMARK_Y} width={WORDMARK_W} height={WORDMARK_H} skipFocus>
      <Show when={src()}>{(s) => <View width={WORDMARK_W} height={WORDMARK_H} src={s()} />}</Show>
    </View>
  );
}
