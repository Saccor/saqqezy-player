import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import { pointerMode, usePointerBackdrop, usePointerTarget, type Point } from '../input/pointer.ts';
import { panelRowHit } from '../input/pointerLogic.ts';
import type { PickerIcon, PickerRow } from '../screens/homeMenuLogic.ts';
import { scrimIn } from '../shell/motion.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { pickerFooter, pickerSelectable } from './listPickerLogic.ts';
import { firstSelectable, scrollTopFor, stepSelectable } from './virtualWindow.ts';

const WIDTH = 640;
const ITEM_H = 72;
const STEP = ITEM_H + 12;
const PAD = 32;
const HEAD = 64;
const VIEW_ROWS = 7;
const CHECK_W = 48;
/** One footer line: meta text and a small gap. */
const FOOTER_LINE_H = TYPE.meta + 8;
/** A row's flag (4:3) or text badge, left of its label. */
const ICON_W = 48;
const ICON_H = 36;
const ICON_GAP = 16;
/** The "›" of a row that opens another level. */
const MORE_W = 36;

function RowIcon(p: { icon: PickerIcon; fg: number }) {
  return (
    <Show when={p.icon.src} fallback={
      <View x={24} y={(ITEM_H - ICON_H) / 2} width={ICON_W} height={ICON_H} borderRadius={6} color={COLORS.badge}>
        <Text y={(ICON_H - TYPE.meta) / 2 - 3} width={ICON_W} maxWidth={ICON_W} contain="width" textAlign="center" fontSize={TYPE.meta}
          {...STRONG} color={p.fg}>{p.icon.badge ?? ''}</Text>
      </View>
    }>{(src) => <View x={24} y={(ITEM_H - ICON_H) / 2} width={ICON_W} height={ICON_H} src={src()} />}</Show>
  );
}

/**
 * A list picker over a scrim ("Add to list…", Groups, categories, versions): one focusable node; Up/Down choose (headings
 * are skipped), Ok picks (`onPick`; the picker stays open). It handles no Back: the screen registers it with
 * `router.pushOverlay`. Rows may carry a flag or badge and a "›" (another level); `initial` + `resetKey` set the
 * selection when a level opens.
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
  /** The row selected when the picker opens, and again whenever `resetKey` changes (a level of a two-level list). */
  initial?: number;
  resetKey?: string;
}) {
  const [sel, setSel] = createSignal(props.initial ?? 0);
  createEffect(on(() => props.resetKey, () => setSel(props.initial ?? 0), { defer: true }));
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let scrim: ElementNode | undefined;
  let lift: ElementNode | undefined;
  let panel: ElementNode | undefined;
  let top = 0;
  const selectable = (i: number) => pickerSelectable(props.rows[i]);
  const shown = () => Math.min(VIEW_ROWS, Math.max(props.rows.length, 1));
  /** A row with help (a long release name, a how-to) adds a footer line above the hint. */
  const footer = () => pickerFooter(props.rows, current(), props.hint, more());
  const height = () => PAD * 2 + HEAD + shown() * STEP + 40 + (footer().length - 1) * FOOTER_LINE_H;
  // The selection survives row changes (a toggle re-reads the lists), clamped to the new length and off headings.
  const current = () => firstSelectable(Math.min(sel(), Math.max(0, props.rows.length - 1)), props.rows.length, selectable);
  const scrollTop = createMemo(() => {
    top = scrollTopFor(current(), top, VIEW_ROWS, props.rows.length);
    return top;
  });
  const visible = () => props.rows.slice(scrollTop(), scrollTop() + VIEW_ROWS).map((row, k) => ({ row, i: scrollTop() + k }));
  const move = (d: number) => {
    if (d !== 0) setSel(stepSelectable(current(), d > 0 ? 1 : -1, props.rows.length, selectable));
    return true;
  };
  const adjust = (dir: 1 | -1) => {
    const r = props.rows[current()];
    if (r && selectable(current())) props.onAdjust?.(r, dir);
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
    onHover: (p) => {
      const i = p ? indexAt(p) : undefined;
      setHover(i !== undefined && selectable(i) ? i : undefined);
    },
    onClick: (p) => {
      const i = indexAt(p);
      const r = i === undefined ? undefined : props.rows[i];
      if (i === undefined || !r || !selectable(i)) return;
      setSel(i);
      props.onPick(r);
    },
    onWheel: (dy) => {
      if (dy !== 0) move(dy);
      return true;
    },
  });

  return (
    <View ref={(el) => { scrim = el; scrimIn(el, () => lift); }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={60}>
      {/* The panel rises inside `lift`; the scrim only fades (scrimIn). */}
      <View ref={(el) => { lift = el; }}>
        <View ref={(el) => { panel = el; props.ref(el); }} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - height()) / 2}
          width={WIDTH} height={height()} color={COLORS.surface} borderRadius={LAYOUT.radius * 2}
          onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => adjust(-1)} onRight={() => adjust(1)}
          onMenu={() => true} onLongOk={() => true}
          onEnter={() => { const r = props.rows[current()]; if (r && selectable(current())) props.onPick(r); return true; }}>
          <Text x={PAD} y={PAD} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width" maxLines={1}
            fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.title}</Text>
          <For each={visible()}>{(v) => {
            const y = () => PAD + HEAD + (v.i - scrollTop()) * STEP;
            const focused = () => current() === v.i;
            const hovered = () => pointerMode() && hover() === v.i;
            const fg = () => (focused() ? COLORS.onFocus : COLORS.text);
            const list = () => (v.row.kind === 'list' ? v.row : undefined);
            const textX = () => (list()?.icon ? 24 + ICON_W + ICON_GAP : 24);
            const textW = () => WIDTH - PAD * 2 - textX() - 24 - CHECK_W - (list()?.more ? MORE_W : 0);
            return (
              <Show when={v.row.kind !== 'heading'} fallback={
                <Text x={PAD + 24} y={y() + ITEM_H - TYPE.meta - 14} width={WIDTH - PAD * 2 - 48} maxWidth={WIDTH - PAD * 2 - 48}
                  contain="width" maxLines={1} fontSize={TYPE.meta} {...STRONG} color={COLORS.muted}>{v.row.label}</Text>
              }>
                <View x={PAD} y={y()} width={WIDTH - PAD * 2} height={ITEM_H} borderRadius={LAYOUT.radius}
                  color={focused() ? COLORS.focus : hovered() ? COLORS.hover : COLORS.background}>
                  <Show when={list()?.icon}>{(icon) => <RowIcon icon={icon()} fg={fg()} />}</Show>
                  <Text x={textX()} y={(ITEM_H - TYPE.body) / 2 - 4} width={textW()} maxWidth={textW()} contain="width" maxLines={1}
                    fontSize={TYPE.body} color={v.row.kind === 'new' && !focused() ? COLORS.muted : fg()}>{v.row.label}</Text>
                  <Show when={list()?.checked}>
                    <Text x={WIDTH - PAD * 2 - 24 - CHECK_W + 16 - (list()?.more ? MORE_W : 0)} y={(ITEM_H - TYPE.body) / 2 - 4}
                      fontSize={TYPE.body} color={fg()}>{'✓'}</Text>
                  </Show>
                  <Show when={list()?.more}>
                    <Text x={WIDTH - PAD * 2 - 24 - MORE_W + 12} y={(ITEM_H - TYPE.body) / 2 - 4} fontSize={TYPE.body}
                      color={fg()}>{'›'}</Text>
                  </Show>
                </View>
              </Show>
            );
          }}</For>
          <For each={footer()}>{(line, k) => (
            <Text x={PAD} y={PAD + HEAD + shown() * STEP + k() * FOOTER_LINE_H} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2}
              contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>
              {line}
            </Text>
          )}</For>
        </View>
      </View>
    </View>
  );
}
