import { Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { Row } from '@lightningtv/solid/primitives';
import { COLORS, FONT, LAYOUT } from './theme.ts';

const WIDTH = 720;
const HEIGHT = 300;
const BTN_W = 200;
const BTN_H = 72;

function DialogButton(props: { label: string; onPress: () => void }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View width={BTN_W} height={BTN_H} borderRadius={LAYOUT.radius}
      color={focused() ? COLORS.focus : COLORS.background} onFocusChanged={setFocused}
      onEnter={() => { props.onPress(); return true; }}>
      <Text y={(BTN_H - FONT.body) / 2 - 4} width={BTN_W} maxWidth={BTN_W} contain="width" textAlign="center"
        fontSize={FONT.body} color={focused() ? COLORS.onFocus : COLORS.text}>{props.label}</Text>
    </View>
  );
}

/**
 * Modal yes/no question over a scrim. Focus starts on No (index 1). It handles no Back itself: the shell
 * registers it as an overlay, so Back closes it the same way as choosing No.
 */
export function ConfirmDialog(props: { message: string; yes?: string; no?: string; onYes: () => void; onNo: () => void }) {
  const rowW = BTN_W * 2 + LAYOUT.gap;
  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={50}>
      <View x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - HEIGHT) / 2} width={WIDTH} height={HEIGHT}
        color={COLORS.surface} borderRadius={LAYOUT.radius * 2}>
        <Text x={0} y={64} width={WIDTH} maxWidth={WIDTH} contain="width" textAlign="center"
          fontSize={FONT.heading} color={COLORS.text}>{props.message}</Text>
        <Row x={(WIDTH - rowW) / 2} y={HEIGHT - BTN_H - 56} width={rowW} height={BTN_H} gap={LAYOUT.gap}
          scroll="none" selected={1} autofocus>
          <DialogButton label={props.yes ?? 'Yes'} onPress={props.onYes} />
          <DialogButton label={props.no ?? 'No'} onPress={props.onNo} />
        </Row>
      </View>
    </View>
  );
}
