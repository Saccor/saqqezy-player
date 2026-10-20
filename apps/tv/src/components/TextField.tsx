import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { maskSecret } from '../screens/addSourceLogic.ts';
import { COLORS, LAYOUT, TYPE } from '../shell/theme.ts';
import { visibleTail } from './keyboardLogic.ts';

export const FIELD_H = 100;
/** Characters that fit on one line at the value font size, at the field widths used. */
const CHARS_PER_PX = 1 / 16;

/**
 * Text that a field shows. A secret is masked (••••) unless `revealed`; the real value is never handed to a
 * Text node otherwise.
 */
export function fieldDisplay(value: string, opts: { secret?: boolean; revealed?: boolean; editing?: boolean; max: number }): string {
  const shown = opts.secret && !opts.revealed ? maskSecret(value) : value;
  return visibleTail(shown, opts.editing ? opts.max - 1 : opts.max) + (opts.editing ? '▏' : '');
}

/**
 * A labelled single-line field. It does no editing itself: Ok calls `onEnter`, which opens the on-screen
 * keyboard; `editing` shows the caret while it is open. A pointer click does the same as Ok; hover shows a muted ring.
 */
export function TextField(props: {
  ref?: (el: ElementNode) => void;
  x?: number;
  y?: number;
  width: number;
  label: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  revealed?: boolean;
  editing?: boolean;
  /** Small right-aligned hint shown while focused (e.g. "Yellow: show"). */
  hint?: string;
  /** Px kept free at the right end for a control drawn over the field (Add source's pointer `Show password`). */
  endInset?: number;
  /** The value is drawn in the dim text colour (a setting this device cannot use); focus and editing are unchanged. */
  dimmed?: boolean;
  /** Small right-aligned note on the label line, always shown (e.g. "Not used on this TV"); a focused `hint` wins. */
  note?: string;
  onEnter: () => void;
  onUp?: () => boolean | void;
  onDown?: () => boolean | void;
  onYellow?: () => boolean | void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({ node: () => node, onHover: (p) => setHovered(p !== undefined), onClick: () => props.onEnter() });
  /** The value's width: the newest characters and the caret stay clear of an end control. */
  const textW = () => props.width - 48 - (props.endInset ?? 0);
  const max = () => Math.floor(textW() * CHARS_PER_PX);
  const empty = () => props.value === '';
  const text = () => (empty() && !props.editing
    ? (props.placeholder ?? '—')
    : fieldDisplay(props.value, { secret: props.secret, revealed: props.revealed, editing: props.editing, max: max() }));
  const active = () => focused() || props.editing === true;
  const fill = () => (active() ? COLORS.focus : hovered() && pointerMode() ? COLORS.hover : COLORS.surface);

  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x ?? 0} y={props.y ?? 0} width={props.width} height={FIELD_H}
      borderRadius={LAYOUT.radius} color={fill()}
      onFocusChanged={setFocused}
      onEnter={() => { props.onEnter(); return true; }}
      onUp={() => props.onUp?.() ?? false} onDown={() => props.onDown?.() ?? false}
      onYellow={() => props.onYellow?.() ?? false}>
      <Text x={24} y={14} fontSize={TYPE.meta} color={active() ? COLORS.onFocusMuted : COLORS.muted}>{props.label}</Text>
      <Text x={24} y={50} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
        fontSize={TYPE.body}
        color={(empty() && !props.editing) || props.dimmed ? (active() ? COLORS.onFocusMuted : COLORS.muted) : active() ? COLORS.onFocus : COLORS.text}>{text()}</Text>
      {(props.hint && focused()) || props.note
        ? <Text x={props.width - 324} y={14} width={300} maxWidth={300} contain="width" textAlign="right"
          fontSize={TYPE.meta} color={active() ? COLORS.onFocusMuted : COLORS.muted}>{props.hint && focused() ? props.hint : props.note ?? ''}</Text>
        : null}
    </View>
  );
}
