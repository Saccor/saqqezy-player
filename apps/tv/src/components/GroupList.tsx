import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { GroupInfo } from '@iptv/core';
import { pointerMode, usePointerTarget, type Point } from '../input/pointer.ts';
import { rowAt } from '../input/pointerLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { moveFocus, renderRange, scrollTopFor } from './virtualWindow.ts';

export const GROUP_ROW_H = 72;

/**
 * Groups column: one focusable node (the rows only draw), Up/Down moves the selection, Right/Ok hands focus
 * to the channel list. Rendered virtually like the channel list, so long group lists stay cheap.
 *
 * Pointer: hover highlights a group, a click reports it (`onRowClick`), a wheel step moves the selection like
 * Up/Down (without leaving the column at the top).
 */
export function GroupList(props: {
  ref: (el: ElementNode) => void;
  x: number; y: number; width: number; height: number;
  groups: GroupInfo[];
  selected: number;
  onSelect: (index: number) => void;
  onRight: () => boolean;
  /** Up on the first group (Home: move focus to the search bar). */
  onEdgeUp?: () => boolean;
  /** Pointer click on group `index`. */
  onRowClick?: (index: number) => void;
  /** Pointer hit-test layer: 'overlay' inside a picker. Default 'screen'. */
  pointerLayer?: 'screen' | 'overlay';
  /** False: the pointer passes over the column (a keyboard is open above it). Default true. */
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hoverRow, setHoverRow] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  let lastTop = 0;
  const viewRows = () => Math.max(1, Math.floor(props.height / GROUP_ROW_H));
  const total = () => props.groups.length;
  const topNow = createMemo(() => {
    lastTop = scrollTopFor(props.selected, lastTop, viewRows(), total());
    return lastTop;
  });
  const indices = createMemo(() => {
    const r = renderRange(topNow(), viewRows(), total());
    return Array.from({ length: r.to - r.from }, (_, i) => r.from + i);
  });
  const move = (delta: number) => {
    const next = moveFocus(props.selected, delta, total());
    if (next !== props.selected) props.onSelect(next);
    else if (delta < 0 && props.onEdgeUp) return props.onEdgeUp();
    return true;
  };
  const indexAt = (p: Point) => rowAt(p.y, topNow(), GROUP_ROW_H, total());
  usePointerTarget({
    node: () => node,
    layer: props.pointerLayer,
    enabled: () => props.pointerEnabled !== false,
    onHover: (p) => setHoverRow(p ? indexAt(p) : undefined),
    onClick: (p) => {
      const i = indexAt(p);
      if (i !== undefined) props.onRowClick?.(i);
    },
    onWheel: (dy) => {
      const next = moveFocus(props.selected, dy, total());
      if (dy !== 0 && next !== props.selected) props.onSelect(next);
      return true;
    },
  });

  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={setFocused} onUp={() => move(-1)} onDown={() => move(1)}
      onRight={() => props.onRight()} onEnter={() => props.onRight()}>
      <For each={indices()}>{(i) => {
        const g = () => props.groups[i];
        const isSel = () => i === props.selected;
        const hover = () => pointerMode() && hoverRow() === i;
        const fill = () => (isSel() ? (focused() ? COLORS.focus : COLORS.surface) : hover() ? COLORS.hover : 0x00000000);
        const textColor = () => (isSel() && focused() ? COLORS.onFocus : isSel() || hover() ? COLORS.text : COLORS.muted);
        return (
          <View x={0} y={(i - topNow()) * GROUP_ROW_H} width={props.width} height={GROUP_ROW_H - 8}
            color={fill()} borderRadius={LAYOUT.radius}>
            <Text x={20} y={(GROUP_ROW_H - 8 - FONT.body) / 2 - 3} width={props.width - 120} maxWidth={props.width - 120}
              contain="width" maxLines={1} fontSize={FONT.body} color={textColor()}>{g()?.name ?? ''}</Text>
            <Text x={props.width - 100} y={(GROUP_ROW_H - 8 - FONT.small) / 2 - 2} width={80} maxWidth={80} contain="width"
              textAlign="right" fontSize={FONT.small} color={textColor()}>{`${g()?.count ?? ''}`}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}
