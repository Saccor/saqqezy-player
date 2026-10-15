import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, onCleanup } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { POINTER_BAR_H, POINTER_BTN_W, barLayout } from '../input/pointerLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export interface PointerBarItem { id: string; label: string; width?: number; onPress: () => void }

/** One pill button of a `PointerBar`. Not focusable: the remote never reaches it, the pointer clicks it. */
function PointerButton(props: {
  x: number; y: number; width: number; height: number; label: string; layer: 'screen' | 'overlay';
  onPress: () => void; onHover: (over: boolean) => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node,
    layer: props.layer,
    onHover: (p) => {
      const over = p !== undefined;
      setHovered(over);
      props.onHover(over);
    },
    onClick: () => props.onPress(),
  });
  onCleanup(() => props.onHover(false));
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={props.height}
      borderRadius={props.height / 2} color={hovered() ? COLORS.focus : COLORS.panel} border={{ width: 2, color: COLORS.focus }}>
      <Text y={(props.height - FONT.small) / 2 - 3} width={props.width} maxWidth={props.width} contain="width" textAlign="center"
        maxLines={1} fontSize={FONT.small} color={hovered() ? COLORS.onFocus : COLORS.text}>{props.label}</Text>
    </View>
  );
}

/**
 * A row (or column) of labelled pointer buttons, drawn only in pointer mode, so a remote user's screen never shows it.
 * `onHoverChange` reports whether the pointer is over any of its buttons (the Player keeps its overlay up then).
 */
export function PointerBar(props: {
  x: number;
  y: number;
  items: readonly PointerBarItem[];
  height?: number;
  gap?: number;
  vertical?: boolean;
  layer?: 'screen' | 'overlay';
  zIndex?: number;
  onHoverChange?: (over: boolean) => void;
}) {
  const h = () => props.height ?? POINTER_BAR_H;
  const gap = () => props.gap ?? LAYOUT.gap / 2;
  const widths = () => props.items.map((it) => it.width ?? POINTER_BTN_W);
  const layout = createMemo(() => barLayout(props.vertical ? props.items.map(() => h()) : widths(), gap()));
  // Ids of the buttons under the pointer; each button clears itself on cleanup, so the set never outlives the bar.
  const over = new Set<string>();
  const hover = (id: string, on: boolean) => {
    const before = over.size > 0;
    if (on) over.add(id);
    else over.delete(id);
    if (over.size > 0 !== before) props.onHoverChange?.(over.size > 0);
  };
  return (
    <Show when={pointerMode()}>
      <View x={props.x} y={props.y} zIndex={props.zIndex ?? 10}>
        <For each={props.items}>{(it, i) => (
          <PointerButton x={props.vertical ? 0 : layout().offsets[i()] ?? 0} y={props.vertical ? layout().offsets[i()] ?? 0 : 0}
            width={widths()[i()] ?? POINTER_BTN_W} height={h()} label={it.label} layer={props.layer ?? 'screen'}
            onPress={it.onPress} onHover={(on) => hover(it.id, on)} />
        )}</For>
      </View>
    </Show>
  );
}
