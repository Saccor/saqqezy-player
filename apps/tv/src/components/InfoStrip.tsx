import { Show, Text, View } from '@lightningtv/solid';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';

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
 */
export function InfoStrip(props: { x?: number; y?: number; width?: number; title: string; meta?: string; plot?: string; plotLines?: number }) {
  const w = () => props.width ?? STRIP_W;
  return (
    <View x={props.x ?? STRIP_X} y={props.y ?? STRIP_Y} width={w()} height={STRIP_H} zIndex={2}>
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
