// apps/tv/src/components/SearchBar.tsx
import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { BAR_PLACEHOLDER, KEYBOARD_BUTTON_LABEL } from '../screens/homeSearchLogic.ts';
import { COLORS, FONT } from '../shell/theme.ts';
import { fieldDisplay } from './TextField.tsx';

/** Short enough to leave a clear gap under the brand wordmark (Home's header row). */
export const SEARCH_BAR_H = 34;
const TEXT_X = 52;
const COUNT_W = 200;
const PAD_R = 16;
/** The pointer-mode `⌨` button at the right end of the bar. */
const KB_BTN_W = 56;
const KB_BTN_PAD = 4;

/**
 * Home's search field in the list header row: one focusable node, and the whole field is its click target. It
 * does no editing itself. Home types into it (hardware keys, remote digits, the compact keyboard) through `value`.
 * Ok opens the compact keyboard.
 *
 * Pointer: a click focuses the bar without opening the keyboard (a physical keyboard is assumed). With
 * `onKeyboardButton`, a `⌨` button at the right end opens it, and the result count moves left to make room.
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
  /** Up (Home: stays on the bar). Default: swallowed. */
  onUp?: () => boolean;
  onLeft: () => boolean;
  /** Return false to let Back bubble to the screen. */
  onBack: () => boolean;
  /** Text typed with the remote's digit keys while the bar has focus. */
  onType: (text: string) => void;
  /** Pointer click on the field. */
  onClick?: () => void;
  /** Pointer click on the `⌨` button. */
  onKeyboardButton?: () => void;
  /** False: the pointer passes over the bar (a keyboard is open above it). Default true. */
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [kbHot, setKbHot] = createSignal(false);
  let node: ElementNode | undefined;
  const textW = () => props.width - TEXT_X - COUNT_W - PAD_R * 2;
  const empty = () => props.value === '';
  const shown = () => (empty() ? BAR_PLACEHOLDER : fieldDisplay(props.value, { editing: focused() || props.editing, max: 28 }));
  const kbShown = () => pointerMode() && props.onKeyboardButton !== undefined;
  const onKbButton = (p: Point) => kbShown() && p.x >= props.width - KB_BTN_W - KB_BTN_PAD;
  const countX = () => props.width - COUNT_W - PAD_R - (kbShown() ? KB_BTN_W + KB_BTN_PAD : 0);
  const digitHandlers = Object.fromEntries(
    Array.from({ length: 10 }, (_, n) => [`onDigit${n}`, () => { props.onType(String(n)); return true; }]),
  );
  usePointerTarget({
    node: () => node,
    enabled: () => props.pointerEnabled !== false,
    onHover: (p) => setKbHot(p !== undefined && onKbButton(p)),
    onClick: (p) => {
      if (onKbButton(p)) props.onKeyboardButton?.();
      else props.onClick?.();
    },
  });
  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={props.x} y={props.y} width={props.width} height={SEARCH_BAR_H}
      borderRadius={SEARCH_BAR_H / 2} color={COLORS.surface}
      border={{ width: 2, color: focused() ? COLORS.focus : 0x00000000 }}
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onEnter={() => props.onOpenKeyboard()} onDown={() => props.onDown()} onLeft={() => props.onLeft()}
      onUp={() => props.onUp?.() ?? true} onRight={() => true} onBack={() => props.onBack()}
      onLongOk={() => true} onMenu={() => true} {...digitHandlers}>
      {/* Magnifier: a ring and a short handle. */}
      <View x={16} y={SEARCH_BAR_H / 2 - 12} width={18} height={18} borderRadius={9} border={{ width: 3, color: COLORS.muted }} />
      <View x={30} y={SEARCH_BAR_H / 2 + 3} width={4} height={10} color={COLORS.muted} rotation={-Math.PI / 4} />
      <Text x={TEXT_X} y={(SEARCH_BAR_H - FONT.body) / 2 - 3} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        fontSize={FONT.body} color={empty() ? COLORS.muted : COLORS.text}>{shown()}</Text>
      <Text x={countX()} y={(SEARCH_BAR_H - FONT.small) / 2 - 2} width={COUNT_W} maxWidth={COUNT_W}
        contain="width" textAlign="right" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>{props.count}</Text>
      <Show when={kbShown()}>
        <View x={props.width - KB_BTN_W - KB_BTN_PAD} y={KB_BTN_PAD} width={KB_BTN_W} height={SEARCH_BAR_H - KB_BTN_PAD * 2}
          borderRadius={(SEARCH_BAR_H - KB_BTN_PAD * 2) / 2} color={kbHot() ? COLORS.focus : COLORS.background}>
          <Text y={(SEARCH_BAR_H - KB_BTN_PAD * 2 - FONT.small) / 2 - 2} width={KB_BTN_W} maxWidth={KB_BTN_W} contain="width"
            textAlign="center" fontSize={FONT.small} color={kbHot() ? COLORS.onFocus : COLORS.text}>{KEYBOARD_BUTTON_LABEL}</Text>
        </View>
      </Show>
    </View>
  );
}
