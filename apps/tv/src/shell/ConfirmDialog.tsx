import { Text, View, type ElementNode } from '@lightningtv/solid';
import { Row } from '@lightningtv/solid/primitives';
import { Button, BUTTON_H } from '../components/Button.tsx';
import { usePointerBackdrop, usePointerTarget } from '../input/pointer.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from './theme.ts';

const WIDTH = 720;
const HEIGHT = 300;
const BTN_W = 200;
/**
 * Modal yes/no question over a scrim. Focus starts on No (index 1). It handles no Back itself: the shell
 * registers it as an overlay, so Back closes it the same way as choosing No. By mouse, the buttons are clickable and
 * a click outside the box is Back. Its targets are global: the dialog is shell-level (App) and must stay modal on any screen.
 */
export function ConfirmDialog(props: { message: string; yes?: string; no?: string; onYes: () => void; onNo: () => void }) {
  const rowW = BTN_W * 2 + LAYOUT.gap;
  let scrim: ElementNode | undefined;
  let box: ElementNode | undefined;
  // Backdrop first, then the box (it swallows clicks between the buttons); the buttons register after both.
  usePointerBackdrop(() => scrim, undefined, true);
  usePointerTarget({ node: () => box, layer: 'overlay', global: true });
  return (
    <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={60}>
      <View ref={(el) => { box = el; }} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - HEIGHT) / 2} width={WIDTH} height={HEIGHT}
        color={COLORS.surface} borderRadius={LAYOUT.radius * 2}>
        {/* At most three lines, ending above the buttons (a long list name used to wrap into them). */}
        <Text x={24} y={40} width={WIDTH - 48} maxWidth={WIDTH - 48} contain="width" maxLines={3} lineHeight={32} textAlign="center"
          fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.message}</Text>
        <Row x={(WIDTH - rowW) / 2} y={HEIGHT - BUTTON_H - 56} width={rowW} height={BUTTON_H} gap={LAYOUT.gap}
          scroll="none" selected={1} autofocus>
          <Button width={BTN_W} label={props.yes ?? 'Yes'} onPress={props.onYes} pointerLayer="overlay" pointerGlobal />
          <Button width={BTN_W} label={props.no ?? 'No'} onPress={props.onNo} pointerLayer="overlay" pointerGlobal />
        </Row>
      </View>
    </View>
  );
}
