import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { captureTextInput } from '../input/keys.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { fieldDisplay } from './TextField.tsx';
import {
  KEYBOARD_ROWS, START_CURSOR, applyKey, keyLabel, moveCursor, textEntryKey, type Cursor, type Direction, type KeyDef,
} from './keyboardLogic.ts';

export const KEYBOARD_W = 792;
export const KEYBOARD_H = 820;
const PAD = 36;
const UNIT = 72;
const KEY_H = 64;
const ROW_STEP = 76;
const KEYS_Y = 176;
const KEY_FILL = 0x1a1f2bff;

/**
 * On-screen keyboard panel (QWERTY, digits, URL symbols, shortcuts, Shift/Space/⌫/Done). It edits through
 * `onChange` and closes through `onDone`. It does not handle Back: the owner registers it with
 * `router.pushOverlay`, so Back closes it like any other layer and the text is kept.
 *
 * While it is mounted, physical keyboard typing goes into the field (`captureTextInput`), and remote digit
 * keys type digits.
 */
export function Keyboard(props: {
  ref?: (el: ElementNode) => void;
  x: number;
  y: number;
  label: string;
  value: string;
  secret?: boolean;
  revealed?: boolean;
  onChange: (value: string) => void;
  onDone: () => void;
  onToggleReveal?: () => void;
  /** Called when Right is pressed on the rightmost key (inline use: move focus to a neighbouring list). */
  onEdgeRight?: () => void;
  /** Replaces the default footer hint. */
  hint?: string;
}) {
  const [cursor, setCursor] = createSignal<Cursor>(START_CURSOR);
  const [shift, setShift] = createSignal(false);

  const press = (def: KeyDef) => {
    const next = applyKey({ value: props.value, shift: shift() }, def);
    setShift(next.shift);
    if (next.value !== props.value) props.onChange(next.value);
    if (next.done) props.onDone();
  };
  const move = (dir: Direction) => { setCursor((c) => moveCursor(c, dir)); return true; };
  const typeChar = (ch: string) => press({ kind: 'char', ch });

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
    <View ref={props.ref} x={props.x} y={props.y} width={KEYBOARD_W} height={KEYBOARD_H} zIndex={30}
      color={COLORS.surface} borderRadius={LAYOUT.radius * 2} border={{ width: 2, color: COLORS.muted }}
      onUp={() => move('up')} onDown={() => move('down')} onLeft={() => move('left')} onRight={() => {
        const c = cursor();
        const n = moveCursor(c, 'right');
        if (props.onEdgeRight && n.row === c.row && n.col === c.col) { props.onEdgeRight(); return true; }
        return move('right');
      }}
      onEnter={() => {
        const c = cursor();
        const cell = KEYBOARD_ROWS[c.row]?.[c.col];
        if (cell) press(cell.def);
        return true;
      }}
      onYellow={() => { props.onToggleReveal?.(); return true; }}
      {...digitHandlers}>
      <Text x={PAD} y={28} fontSize={FONT.small} color={COLORS.muted}>{props.label}</Text>
      <View x={PAD} y={64} width={KEYBOARD_W - PAD * 2} height={80} color={COLORS.background} borderRadius={LAYOUT.radius}>
        <Text x={20} y={22} width={KEYBOARD_W - PAD * 2 - 40} maxWidth={KEYBOARD_W - PAD * 2 - 40} contain="width" maxLines={1}
          fontSize={30} color={COLORS.text}>{shown()}</Text>
      </View>
      <For each={KEYBOARD_ROWS}>{(row, r) => (
        <For each={row}>{(cell, c) => {
          const focused = () => cursor().row === r() && cursor().col === c();
          const w = cell.w * UNIT - 8;
          const isShift = cell.def.kind === 'shift';
          return (
            <View x={PAD + cell.x * UNIT} y={KEYS_Y + r() * ROW_STEP} width={w} height={KEY_H} borderRadius={8}
              color={focused() ? COLORS.focus : KEY_FILL}
              border={{ width: 2, color: isShift && shift() ? COLORS.focus : 0x00000000 }}>
              <Text y={(KEY_H - FONT.body) / 2 - 3} width={w} maxWidth={w} contain="width" textAlign="center"
                fontSize={FONT.body} color={focused() ? COLORS.onFocus : COLORS.text}>{keyLabel(cell.def, shift())}</Text>
            </View>
          );
        }}</For>
      )}</For>
      <Text x={PAD} y={KEYBOARD_H - 56} width={KEYBOARD_W - PAD * 2} maxWidth={KEYBOARD_W - PAD * 2} contain="width"
        fontSize={FONT.small} color={COLORS.muted}>{hint()}</Text>
    </View>
  );
}
