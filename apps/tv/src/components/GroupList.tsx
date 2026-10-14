import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import type { GroupInfo } from '@iptv/core';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { moveFocus, renderRange, scrollTopFor } from './virtualWindow.ts';

export const GROUP_ROW_H = 72;

/**
 * Groups column: one focusable node (the rows only draw), Up/Down moves the selection, Right/Ok hands focus
 * to the channel list. Rendered virtually like the channel list, so long group lists stay cheap.
 */
export function GroupList(props: {
  ref: (el: ElementNode) => void;
  x: number; y: number; width: number; height: number;
  groups: GroupInfo[];
  selected: number;
  onSelect: (index: number) => void;
  onRight: () => boolean;
}) {
  const [focused, setFocused] = createSignal(false);
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
    return true;
  };

  return (
    <View ref={props.ref} x={props.x} y={props.y} width={props.width} height={props.height} clipping
      onFocusChanged={setFocused} onUp={() => move(-1)} onDown={() => move(1)}
      onRight={() => props.onRight()} onEnter={() => props.onRight()}>
      <For each={indices()}>{(i) => {
        const g = () => props.groups[i];
        const isSel = () => i === props.selected;
        const fill = () => (isSel() ? (focused() ? COLORS.focus : COLORS.surface) : 0x00000000);
        const textColor = () => (isSel() && focused() ? COLORS.onFocus : isSel() ? COLORS.text : COLORS.muted);
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
