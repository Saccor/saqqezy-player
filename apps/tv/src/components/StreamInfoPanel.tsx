import { For, Text, View } from '@lightningtv/solid';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

/**
 * Sized to stay clear of the Player's other top and centre boxes: with 7 lines it is 96–696 × 54–400, left of the
 * "Reconnecting…" pill (from x 730) and above the cooldown and failure boxes (from y 420).
 */
const W = 600;
const PAD = 28;
const LINE_H = 34;
const LABEL_W = 180;

/**
 * Technical details of the current stream (top-left). `lines` come from `streamInfoLines`, which only ever
 * includes the host and format of the URL, never its path or credentials.
 */
export function StreamInfoPanel(props: { lines: [string, string][] }) {
  const height = () => PAD * 2 + 52 + props.lines.length * LINE_H;
  return (
    <View x={LAYOUT.safeX} y={LAYOUT.safeY} width={W} height={height()} color={COLORS.panel}
      borderRadius={LAYOUT.radius * 2} zIndex={20}>
      <Text x={PAD} y={PAD} fontSize={FONT.heading} color={COLORS.text}>{'Stream info'}</Text>
      <For each={props.lines}>{(line, i) => (
        <View x={PAD} y={PAD + 52 + i() * LINE_H} width={W - PAD * 2} height={LINE_H}>
          <Text fontSize={FONT.small} color={COLORS.muted}>{line[0]}</Text>
          <Text x={LABEL_W} width={W - PAD * 2 - LABEL_W} maxWidth={W - PAD * 2 - LABEL_W} contain="width" maxLines={1}
            fontSize={FONT.small} color={COLORS.text}>{line[1]}</Text>
        </View>
      )}</For>
    </View>
  );
}
