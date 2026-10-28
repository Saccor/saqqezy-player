import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo } from 'solid-js';
import { Row } from '@lightningtv/solid/primitives';
import { COMMON_COPY } from '../copy/common.ts';
import { usePointerBackdrop, usePointerTarget } from '../input/pointer.ts';
import { scrimIn } from '../shell/motion.ts';
import { COLORS, LAYOUT, LINE, RADIUS, STRONG, TYPE } from '../shell/theme.ts';
import { Button, BUTTON_H } from './Button.tsx';
import { DIALOG_PAD, DIALOG_W, dialogButtons, dialogFrame, dialogLineCount } from './sheetLogic.ts';
import { textWidth } from './textWidth.ts';

/**
 * A centred Sheet variant (spec 2026-10-26 §1.3): a title, one line, an optional large detail (a recovery code), 1–2
 * buttons. Focus starts on No (index 1); `no: null` leaves one button, focused. It handles no Back itself: the owner
 * registers it as an overlay, so Back is No. A click outside the box is Back; its targets are global (it must stay modal
 * on any screen).
 */
export function Dialog(props: { title: string; line?: string; detail?: string; yes?: string; no?: string | null; onYes: () => void; onNo: () => void }) {
  const single = () => props.no === null;
  const yesLabel = () => props.yes ?? COMMON_COPY.yes;
  const noLabel = () => props.no ?? COMMON_COPY.no;
  const btns = createMemo(() => dialogButtons(single() ? [yesLabel()] : [yesLabel(), noLabel()], textWidth));
  const rowW = () => btns().rowW;
  const lines = createMemo(() => dialogLineCount(props.line, textWidth));
  const f = () => dialogFrame(lines(), props.detail !== undefined, BUTTON_H);
  const textW = DIALOG_W - DIALOG_PAD * 2;
  let scrim: ElementNode | undefined;
  let lift: ElementNode | undefined;
  let box: ElementNode | undefined;
  // Backdrop first, then the box (it swallows clicks between the buttons); the buttons register after both.
  usePointerBackdrop(() => scrim, undefined, true);
  usePointerTarget({ node: () => box, layer: 'overlay', global: true });
  return (
    <View ref={(el) => { scrim = el; scrimIn(el, () => lift); }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={60}>
      <View ref={(el) => { lift = el; }}>
        <View ref={(el) => { box = el; }} x={f().x} y={f().y} width={f().w} height={f().h} color={COLORS.panel} borderRadius={RADIUS.card}>
          <Text x={DIALOG_PAD} y={f().titleY} width={textW} maxWidth={textW} contain="width" maxLines={1} textAlign="center"
            fontSize={TYPE.title} {...STRONG} color={COLORS.text}>{props.title}</Text>
          <Show when={props.line}>
            <Text x={DIALOG_PAD} y={f().lineY} width={textW} maxWidth={textW} contain="width" maxLines={2} textAlign="center"
              fontSize={TYPE.body} lineHeight={LINE.body} color={COLORS.textSecondary}>{props.line ?? ''}</Text>
          </Show>
          <Show when={props.detail}>
            <Text x={DIALOG_PAD} y={f().detailY} width={textW} maxWidth={textW} contain="width" maxLines={1} textAlign="center"
              fontSize={TYPE.title} {...STRONG} color={COLORS.text}>{props.detail ?? ''}</Text>
          </Show>
          <Row x={(DIALOG_W - rowW()) / 2} y={f().buttonsY} width={rowW()} height={BUTTON_H} gap={LAYOUT.gap}
            scroll="none" selected={single() ? 0 : 1} autofocus>
            <Button width={btns().w} label={yesLabel()} onPress={props.onYes} pointerLayer="overlay" pointerGlobal />
            <Show when={!single()}>
              <Button width={btns().w} label={noLabel()} onPress={props.onNo} pointerLayer="overlay" pointerGlobal />
            </Show>
          </Row>
        </View>
      </View>
    </View>
  );
}
