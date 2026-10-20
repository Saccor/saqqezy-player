import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT } from '../shell/theme.ts';
import { chipLayout, chipScroll, type BrowseChip } from '../vod/browseNavLogic.ts';

export const CHIP_H = 64;
const CHIP_GAP = 16;
/** Chips drawn beyond each edge of the row, in px. */
const BUFFER_PX = 600;

/**
 * A horizontal row of pill-shaped chips (not focusable: the screen owns the keys). The focused chip stays in view,
 * moving the row as little as possible. Pointer: a click reports the chip, the wheel goes to the screen.
 */
export function ChipRow(props: {
  x: number; y: number; width: number;
  chips: BrowseChip[];
  focus: number;
  lit: boolean;
  onChipClick?: (i: number) => void;
  onWheel?: (dy: number, dx: number) => boolean;
}) {
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  let lastScroll = 0;
  const layout = createMemo(() => chipLayout(props.chips.map((c) => c.label), CHIP_GAP));
  const scroll = createMemo(() => {
    const l = layout();
    lastScroll = chipScroll(l.xs, l.ws, props.focus, lastScroll, props.width - 24);
    return lastScroll;
  });
  const drawn = createMemo(() => {
    const l = layout();
    const s = scroll();
    return props.chips.map((_, i) => i).filter((i) => l.xs[i]! + l.ws[i]! >= s - BUFFER_PX && l.xs[i]! <= s + props.width + BUFFER_PX);
  });
  const at = (px: number) => {
    const l = layout();
    const x = px + scroll();
    const i = l.xs.findIndex((cx, k) => x >= cx && x < cx + l.ws[k]!);
    return i >= 0 ? i : undefined;
  };
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? at(p.x) : undefined),
    subAt: (p) => at(p.x),
    onClick: (p) => { const i = at(p.x); if (i !== undefined) props.onChipClick?.(i); },
    onWheel: (dy, dx) => props.onWheel?.(dy, dx) ?? false,
  });
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={CHIP_H}>
      <For each={drawn()}>{(i) => {
        const lit = () => props.lit && props.focus === i;
        const w = () => layout().ws[i] ?? 0;
        return (
          <View x={(layout().xs[i] ?? 0) - scroll()} width={w()} height={CHIP_H} borderRadius={CHIP_H / 2}
            color={lit() ? COLORS.focus : pointerMode() && hover() === i ? COLORS.hover : COLORS.surface}
            scale={lit() ? 1.06 : 1} zIndex={lit() ? 2 : 1}>
            <Text x={20} y={(CHIP_H - FONT.body) / 2 - 4} width={w() - 40} maxWidth={w() - 40} contain="width" maxLines={1}
              textAlign="center" fontSize={FONT.body} color={lit() ? COLORS.onFocus : COLORS.text}>{props.chips[i]?.label ?? ''}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}
