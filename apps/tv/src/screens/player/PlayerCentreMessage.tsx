import { Show, Text, View } from '@lightningtv/solid';
import { MESSAGE_BOXES, messageLines, messageTop } from '../../components/messageFit.ts';
import { COLORS, LAYOUT, LINE, RADIUS, SPACE, STRONG, TYPE } from '../../shell/theme.ts';

const CENTRE_W = 1100;
const CENTRE_BOX = MESSAGE_BOXES.player;
const centreH = (text: string) => Math.max(160, messageLines(text, CENTRE_BOX) * CENTRE_BOX.lineH + 80);

/**
 * The full-screen player's centre message (a failure or refusal the stream reports). A refusal that names the
 * account's limit runs to three lines: the box grows for it.
 */
export function PlayerCentreMessage(props: { status: { kind: string; text: string } | undefined }) {
  return (
    <Show when={props.status?.kind === 'centre' ? props.status : undefined} keyed>{(s) => (
      <View x={(LAYOUT.width - CENTRE_W) / 2} y={(LAYOUT.height - centreH(s.text)) / 2} width={CENTRE_W} height={centreH(s.text)}
        color={COLORS.panel} borderRadius={RADIUS.card} zIndex={4}>
        <Text x={SPACE.xl} y={messageTop(s.text, CENTRE_BOX, centreH(s.text))} width={CENTRE_W - SPACE.xl * 2}
          maxWidth={CENTRE_W - SPACE.xl * 2} contain="width" textAlign="center" maxLines={CENTRE_BOX.maxLines} lineHeight={LINE.body}
          fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{s.text}</Text>
      </View>
    )}</Show>
  );
}
