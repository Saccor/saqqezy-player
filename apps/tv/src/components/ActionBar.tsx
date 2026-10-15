import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { BUTTON_H } from './Button.tsx';

export interface Action { id: string; label: string; width: number }
const GAP = 16;

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
}) {
  const [focused, setFocused] = createSignal(false);
  const [sel, setSel] = createSignal(0);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  const xs = () => {
    let x = 0;
    return props.actions.map((a) => { const at = x; x += a.width + GAP; return at; });
  };
  const width = () => props.actions.reduce((w, a) => w + a.width + GAP, -GAP);
  const at = (px: number) => {
    const i = xs().findIndex((x, k) => px >= x && px < x + props.actions[k]!.width);
    return i >= 0 ? i : undefined;
  };
  const cur = () => Math.max(0, Math.min(sel(), props.actions.length - 1));
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
      onLeft={() => { if (cur() === 0 && props.onLeft) return props.onLeft(); setSel(Math.max(0, cur() - 1)); return true; }}
      onRight={() => { setSel(Math.min(props.actions.length - 1, cur() + 1)); return true; }}
      onUp={() => props.onUp?.() ?? true} onDown={() => props.onDown?.() ?? true}
      onEnter={() => { const a = props.actions[cur()]; if (a) props.onAction(a.id); return true; }}>
      <For each={props.actions}>{(a, i) => {
        const lit = () => focused() && cur() === i();
        const fill = () => (lit() ? COLORS.focus : hover() === i() && pointerMode() ? COLORS.hover : COLORS.surface);
        return (
          <View x={xs()[i()] ?? 0} width={a.width} height={BUTTON_H} borderRadius={LAYOUT.radius} color={fill()}
            border={{ width: 2, color: COLORS.focus }} scale={lit() ? 1.04 : 1}>
            <Text y={(BUTTON_H - FONT.body) / 2 - 4} width={a.width} maxWidth={a.width} contain="width" textAlign="center"
              fontSize={FONT.body} color={lit() ? COLORS.onFocus : COLORS.text}>{a.label}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}
