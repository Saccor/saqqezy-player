import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { captureTextInput } from '../input/keys.ts';
import { pointerMode, usePointerFocus, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { fieldDisplay } from './TextField.tsx';
import {
  FULL_LAYOUT, applyKey, keyAt, keyLabel, moveCursor, textEntryKey, type Cursor, type Direction, type KeyDef, type KeyboardLayout,
} from './keyboardLogic.ts';

export const KEYBOARD_W = FULL_LAYOUT.width;
export const KEYBOARD_H = FULL_LAYOUT.height;
const KEY_FILL = 0x1a1f2bff;

/**
 * On-screen keyboard panel. The default layout has QWERTY, digits, URL symbols, shortcuts and Shift/Space/⌫/Done,
 * with a label, the value field and a footer hint. `COMPACT_LAYOUT` (Home's search bar) draws its keys only. It
 * edits through `onChange` and closes through `onDone`. It does not handle Back: the owner registers it with
 * `router.pushOverlay`, so Back closes it like any other layer and the text is kept.
 *
 * While it is mounted, physical keyboard typing goes into the field (`captureTextInput`), and remote digit
 * keys type digits.
 *
 * Pointer: a screen-layer target, so clicks outside it still reach the screen (inline keyboards sit beside lists). A click on a key moves the cursor there and presses it, after focusing the keyboard
 * through the owner (`usePointerFocus`); hover highlights the key. Clicks outside reach the screen (no backdrop, not modal).
 */
export function Keyboard(props: {
  ref?: (el: ElementNode) => void;
  x: number;
  y: number;
  label: string;
  value: string;
  secret?: boolean;
  revealed?: boolean;
  /** Keys and sizes, fixed for the keyboard's lifetime. Default: `FULL_LAYOUT`. */
  layout?: KeyboardLayout;
  onChange: (value: string) => void;
  onDone: () => void;
  onToggleReveal?: () => void;
  /** Called when Right is pressed on the rightmost key (inline use: move focus to a neighbouring list). */
  onEdgeRight?: () => void;
  /** Called when Up is pressed on the top row (inline use: move focus to a field above). */
  onEdgeUp?: () => void;
  /** Replaces the default footer hint. */
  hint?: string;
  /** A validation message shown in the footer instead of the hint (the owner clears it on the next edit). */
  error?: string;
}) {
  const L = props.layout ?? FULL_LAYOUT;
  const [cursor, setCursor] = createSignal<Cursor>(L.start);
  const [shift, setShift] = createSignal(false);
  const [hoverKey, setHoverKey] = createSignal<Cursor | undefined>(undefined);
  const focusFromPointer = usePointerFocus();
  let root: ElementNode | undefined;

  const press = (def: KeyDef) => {
    const next = applyKey({ value: props.value, shift: shift() }, def);
    setShift(next.shift);
    if (next.value !== props.value) props.onChange(next.value);
    if (next.done) props.onDone();
  };
  const move = (dir: Direction) => { setCursor((c) => moveCursor(c, dir, L.rows)); return true; };
  /** Moves the cursor, or calls `edge` when it cannot move that way. */
  const moveOrEdge = (dir: Direction, edge: (() => void) | undefined) => {
    const c = cursor();
    const n = moveCursor(c, dir, L.rows);
    if (edge && n.row === c.row && n.col === c.col) { edge(); return true; }
    return move(dir);
  };
  const typeChar = (ch: string) => press({ kind: 'char', ch });

  usePointerTarget({
    node: () => root,
    onHover: (p) => setHoverKey(p ? keyAt(p.x, p.y, L) : undefined),
    subAt: (p) => { const k = keyAt(p.x, p.y, L); return k ? k.row * 1000 + k.col : undefined; },
    onClick: (p) => {
      const c = keyAt(p.x, p.y, L);
      const cell = c ? L.rows[c.row]?.[c.col] : undefined;
      if (!c || !cell) return;
      focusFromPointer(root);
      setCursor(c);
      press(cell.def);
    },
  });

  onMount(() => {
    const release = captureTextInput((e) => {
      const k = textEntryKey(e);
      if (!k) return false;
      // Physical keys already carry their case: bypass Shift by writing the character as text.
      if (k.kind === 'char') press({ kind: 'text', text: k.ch });
      else press({ kind: 'backspace' });
      return true;
    });
    onCleanup(release);
  });

  const digitHandlers = Object.fromEntries(
    Array.from({ length: 10 }, (_, n) => [`onDigit${n}`, () => { typeChar(String(n)); return true; }]),
  );

  const shown = () => fieldDisplay(props.value, { secret: props.secret, revealed: props.revealed, editing: true, max: 36 });
  const hint = () => props.hint ?? (props.secret
    ? `Back closes and keeps the text · Yellow: ${props.revealed ? 'hide' : 'show'} password`
    : 'Back closes and keeps the text');

  return (
    <View ref={(el) => { root = el; props.ref?.(el); }} x={props.x} y={props.y} width={L.width} height={L.height} zIndex={30}
      color={COLORS.surface} borderRadius={LAYOUT.radius * 2} border={{ width: 2, color: COLORS.muted }}
      onUp={() => moveOrEdge('up', props.onEdgeUp)} onDown={() => move('down')} onLeft={() => move('left')}
      onRight={() => moveOrEdge('right', props.onEdgeRight)}
      onEnter={() => {
        const c = cursor();
        const cell = L.rows[c.row]?.[c.col];
        if (cell) press(cell.def);
        return true;
      }}
      onYellow={() => { props.onToggleReveal?.(); return true; }}
      {...digitHandlers}>
      <Show when={L.chrome}>
        <Text x={L.pad} y={28} fontSize={FONT.small} color={COLORS.muted}>{props.label}</Text>
        <View x={L.pad} y={64} width={L.width - L.pad * 2} height={80} color={COLORS.background} borderRadius={LAYOUT.radius}>
          <Text x={20} y={22} width={L.width - L.pad * 2 - 40} maxWidth={L.width - L.pad * 2 - 40} contain="width" maxLines={1}
            fontSize={30} color={COLORS.text}>{shown()}</Text>
        </View>
      </Show>
      <For each={L.rows}>{(row, r) => (
        <For each={row}>{(cell, c) => {
          const focused = () => cursor().row === r() && cursor().col === c();
          const hovered = () => pointerMode() && hoverKey()?.row === r() && hoverKey()?.col === c();
          const w = cell.w * L.unit - L.keyGap;
          const isShift = cell.def.kind === 'shift';
          return (
            <View x={L.pad + cell.x * L.unit} y={L.keysY + r() * L.rowStep} width={w} height={L.keyH} borderRadius={8}
              color={focused() ? COLORS.focus : hovered() ? COLORS.hover : KEY_FILL}
              border={{ width: 2, color: isShift && shift() ? COLORS.focus : 0x00000000 }}>
              <Text y={(L.keyH - FONT.body) / 2 - 3} width={w} maxWidth={w} contain="width" textAlign="center"
                fontSize={FONT.body} color={focused() ? COLORS.onFocus : COLORS.text}>{keyLabel(cell.def, shift())}</Text>
            </View>
          );
        }}</For>
      )}</For>
      <Show when={L.chrome}>
        <Text x={L.pad} y={L.height - 56} width={L.width - L.pad * 2} maxWidth={L.width - L.pad * 2} contain="width"
          fontSize={FONT.small} color={props.error ? COLORS.error : COLORS.muted}>{props.error ?? hint()}</Text>
      </Show>
    </View>
  );
}
