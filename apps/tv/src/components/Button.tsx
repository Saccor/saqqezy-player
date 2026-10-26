import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { controlFill, controlText, isLit } from '../shell/focusStyle.ts';
import { ALPHA, centerText, COLORS, RADIUS, TYPE } from '../shell/theme.ts';

export const BUTTON_H = 64;

/**
 * Focusable push button. Focused: focus fill with onFocus text; otherwise a raised-surface pill with no outline. It is also a
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
  const lit = () => isLit(focused(), hovered(), pointerMode());
  const fill = () => controlFill(lit(), COLORS.surfaceRaised);
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x ?? 0} y={props.y ?? 0} width={w()} height={BUTTON_H}
      borderRadius={RADIUS.pill(BUTTON_H)} color={fill()}
      alpha={props.dimmed ? ALPHA.dimmed : 1} onFocusChanged={setFocused}
      onEnter={() => { props.onPress(); return true; }}
      onUp={() => props.onUp?.() ?? false} onDown={() => props.onDown?.() ?? false}>
      <Text y={centerText(BUTTON_H, TYPE.body)} width={w()} maxWidth={w()} contain="width" textAlign="center"
        fontSize={TYPE.body} color={controlText(lit())}>{props.label}</Text>
    </View>
  );
}
