import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { controlFill, controlText, isLit } from '../shell/focusStyle.ts';
import { centerText, COLORS, STRONG, TYPE } from '../shell/theme.ts';
import { iconTexture } from '../vod/icons.ts';
import { CHEVRON, dropdownWidth, GAP, PAD_X } from './dropdownLogic.ts';

const DROPDOWN_H = 64;

/**
 * "Action ▾": a focusable header that opens a picker (`onPress`). Focused: a focus fill. It replaces the library's
 * category rail, the browse chips and the season tabs (spec §1.3). `align: 'right'` puts its right edge at x.
 */
export function DropdownHeader(props: {
  ref?: (el: ElementNode) => void;
  x: number; y: number;
  label: string;
  size?: number;
  /** Pill height (default `DROPDOWN_H`); the radius and the label's centring follow it. */
  height?: number;
  /** Clamps the pill's width; a longer label truncates. */
  maxWidth?: number;
  align?: 'left' | 'right';
  onPress: () => void;
  onUp?: () => boolean; onDown?: () => boolean; onLeft?: () => boolean; onRight?: () => boolean;
  onFocusChanged?: (f: boolean) => void;
  /** False: the pointer passes over it (a modal keyboard is open). Default true. */
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node, enabled: () => props.pointerEnabled !== false,
    onHover: (p) => setHovered(p !== undefined), onClick: () => props.onPress(),
  });
  const size = () => props.size ?? TYPE.title;
  const h = () => props.height ?? DROPDOWN_H;
  const w = () => Math.min(dropdownWidth(props.label, size()), props.maxWidth ?? Infinity);
  const textW = () => w() - PAD_X * 2 - CHEVRON - GAP;
  const lit = () => isLit(focused(), hovered(), pointerMode());
  const fill = () => controlFill(lit());
  const ink = () => controlText(lit());
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.align === 'right' ? props.x - w() : props.x - PAD_X} y={props.y}
      width={w()} height={h()} borderRadius={h() / 2} color={fill()}
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onEnter={() => { props.onPress(); return true; }}
      onUp={() => props.onUp?.() ?? true} onDown={() => props.onDown?.() ?? false}
      onLeft={() => props.onLeft?.() ?? false} onRight={() => props.onRight?.() ?? true}>
      <Text x={PAD_X} y={centerText(h(), size())} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        fontSize={size()} {...STRONG} color={ink()}>{props.label}</Text>
      <View x={w() - PAD_X - CHEVRON} y={(h() - CHEVRON) / 2} width={CHEVRON} height={CHEVRON}
        src={iconTexture('chevron')} color={lit() ? COLORS.onFocus : COLORS.subtle} />
    </View>
  );
}

/** A round icon button the height of a header (the folder search beside a dropdown); focused: a focus fill. */
export function HeaderIconButton(props: {
  ref?: (el: ElementNode) => void;
  x: number; y: number; size: number;
  icon: Parameters<typeof iconTexture>[0];
  onPress: () => void;
  onUp?: () => boolean; onDown?: () => boolean; onLeft?: () => boolean; onRight?: () => boolean;
  onFocusChanged?: (f: boolean) => void;
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node, enabled: () => props.pointerEnabled !== false,
    onHover: (p) => setHovered(p !== undefined), onClick: () => props.onPress(),
  });
  const glyph = () => Math.round(props.size * 0.55);
  // Focus 2.0: hover equals focus, one control fill.
  const lit = () => isLit(focused(), hovered(), pointerMode());
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x} y={props.y} width={props.size} height={props.size}
      borderRadius={props.size / 2} color={controlFill(lit())}
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onEnter={() => { props.onPress(); return true; }}
      onUp={() => props.onUp?.() ?? true} onDown={() => props.onDown?.() ?? false}
      onLeft={() => props.onLeft?.() ?? false} onRight={() => props.onRight?.() ?? true}>
      <View x={(props.size - glyph()) / 2} y={(props.size - glyph()) / 2} width={glyph()} height={glyph()}
        src={iconTexture(props.icon)} color={controlText(lit())} />
    </View>
  );
}
