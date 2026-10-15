// apps/tv/src/components/SearchBar.tsx
import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { BAR_PLACEHOLDER } from '../screens/homeSearchLogic.ts';
import { COLORS, FONT } from '../shell/theme.ts';
import { fieldDisplay } from './TextField.tsx';

export const SEARCH_BAR_H = 40;
const TEXT_X = 52;
const COUNT_W = 200;
const PAD_R = 16;

/**
 * Home's search field in the list header row: one focusable node, and the whole field is its click target. It
 * does no editing itself. Home types into it (hardware keys, remote digits, the compact keyboard) through `value`.
 * Ok opens the compact keyboard.
 */
export function SearchBar(props: {
  ref: (el: ElementNode) => void;
  x: number;
  y: number;
  width: number;
  value: string;
  /** Right-aligned result count (`countText`); '' hides it. */
  count: string;
  /** The compact keyboard is open: the caret shows while focus is on its keys. */
  editing: boolean;
  onFocusChanged?: (focused: boolean) => void;
  onOpenKeyboard: () => boolean;
  onDown: () => boolean;
  onLeft: () => boolean;
  /** Return false to let Back bubble to the screen. */
  onBack: () => boolean;
  /** Text typed with the remote's digit keys while the bar has focus. */
  onType: (text: string) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const textW = () => props.width - TEXT_X - COUNT_W - PAD_R * 2;
  const empty = () => props.value === '';
  const shown = () => (empty() ? BAR_PLACEHOLDER : fieldDisplay(props.value, { editing: focused() || props.editing, max: 28 }));
  const digitHandlers = Object.fromEntries(
    Array.from({ length: 10 }, (_, n) => [`onDigit${n}`, () => { props.onType(String(n)); return true; }]),
  );
  return (
    <View ref={props.ref} x={props.x} y={props.y} width={props.width} height={SEARCH_BAR_H}
      borderRadius={SEARCH_BAR_H / 2} color={COLORS.surface}
      border={{ width: 2, color: focused() ? COLORS.focus : 0x00000000 }}
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onEnter={() => props.onOpenKeyboard()} onDown={() => props.onDown()} onLeft={() => props.onLeft()}
      onUp={() => true} onRight={() => true} onBack={() => props.onBack()}
      onLongOk={() => true} onMenu={() => true} {...digitHandlers}>
      {/* Magnifier: a ring and a short handle. */}
      <View x={16} y={8} width={18} height={18} borderRadius={9} border={{ width: 3, color: COLORS.muted }} />
      <View x={30} y={23} width={4} height={10} color={COLORS.muted} rotation={-Math.PI / 4} />
      <Text x={TEXT_X} y={(SEARCH_BAR_H - FONT.body) / 2 - 3} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        fontSize={FONT.body} color={empty() ? COLORS.muted : COLORS.text}>{shown()}</Text>
      <Text x={props.width - COUNT_W - PAD_R} y={(SEARCH_BAR_H - FONT.small) / 2 - 2} width={COUNT_W} maxWidth={COUNT_W}
        contain="width" textAlign="right" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>{props.count}</Text>
    </View>
  );
}
