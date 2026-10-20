import { Text, View } from '@lightningtv/solid';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

const H = 110;
/** Below the shell clock in the top-right corner. */
const Y = LAYOUT.safeY + 64;

/** Top-right box with the digits being typed, or a short message such as "No channel 123". */
export function NumberEntry(props: { text: string; message?: string | undefined }) {
  // Wide enough for the longest message on one line ("Previous channel not available" is about 500 px).
  const width = () => (props.message ? 600 : 240);
  return (
    <View x={LAYOUT.width - LAYOUT.safeX - width()} y={Y} width={width()} height={H}
      color={COLORS.panel} borderRadius={LAYOUT.radius * 2} border={{ width: 2, color: COLORS.subtle }} zIndex={30}>
      <Text y={props.message ? (H - FONT.heading) / 2 - 4 : (H - 72) / 2 - 4} width={width()} maxWidth={width()}
        contain="width" maxLines={1} textAlign="center" fontSize={props.message ? FONT.heading : 72}
        color={COLORS.text}>{props.message ?? props.text}</Text>
    </View>
  );
}
