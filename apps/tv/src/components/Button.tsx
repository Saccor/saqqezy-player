import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export const BUTTON_H = 72;

/**
 * Focusable push button. Focused: focus-coloured fill with white text; otherwise a focus-coloured outline. It is also a
 * pointer target: a click does the same as Ok (`onPress`), and hover lightens the fill in pointer mode.
 */
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
  /** Pointer hit-test layer. Default 'screen'. */
  pointerLayer?: 'screen' | 'overlay';
  /** Shell-owned button: hit-tested on every screen. */
  pointerGlobal?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node,
    layer: props.pointerLayer,
    global: props.pointerGlobal,
    onHover: (p) => setHovered(p !== undefined),
    onClick: () => props.onPress(),
  });
  const w = () => props.width ?? 240;
  const fill = () => (focused() ? COLORS.focus : hovered() && pointerMode() ? COLORS.hover : COLORS.surface);
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x ?? 0} y={props.y ?? 0} width={w()} height={BUTTON_H}
      borderRadius={LAYOUT.radius} color={fill()} border={{ width: 2, color: COLORS.focus }}
      alpha={props.dimmed ? 0.5 : 1} scale={focused() ? 1.04 : 1} onFocusChanged={setFocused}
      onEnter={() => { props.onPress(); return true; }}
      onUp={() => props.onUp?.() ?? false} onDown={() => props.onDown?.() ?? false}>
      <Text y={(BUTTON_H - FONT.body) / 2 - 4} width={w()} maxWidth={w()} contain="width" textAlign="center"
        fontSize={FONT.body} color={focused() ? COLORS.onFocus : COLORS.text}>{props.label}</Text>
    </View>
  );
}
