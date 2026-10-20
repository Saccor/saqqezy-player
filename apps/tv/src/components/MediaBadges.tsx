import { For, Text, View } from '@lightningtv/solid';
import { createMemo } from 'solid-js';
import { BADGE_PAD, badgesWidth, layoutBadges } from '../playback/mediaBadges.ts';
import { COLORS, TYPE } from '../shell/theme.ts';

export const BADGE_H = 40;

let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/**
 * A badge's text width at meta size. Lightning measures text late, so the same font is measured on a 2D canvas
 * (the renderer's `sans-serif`); without one, an average-glyph estimate.
 */
function textWidth(text: string): number {
  const hit = widths.get(text);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    try {
      ctx = document.createElement('canvas').getContext('2d');
      if (ctx) ctx.font = `${TYPE.meta}px sans-serif`;
    } catch {
      ctx = null;
    }
  }
  const w = ctx ? ctx.measureText(text).width : text.length * 0.6 * TYPE.meta;
  widths.set(text, w);
  return w;
}

/**
 * One row of rounded badges about what is playing ("4K", "HDR10", "23.976 fps", …). Badges that do not fit
 * `maxWidth` are left out from the end. `align: 'right'` ends the row at `x + maxWidth`.
 */
export function MediaBadges(props: { x: number; y: number; maxWidth: number; badges: readonly string[]; align?: 'left' | 'right' }) {
  const placed = createMemo(() => layoutBadges(props.badges, textWidth, props.maxWidth));
  const rowW = () => badgesWidth(placed());
  const x = () => (props.align === 'right' ? props.x + props.maxWidth - rowW() : props.x);
  return (
    <View x={x()} y={props.y} width={rowW()} height={BADGE_H}>
      <For each={placed()}>{(b) => (
        <View x={b.x} width={b.width} height={BADGE_H} borderRadius={BADGE_H / 2} color={COLORS.badge}>
          <Text x={BADGE_PAD} y={(BADGE_H - TYPE.meta) / 2 - 1} maxLines={1} fontSize={TYPE.meta} color={COLORS.text}>{b.text}</Text>
        </View>
      )}</For>
    </View>
  );
}
