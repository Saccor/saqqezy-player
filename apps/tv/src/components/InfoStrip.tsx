import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, on } from 'solid-js';
import { stopMotion, tween } from '../shell/motion.ts';
import { COLORS, LAYOUT, MOTION, STRONG, TYPE } from '../shell/theme.ts';

export const STRIP_X = LAYOUT.contentX;
export const STRIP_Y = LAYOUT.safeY;
export const STRIP_W = 940;
/** Title, meta and two plot lines end here (rows start below 230). */
export const STRIP_H = 176;
const META_Y = 66;
/** Title and meta only (no plot): where the strip's text ends (Start, which never shows a plot). */
export const STRIP_TEXT_H = META_Y + 30;
const PLOT_Y = 106;
const PLOT_LINE_H = 36;

/**
 * The info strip (spec §1.3): the focused item's title, one meta line and an optional plot. It replaces heroes and
 * per-card titles. Feed it values from `dwellSignal` so it follows focus only once focus rests. Never a spinner.
 * A new title (with its meta and plot) fades in over 140 ms. The first title (also after an empty strip), and a meta or
 * plot that fills in later for the same title, show at once. One container fades: one animation for all three lines.
 */
export function InfoStrip(props: { x?: number; y?: number; width?: number; title: string; meta?: string; plot?: string; plotLines?: number }) {
  const w = () => props.width ?? STRIP_W;
  let node: ElementNode | undefined;
  createEffect(on(() => props.title, (title, prev) => {
    if (!node || !title || !prev) return;
    stopMotion(node);
    node.alpha = MOTION.startAlpha;
    tween(node, { alpha: 1 }, MOTION.textIn);
  }, { defer: true }));
  return (
    <View ref={(el) => { node = el; }} x={props.x ?? STRIP_X} y={props.y ?? STRIP_Y} width={w()} height={STRIP_H} zIndex={2}>
      <Text width={w()} maxWidth={w()} contain="width" maxLines={1} fontSize={TYPE.display} {...STRONG} color={COLORS.text}>{props.title}</Text>
      <Show when={props.meta}>
        <Text y={META_Y} width={w()} maxWidth={w()} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{props.meta ?? ''}</Text>
      </Show>
      <Show when={props.plot}>
        <Text y={PLOT_Y} width={w()} maxWidth={w()} contain="width" maxLines={props.plotLines ?? 2} lineHeight={PLOT_LINE_H}
          fontSize={TYPE.body} color={COLORS.textSecondary}>{props.plot ?? ''}</Text>
      </Show>
    </View>
  );
}
