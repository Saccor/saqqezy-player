import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { moveFocus, scrollTopFor } from './virtualWindow.ts';

const WIDTH = 640;
const ITEM_H = 72;
const STEP = ITEM_H + 12;
const PAD = 32;
const HEAD = 64;
const VIEW_ROWS = 7;
const CHECK_W = 48;

/**
 * "Add to list…" picker over a scrim: the user's lists with a check on those holding the channel, then
 * "New list…". One focusable node; Up/Down choose, Ok picks (`onPick` toggles or creates; the picker stays
 * open). Like the menu, it handles no Back: Home registers it with `router.pushOverlay`.
 */
export function ListPicker(props: {
  ref: (el: ElementNode) => void;
  title: string;
  rows: readonly PickerRow[];
  onPick: (row: PickerRow) => void;
}) {
  const [sel, setSel] = createSignal(0);
  let top = 0;
  const shown = () => Math.min(VIEW_ROWS, Math.max(props.rows.length, 1));
  const height = () => PAD * 2 + HEAD + shown() * STEP + 40;
  // The selection survives row changes (a toggle re-reads the lists), clamped to the new length.
  const current = () => Math.min(sel(), Math.max(0, props.rows.length - 1));
  const scrollTop = createMemo(() => {
    top = scrollTopFor(current(), top, VIEW_ROWS, props.rows.length);
    return top;
  });
  const visible = () => props.rows.slice(scrollTop(), scrollTop() + VIEW_ROWS).map((row, k) => ({ row, i: scrollTop() + k }));
  const move = (d: number) => { setSel(moveFocus(current(), d, props.rows.length)); return true; };
  const more = () => {
    const above = scrollTop() > 0 ? '▲' : '';
    const below = scrollTop() + VIEW_ROWS < props.rows.length ? '▼' : '';
    return [above, below].filter(Boolean).join(' ');
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={60}>
      <View ref={props.ref} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - height()) / 2} width={WIDTH} height={height()}
        color={COLORS.surface} borderRadius={LAYOUT.radius * 2}
        onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => true} onRight={() => true}
        onMenu={() => true} onLongOk={() => true}
        onEnter={() => { const r = props.rows[current()]; if (r) props.onPick(r); return true; }}>
        <Text x={PAD} y={PAD} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width" maxLines={1}
          fontSize={FONT.heading} color={COLORS.text}>{props.title}</Text>
        <For each={visible()}>{(v) => {
          const focused = () => current() === v.i;
          const fg = () => (focused() ? COLORS.onFocus : COLORS.text);
          return (
            <View x={PAD} y={PAD + HEAD + (v.i - scrollTop()) * STEP} width={WIDTH - PAD * 2} height={ITEM_H}
              borderRadius={LAYOUT.radius} color={focused() ? COLORS.focus : COLORS.background}>
              <Text x={24} y={(ITEM_H - FONT.body) / 2 - 4} width={WIDTH - PAD * 2 - 48 - CHECK_W}
                maxWidth={WIDTH - PAD * 2 - 48 - CHECK_W} contain="width" maxLines={1} fontSize={FONT.body}
                color={v.row.kind === 'new' && !focused() ? COLORS.muted : fg()}>{v.row.label}</Text>
              <Show when={v.row.kind === 'list' && v.row.checked}>
                <Text x={WIDTH - PAD * 2 - 24 - CHECK_W + 16} y={(ITEM_H - FONT.body) / 2 - 4} fontSize={FONT.body}
                  color={fg()}>{'✓'}</Text>
              </Show>
            </View>
          );
        }}</For>
        <Text x={PAD} y={PAD + HEAD + shown() * STEP} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width"
          maxLines={1} fontSize={FONT.small} color={COLORS.muted}>
          {more() ? `${more()} · Ok adds or removes · Back closes` : 'Ok adds or removes · Back closes'}
        </Text>
      </View>
    </View>
  );
}
