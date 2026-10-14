import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { moveFocus, renderRange, scrollTopFor } from './virtualWindow.ts';

export interface SettingItem {
  id: string;
  label: string;
  value?: string;
  /** Muted line under the label. */
  help?: string;
  /** Shows `‹ value ›`: Left/Right change it. */
  adjustable?: boolean;
}

export const SETTING_ROW_H = 104;
const VALUE_W = 380;
const FOCUS_FILL = 0x1b2436ff;

/**
 * A settings page's rows: one focusable node (rows only draw), Up/Down move the selection, Ok calls `onOk`,
 * Left/Right call `onAdjust` (an unhandled Left goes back to the menu via `onLeftEdge`). Rendered virtually,
 * so long lists (hidden channels) stay cheap.
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
  let lastTop = 0;
  const viewRows = () => Math.max(1, Math.floor(props.height / SETTING_ROW_H));
  const total = () => props.items.length;
  const sel = () => Math.min(props.selected, Math.max(0, total() - 1));
  const top = createMemo(() => {
    lastTop = scrollTopFor(sel(), lastTop, viewRows(), total());
    return lastTop;
  });
  const indices = createMemo(() => {
    const r = renderRange(top(), viewRows(), total());
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const move = (d: number) => {
    const next = moveFocus(sel(), d, total());
    if (next !== sel()) props.onSelect(next);
    return true;
  };
  const current = () => props.items[sel()];
  const adjust = (dir: 1 | -1) => {
    const it = current();
    if (it && props.onAdjust?.(it.id, dir)) return true;
    return dir === -1 ? props.onLeftEdge() : true;
  };

  return (
    <View ref={props.ref} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={setFocused} onUp={() => move(-1)} onDown={() => move(1)}
      onLeft={() => adjust(-1)} onRight={() => adjust(1)}
      onEnter={() => { const it = current(); if (it) props.onOk?.(it.id); return true; }}>
      <For each={indices()}>{(i) => {
        const it = () => props.items[i];
        const isSel = () => i === sel();
        const active = () => isSel() && focused();
        const stepper = () => it()?.adjustable === true && active();
        const valueY = (SETTING_ROW_H - 12 - FONT.body) / 2 - 4;
        return (
          <View x={0} y={(i - top()) * SETTING_ROW_H} width={props.width} height={SETTING_ROW_H - 12}
            borderRadius={LAYOUT.radius} color={active() ? FOCUS_FILL : isSel() ? COLORS.surface : 0x00000000}
            border={{ width: 3, color: active() ? COLORS.focus : 0x00000000 }}>
            <Text x={28} y={it()?.help ? 14 : (SETTING_ROW_H - 12 - FONT.body) / 2 - 4}
              width={props.width - VALUE_W - 56} maxWidth={props.width - VALUE_W - 56} contain="width" maxLines={1}
              fontSize={FONT.body} color={COLORS.text}>{it()?.label ?? ''}</Text>
            <Show when={it()?.help}>
              <Text x={28} y={54} width={props.width - VALUE_W - 56} maxWidth={props.width - VALUE_W - 56} contain="width"
                maxLines={1} fontSize={FONT.small} color={COLORS.muted}>{it()?.help ?? ''}</Text>
            </Show>
            {/* Focused adjustable row: a stepper (‹ value ›); otherwise the value right-aligned. */}
            <Show when={stepper()}>
              <Text x={props.width - VALUE_W - 28} y={valueY} fontSize={FONT.body} color={COLORS.focus}>{'‹'}</Text>
              <Text x={props.width - 28 - 14} y={valueY} fontSize={FONT.body} color={COLORS.focus}>{'›'}</Text>
            </Show>
            <Text x={props.width - VALUE_W - 28 + (stepper() ? 28 : 0)} y={valueY} width={VALUE_W - (stepper() ? 56 : 0)}
              maxWidth={VALUE_W - (stepper() ? 56 : 0)} contain="width" textAlign={stepper() ? 'center' : 'right'}
              maxLines={1} fontSize={FONT.body} color={active() ? COLORS.text : COLORS.muted}>{it()?.value ?? ''}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}
