import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { Row } from '@lightningtv/solid/primitives';
import { pointerMode, usePointerBackdrop, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from './theme.ts';

const WIDTH = 720;
const HEIGHT = 300;
const BTN_W = 200;
const BTN_H = 72;

function DialogButton(props: { label: string; onPress: () => void }) {
  const [focused, setFocused] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node, layer: 'overlay', global: true, onHover: (p) => setHovered(p !== undefined), onClick: () => props.onPress(),
  });
  return (
    <View ref={(el) => { node = el; }} width={BTN_W} height={BTN_H} borderRadius={LAYOUT.radius}
      color={focused() ? COLORS.focus : hovered() && pointerMode() ? COLORS.hover : COLORS.background} onFocusChanged={setFocused}
      onEnter={() => { props.onPress(); return true; }}>
      <Text y={(BTN_H - FONT.body) / 2 - 4} width={BTN_W} maxWidth={BTN_W} contain="width" textAlign="center"
        fontSize={FONT.body} color={focused() ? COLORS.onFocus : COLORS.text}>{props.label}</Text>
    </View>
  );
}

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
    <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={50}>
      <View ref={(el) => { box = el; }} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - HEIGHT) / 2} width={WIDTH} height={HEIGHT}
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
