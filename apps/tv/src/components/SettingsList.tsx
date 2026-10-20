import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import { pointerMode, usePointerFocus, usePointerTarget, type Point } from '../input/pointer.ts';
import { rowHit } from '../input/pointerLogic.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { firstSelectable, renderRange, scrollTopFor, stepSelectable } from './virtualWindow.ts';

export interface SettingItem {
  id: string;
  label: string;
  value?: string;
  /** Muted line under the label. */
  help?: string;
  /** Shows `‹ value ›`: Left/Right change it. */
  adjustable?: boolean;
  /** Drawn muted; the page ignores Ok on it (the help line says why). */
  disabled?: boolean;
  /** A section title: not selectable, Up/Down skip it. */
  heading?: boolean;
}

/** A row's pitch: drawn 72 high with an 8 px gap under it. */
export const SETTING_ROW_H = 80;
const VALUE_W = 380;
/** Pointer: the clickable `‹` and `›` ends of an adjustable row's value column. */
const STEP_HIT_W = 56;
/** The space under each drawn row. */
const ROW_GAP = 8;
const DRAWN_H = SETTING_ROW_H - ROW_GAP;
/** Two-line rows: the label, then the help line under it. */
const LABEL_Y = 10;
const HELP_Y = 42;

/**
 * A settings page's rows: one focusable node (rows only draw), Up/Down move the selection, Ok calls `onOk`,
 * Left/Right call `onAdjust` (an unhandled Left goes back to the menu via `onLeftEdge`). Rendered virtually,
 * so long lists (hidden channels) stay cheap.
 *
 * Pointer: a click selects the row, focuses the list (through the owner, `usePointerFocus`) and does the same as Ok;
 * on an adjustable row the `‹` and `›` ends do Left and Right. Hover highlights the row and shows its stepper; the
 * wheel moves the selection.
 */
export function SettingsList(props: {
  ref?: (el: ElementNode) => void;
  x: number; y: number; width: number; height: number;
  items: SettingItem[];
  selected: number;
  onSelect: (index: number) => void;
  onOk?: (id: string) => void;
  onAdjust?: (id: string, dir: 1 | -1) => boolean;
  onLeftEdge: () => boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  const focusFromPointer = usePointerFocus();
  let node: ElementNode | undefined;
  let lastTop = 0;
  const viewRows = () => Math.max(1, Math.floor(props.height / SETTING_ROW_H));
  const total = () => props.items.length;
  const selectable = (i: number) => props.items[i]?.heading !== true;
  const sel = () => firstSelectable(props.selected, total(), selectable);
  const top = createMemo(() => {
    // A heading right above the selection scrolls into view with it.
    const s = sel();
    const want = s > 0 && !selectable(s - 1) && s - 1 < lastTop ? s - 1 : s;
    lastTop = scrollTopFor(want, lastTop, viewRows(), total());
    return lastTop;
  });
  const indices = createMemo(() => {
    const r = renderRange(top(), viewRows(), total());
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const move = (d: 1 | -1) => {
    const next = stepSelectable(sel(), d, total(), selectable);
    if (next !== sel()) props.onSelect(next);
    return true;
  };
  const current = () => props.items[sel()];
  const adjust = (dir: 1 | -1) => {
    const it = current();
    if (it && props.onAdjust?.(it.id, dir)) return true;
    return dir === -1 ? props.onLeftEdge() : true;
  };

  const indexAt = (p: Point) => {
    // Rows are drawn `SETTING_ROW_H - ROW_GAP` high: the gap under a row is not part of it.
    const i = rowHit(p.y, top(), SETTING_ROW_H, ROW_GAP, total());
    return i !== undefined && selectable(i) ? i : undefined;
  };
  /** -1 or +1 on an adjustable row's `‹` / `›` end, else 0. */
  const stepAt = (p: Point, i: number): -1 | 0 | 1 => {
    if (props.items[i]?.adjustable !== true) return 0;
    const left = props.width - VALUE_W - 28;
    if (p.x >= left && p.x < left + STEP_HIT_W) return -1;
    if (p.x >= props.width - 28 - STEP_HIT_W && p.x < props.width) return 1;
    return 0;
  };
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? indexAt(p) : undefined),
    onClick: (p) => {
      const i = indexAt(p);
      const it = i === undefined ? undefined : props.items[i];
      if (i === undefined || !it) return;
      if (i !== sel()) props.onSelect(i);
      focusFromPointer(node);
      const step = stepAt(p, i);
      if (step !== 0) props.onAdjust?.(it.id, step);
      else props.onOk?.(it.id);
    },
    onWheel: (dy) => {
      if (dy !== 0) move(dy > 0 ? 1 : -1);
      return true;
    },
  });

  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={setFocused} onUp={() => move(-1)} onDown={() => move(1)}
      onLeft={() => adjust(-1)} onRight={() => adjust(1)}
      onEnter={() => { const it = current(); if (it) props.onOk?.(it.id); return true; }}>
      <For each={indices()}>{(i) => {
        const it = () => props.items[i];
        const isSel = () => i === sel();
        const active = () => isSel() && focused();
        const hovered = () => pointerMode() && hover() === i;
        const stepper = () => it()?.adjustable === true && (active() || hovered());
        const valueY = (DRAWN_H - TYPE.body) / 2 - 4;
        // Rows are reused across item changes (keyed by index), so the heading style is reactive too.
        const heading = () => it()?.heading === true;
        const labelW = () => (heading() ? props.width - 56 : props.width - VALUE_W - 56);
        const dim = () => it()?.disabled === true;
        return (
          <View x={0} y={(i - top()) * SETTING_ROW_H} width={props.width} height={DRAWN_H}
            borderRadius={LAYOUT.radius}
            color={active() ? COLORS.focus : isSel() ? COLORS.surface : hovered() ? COLORS.hover : COLORS.transparent}>
            <Text x={28} y={heading() ? DRAWN_H - TYPE.meta - 10 : it()?.help ? LABEL_Y : valueY}
              width={labelW()} maxWidth={labelW()} contain="width" maxLines={1}
              fontSize={heading() ? TYPE.meta : TYPE.body} fontStyle={heading() ? STRONG.fontStyle : 'normal'}
              color={heading() ? COLORS.muted : dim() ? (active() ? COLORS.onFocusMuted : COLORS.muted) : active() ? COLORS.onFocus : COLORS.text}>{it()?.label ?? ''}</Text>
            <Show when={!heading() && it()?.help}>
              <Text x={28} y={HELP_Y} width={props.width - VALUE_W - 56} maxWidth={props.width - VALUE_W - 56} contain="width"
                maxLines={1} fontSize={TYPE.meta} color={active() ? COLORS.onFocusMuted : COLORS.muted}>{it()?.help ?? ''}</Text>
            </Show>
            {/* Focused (or, in pointer mode, hovered) adjustable row: a stepper (‹ value ›); otherwise the value right-aligned. */}
            <Show when={stepper()}>
              <Text x={props.width - VALUE_W - 28} y={valueY} fontSize={TYPE.body} color={active() ? COLORS.onFocusMuted : COLORS.muted}>{'‹'}</Text>
              <Text x={props.width - 28 - 14} y={valueY} fontSize={TYPE.body} color={active() ? COLORS.onFocusMuted : COLORS.muted}>{'›'}</Text>
            </Show>
            <Text x={props.width - VALUE_W - 28 + (stepper() ? 28 : 0)} y={valueY} width={VALUE_W - (stepper() ? 56 : 0)}
              maxWidth={VALUE_W - (stepper() ? 56 : 0)} contain="width" textAlign={stepper() ? 'center' : 'right'}
              maxLines={1} fontSize={TYPE.body} color={active() && !dim() ? COLORS.onFocus : active() ? COLORS.onFocusMuted : COLORS.muted}>{it()?.value ?? ''}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}
