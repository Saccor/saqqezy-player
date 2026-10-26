import { For, Text, View } from '@lightningtv/solid';
import { createMemo } from 'solid-js';
import { BADGE_PAD, badgesWidth, layoutBadges } from '../playback/mediaBadges.ts';
import { COLORS, RADIUS, STROKE, TYPE, centerText } from '../shell/theme.ts';
import { textWidth } from './textWidth.ts';

export const BADGE_H = 40;
export type BadgeTone = 'quiet' | 'selected';

export const badgeWidth = (text: string): number => Math.ceil(textWidth(text, TYPE.meta)) + BADGE_PAD * 2;

/**
 * One small outlined label (spec 2026-10-26 §1.3): meta text in a pill outline, no fill. `selected` is the only accent
 * case (a ✓ count). `lit`: the badge sits on a focus fill. Screens decide how many badges to show (phase 2).
 */
export function Badge(props: { x?: number; y?: number; text: string; tone?: BadgeTone; lit?: boolean }) {
  const ink = () => (props.lit ? COLORS.onFocusMuted : props.tone === 'selected' ? COLORS.accent : COLORS.subtle);
  const textInk = () => (props.lit ? COLORS.onFocus : props.tone === 'selected' ? COLORS.accent : COLORS.text);
  return (
    <View x={props.x ?? 0} y={props.y ?? 0} width={badgeWidth(props.text)} height={BADGE_H} borderRadius={RADIUS.pill(BADGE_H)}
      color={COLORS.transparent} border={{ width: STROKE.outline, color: ink() }}>
      <Text x={BADGE_PAD} y={centerText(BADGE_H, TYPE.meta)} maxLines={1} fontSize={TYPE.meta} color={textInk()}>{props.text}</Text>
    </View>
  );
}

/**
 * One row of badges about what is playing ("4K", "HDR10", "23.976 fps", …). Badges that do not fit `maxWidth` are left
 * out from the end. `align: 'right'` ends the row at `x + maxWidth`.
 */
export function BadgeRow(props: { x: number; y: number; maxWidth: number; badges: readonly string[]; align?: 'left' | 'right' }) {
  const placed = createMemo(() => layoutBadges(props.badges, (t) => textWidth(t, TYPE.meta), props.maxWidth));
  const rowW = () => badgesWidth(placed());
  const x = () => (props.align === 'right' ? props.x + props.maxWidth - rowW() : props.x);
  return (
    <View x={x()} y={props.y} width={rowW()} height={BADGE_H}>
      <For each={placed()}>{(b) => <Badge x={b.x} text={b.text} />}</For>
    </View>
  );
}
