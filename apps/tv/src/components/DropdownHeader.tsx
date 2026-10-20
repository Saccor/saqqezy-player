import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, STRONG, TYPE } from '../shell/theme.ts';
import { iconTexture } from '../vod/icons.ts';
import { dropdownWidth } from './dropdownLogic.ts';

export const DROPDOWN_H = 64;
const CHEVRON = 28;
const PAD_X = 20;

/**
 * "Action ▾": a focusable header that opens a picker (`onPress`). Focused: a focus fill. It replaces the library's
 * category rail, the browse chips and the season tabs (spec §1.3). `align: 'right'` puts its right edge at x.
 */
export function DropdownHeader(props: {
  ref?: (el: ElementNode) => void;
  x: number; y: number;
  label: string;
  size?: number;
  /** Clamps the pill's width; a longer label truncates. */
  maxWidth?: number;
  align?: 'left' | 'right';
  onPress: () => void;
  onUp?: () => boolean; onDown?: () => boolean; onLeft?: () => boolean; onRight?: () => boolean;
  onFocusChanged?: (f: boolean) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({ node: () => node, onHover: (p) => setHovered(p !== undefined), onClick: () => props.onPress() });
  const size = () => props.size ?? TYPE.title;
  const w = () => Math.min(dropdownWidth(props.label, size()), props.maxWidth ?? Infinity);
  const textW = () => w() - PAD_X * 2 - CHEVRON - 12;
  const fill = () => (focused() ? COLORS.focus : hovered() && pointerMode() ? COLORS.hover : COLORS.transparent);
  const ink = () => (focused() ? COLORS.onFocus : COLORS.text);
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.align === 'right' ? props.x - w() : props.x - PAD_X} y={props.y}
      width={w()} height={DROPDOWN_H} borderRadius={DROPDOWN_H / 2} color={fill()}
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onEnter={() => { props.onPress(); return true; }}
      onUp={() => props.onUp?.() ?? true} onDown={() => props.onDown?.() ?? false}
      onLeft={() => props.onLeft?.() ?? false} onRight={() => props.onRight?.() ?? true}>
      <Text x={PAD_X} y={(DROPDOWN_H - size()) / 2 - 3} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        fontSize={size()} {...STRONG} color={ink()}>{props.label}</Text>
      <View x={w() - PAD_X - CHEVRON} y={(DROPDOWN_H - CHEVRON) / 2} width={CHEVRON} height={CHEVRON}
        src={iconTexture('chevron')} color={focused() ? COLORS.onFocus : COLORS.subtle} />
    </View>
  );
}
