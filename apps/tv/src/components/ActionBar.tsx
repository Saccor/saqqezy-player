import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, TYPE } from '../shell/theme.ts';
import { selectedIndex } from './actionBarLogic.ts';
import { BUTTON_H } from './Button.tsx';

export interface Action {
  id: string;
  /** The button's text; an icon button keeps it as its name and draws the icon instead. */
  label: string;
  width: number;
  /** A white-on-transparent texture (e.g. `iconTexture`), drawn centred and tinted like the label. */
  icon?: string;
  /** A circle (or pill) instead of a rounded rectangle. */
  round?: boolean;
  /** A fixed x within the bar (for grouped rows); the buttons after it continue from there. */
  x?: number;
}
const GAP = 16;
const ICON = 32;

/** A row of buttons behind one focusable node (Left/Right choose, Ok presses). Pointer: click presses, hover lightens. */
export function ActionBar(props: {
  ref?: (el: ElementNode) => void;
  x: number; y: number;
  actions: Action[];
  onAction: (id: string) => void;
  /** Left on the first button (otherwise Left only moves between buttons). */
  onLeft?: () => boolean;
  onUp?: () => boolean;
  onDown?: () => boolean;
  onFocusChanged?: (f: boolean) => void;
  /** Menu or long OK on the selected button (View all's competition chips: put first, hide). Unset: the key bubbles. */
  onOptions?: (id: string) => void;
  /** The action selected before the first Left/Right (default: the first one). */
  initial?: string;
  /** The action in effect (a chosen filter): drawn in the accent colour whenever it is not the lit one. */
  current?: string;
}) {
  const [focused, setFocused] = createSignal(false);
  /** The selected action's id: the selection follows it when the list changes (by index only when it is gone). */
  const [selId, setSelId] = createSignal<string | undefined>(props.initial);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  const xs = () => {
    let x = 0;
    return props.actions.map((a) => { const at = a.x ?? x; x = at + a.width + GAP; return at; });
  };
  const width = () => {
    const last = props.actions.length - 1;
    return last < 0 ? 0 : (xs()[last] ?? 0) + props.actions[last]!.width;
  };
  const at = (px: number) => {
    const i = xs().findIndex((x, k) => px >= x && px < x + props.actions[k]!.width);
    return i >= 0 ? i : undefined;
  };
  const cur = createMemo((prev: number) => selectedIndex(props.actions, selId(), prev), 0);
  const select = (i: number) => setSelId(props.actions[i]?.id);
  const options = () => {
    const a = props.actions[cur()];
    if (!a || !props.onOptions) return false;
    props.onOptions(a.id);
    return true;
  };
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? at(p.x) : undefined),
    subAt: (p) => at(p.x),
    onClick: (p) => {
      const i = at(p.x);
      const a = i === undefined ? undefined : props.actions[i];
      if (a) props.onAction(a.id);
    },
  });
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x} y={props.y} width={Math.max(0, width())} height={BUTTON_H}
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onLeft={() => { if (cur() === 0 && props.onLeft) return props.onLeft(); select(Math.max(0, cur() - 1)); return true; }}
      onRight={() => { select(Math.min(props.actions.length - 1, cur() + 1)); return true; }}
      onUp={() => props.onUp?.() ?? true} onDown={() => props.onDown?.() ?? true}
      onEnter={() => { const a = props.actions[cur()]; if (a) props.onAction(a.id); return true; }}
      onMenu={() => options()} onLongOk={() => options()}>
      <For each={props.actions}>{(a, i) => {
        const lit = () => focused() && cur() === i();
        const fill = () => (lit() ? COLORS.focus : hover() === i() && pointerMode() ? COLORS.hover
          : props.current === a.id ? COLORS.selected : COLORS.surfaceRaised);
        return (
          <View x={xs()[i()] ?? 0} width={a.width} height={BUTTON_H} borderRadius={BUTTON_H / 2}
            color={fill()}>
            <Show when={a.icon} fallback={
              <Text y={(BUTTON_H - TYPE.body) / 2 - 4} width={a.width} maxWidth={a.width} contain="width" maxLines={1} textAlign="center"
                fontSize={TYPE.body} color={lit() ? COLORS.onFocus : COLORS.text}>{a.label}</Text>
            }>
              <View x={(a.width - ICON) / 2} y={(BUTTON_H - ICON) / 2} width={ICON} height={ICON} src={a.icon}
                color={lit() ? COLORS.onFocus : COLORS.text} />
            </Show>
          </View>
        );
      }}</For>
    </View>
  );
}
