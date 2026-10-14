import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export const BUTTON_H = 72;

/** Focusable push button. Focused: focus-coloured fill with white text; otherwise a focus-coloured outline. */
export function Button(props: {
  ref?: (el: ElementNode) => void;
  x?: number;
  y?: number;
  width?: number;
  label: string;
  dimmed?: boolean;
  onPress: () => void;
  onUp?: () => boolean | void;
  onDown?: () => boolean | void;
}) {
  const [focused, setFocused] = createSignal(false);
  const w = () => props.width ?? 240;
  return (
    <View ref={props.ref} x={props.x ?? 0} y={props.y ?? 0} width={w()} height={BUTTON_H} borderRadius={LAYOUT.radius}
      color={focused() ? COLORS.focus : COLORS.surface} border={{ width: 2, color: COLORS.focus }}
      alpha={props.dimmed ? 0.5 : 1} scale={focused() ? 1.04 : 1} onFocusChanged={setFocused}
      onEnter={() => { props.onPress(); return true; }}
      onUp={() => props.onUp?.() ?? false} onDown={() => props.onDown?.() ?? false}>
      <Text y={(BUTTON_H - FONT.body) / 2 - 4} width={w()} maxWidth={w()} contain="width" textAlign="center"
        fontSize={FONT.body} color={focused() ? COLORS.onFocus : COLORS.text}>{props.label}</Text>
    </View>
  );
}
