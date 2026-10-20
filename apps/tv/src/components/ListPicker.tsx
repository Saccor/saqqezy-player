import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import { pointerMode, usePointerBackdrop, usePointerTarget, type Point } from '../input/pointer.ts';
import { panelRowHit } from '../input/pointerLogic.ts';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { moveFocus, scrollTopFor } from './virtualWindow.ts';

const WIDTH = 640;
const ITEM_H = 72;
const STEP = ITEM_H + 12;
const PAD = 32;
const HEAD = 64;
const VIEW_ROWS = 7;
const CHECK_W = 48;
const HELP_LINE_GAP = 8;

/**
 * "Add to list…" picker over a scrim: the user's lists with a check on those holding the channel, then
 * "New list…". One focusable node; Up/Down choose, Ok picks (`onPick` toggles or creates; the picker stays
 * open). Like the menu, it handles no Back: Live TV registers it with `router.pushOverlay`.
 *
 * Pointer: a click on a row picks it, hover highlights it, the wheel moves the selection, and a click outside the
 * panel is Back.
 */
export function ListPicker(props: {
  ref: (el: ElementNode) => void;
  title: string;
  rows: readonly PickerRow[];
  onPick: (row: PickerRow) => void;
  /** Footer hint; default "Ok adds or removes · Back closes". */
  hint?: string;
  /** False: neither the panel nor the backdrop takes the pointer (the rename keyboard is open above). Default true. */
  pointerEnabled?: boolean;
  /** Left (-1) / Right (1) on the selected row (e.g. a delay); true when it handled them. Default: ignored. */
  onAdjust?: (row: PickerRow, dir: 1 | -1) => boolean;
}) {
  const [sel, setSel] = createSignal(0);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let scrim: ElementNode | undefined;
  let panel: ElementNode | undefined;
  let top = 0;
  const shown = () => Math.min(VIEW_ROWS, Math.max(props.rows.length, 1));
  /** A row with help (a long release name, a how-to) gets a two-line footer. */
  const helpLines = () => (props.rows.some((r) => r.kind === 'list' && r.help) ? 2 : 1);
  const height = () => PAD * 2 + HEAD + shown() * STEP + 40 + (helpLines() - 1) * (TYPE.meta + HELP_LINE_GAP);
  // The selection survives row changes (a toggle re-reads the lists), clamped to the new length.
  const current = () => Math.min(sel(), Math.max(0, props.rows.length - 1));
  const scrollTop = createMemo(() => {
    top = scrollTopFor(current(), top, VIEW_ROWS, props.rows.length);
    return top;
  });
  const visible = () => props.rows.slice(scrollTop(), scrollTop() + VIEW_ROWS).map((row, k) => ({ row, i: scrollTop() + k }));
  /** The selected row's help when it has one, else the picker's hint. */
  const hint = () => {
    const r = props.rows[current()];
    return (r?.kind === 'list' ? r.help : undefined) ?? props.hint ?? 'Ok adds or removes · Back closes';
  };
  const move = (d: number) => { setSel(moveFocus(current(), d, props.rows.length)); return true; };
  const adjust = (dir: 1 | -1) => {
    const r = props.rows[current()];
    if (r) props.onAdjust?.(r, dir);
    return true;
  };
  const more = () => {
    const above = scrollTop() > 0 ? '▲' : '';
    const below = scrollTop() + VIEW_ROWS < props.rows.length ? '▼' : '';
    return [above, below].filter(Boolean).join(' ');
  };
  /** Only the drawn rows: the slice from `scrollTop`. */
  const indexAt = (p: Point) => {
    const k = panelRowHit(p, WIDTH, PAD, PAD + HEAD, STEP, STEP - ITEM_H, Math.min(VIEW_ROWS, props.rows.length - scrollTop()));
    return k === undefined ? undefined : scrollTop() + k;
  };
  // Backdrop first, then the panel: the panel wins where they overlap.
  const enabled = () => props.pointerEnabled !== false;
  usePointerBackdrop(() => scrim, undefined, false, enabled);
  usePointerTarget({
    node: () => panel,
    layer: 'overlay',
    enabled,
    subAt: (p) => indexAt(p),
    onHover: (p) => setHover(p ? indexAt(p) : undefined),
    onClick: (p) => {
      const i = indexAt(p);
      const r = i === undefined ? undefined : props.rows[i];
      if (i === undefined || !r) return;
      setSel(i);
      props.onPick(r);
    },
    onWheel: (dy) => {
      if (dy !== 0) move(dy);
      return true;
    },
  });

  return (
    <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={60}>
      <View ref={(el) => { panel = el; props.ref(el); }} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - height()) / 2}
        width={WIDTH} height={height()} color={COLORS.surface} borderRadius={LAYOUT.radius * 2}
        onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => adjust(-1)} onRight={() => adjust(1)}
        onMenu={() => true} onLongOk={() => true}
        onEnter={() => { const r = props.rows[current()]; if (r) props.onPick(r); return true; }}>
        <Text x={PAD} y={PAD} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width" maxLines={1}
          fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.title}</Text>
        <For each={visible()}>{(v) => {
          const focused = () => current() === v.i;
          const hovered = () => pointerMode() && hover() === v.i;
          const fg = () => (focused() ? COLORS.onFocus : COLORS.text);
          return (
            <View x={PAD} y={PAD + HEAD + (v.i - scrollTop()) * STEP} width={WIDTH - PAD * 2} height={ITEM_H}
              borderRadius={LAYOUT.radius} color={focused() ? COLORS.focus : hovered() ? COLORS.hover : COLORS.background}>
              <Text x={24} y={(ITEM_H - TYPE.body) / 2 - 4} width={WIDTH - PAD * 2 - 48 - CHECK_W}
                maxWidth={WIDTH - PAD * 2 - 48 - CHECK_W} contain="width" maxLines={1} fontSize={TYPE.body}
                color={v.row.kind === 'new' && !focused() ? COLORS.muted : fg()}>{v.row.label}</Text>
              <Show when={v.row.kind === 'list' && v.row.checked}>
                <Text x={WIDTH - PAD * 2 - 24 - CHECK_W + 16} y={(ITEM_H - TYPE.body) / 2 - 4} fontSize={TYPE.body}
                  color={fg()}>{'✓'}</Text>
              </Show>
            </View>
          );
        }}</For>
        <Text x={PAD} y={PAD + HEAD + shown() * STEP} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width"
          maxLines={helpLines()} fontSize={TYPE.meta} color={COLORS.muted}>
          {more() ? `${more()} · ${hint()}` : hint()}
        </Text>
      </View>
    </View>
  );
}
