import { TYPE } from '../shell/theme.ts';

let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/**
 * A text's width at `size` px in the renderer's `sans-serif`. Lightning measures text late, so the same font is measured
 * on a 2D canvas; without one (tests, a TV without canvas text), an average-glyph estimate.
 */
export function textWidth(text: string, size: number = TYPE.meta): number {
  const key = `${size}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    try {
      ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
  }
  let w: number;
  if (ctx) {
    ctx.font = `${size}px sans-serif`;
    w = ctx.measureText(text).width;
  } else {
    w = text.length * 0.6 * size;
  }
  widths.set(key, w);
  return w;
}

/**
 * Text for a wrapping <Text> (`maxWidth` set): Lightning's layout counts a run of spaces as one space but draws them
 * all, so the texture is cut short at the end ("1  Channel 001" lost half its last digit). Every space of a run after the
 * first becomes a no-break space: the same width, and measured as part of the next word.
 */
export const keepSpaces = (text: string): string => text.replace(/ {2,}/g, (run) => ` ${'\u00a0'.repeat(run.length - 1)}`);
