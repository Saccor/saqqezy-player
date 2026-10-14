import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export interface ContextMenuItem<A extends string> { action: A; label: string }

const WIDTH = 640;
const ITEM_H = 72;
const PAD = 32;

/**
 * Channel options over a scrim. One focusable node; Up/Down choose, Ok confirms. It handles no Back itself:
 * Home registers it with `router.pushOverlay`, so Back closes it like Cancel. `items` come from
 * `buildChannelMenu` (homeMenuLogic.ts); the last one should be the cancel action.
 */
export function ContextMenu<A extends string>(props: {
  ref: (el: ElementNode) => void;
  title: string;
  items: readonly ContextMenuItem<A>[];
  cancel: A;
  onChoose: (action: A) => void;
}) {
  const [selRaw, setSelRaw] = createSignal(0);
  const [selAction, setSelAction] = createSignal<A | undefined>(undefined);
  // The items can change while the menu is open (a remote layout change): the selection stays on the same
  // action when it is still there, else on the same row, clamped.
  const sel = () => {
    const a = selAction();
    const i = a === undefined ? -1 : props.items.findIndex((it) => it.action === a);
    return i >= 0 ? i : Math.max(0, Math.min(selRaw(), props.items.length - 1));
  };
  const setSel = (i: number) => { setSelRaw(i); setSelAction(() => props.items[i]?.action); };
  const height = () => PAD * 2 + 64 + props.items.length * (ITEM_H + 12);
  const move = (d: number) => {
    setSel(Math.max(0, Math.min(props.items.length - 1, sel() + d)));
    return true;
  };
  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={50}>
      <View ref={props.ref} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - height()) / 2} width={WIDTH} height={height()}
        color={COLORS.surface} borderRadius={LAYOUT.radius * 2}
        onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => true} onRight={() => true}
        onMenu={() => true} onLongOk={() => true}
        onEnter={() => { props.onChoose(props.items[sel()]?.action ?? props.cancel); return true; }}>
        <Text x={PAD} y={PAD} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width" maxLines={1}
          fontSize={FONT.heading} color={COLORS.text}>{props.title}</Text>
        <For each={props.items}>{(it, i) => (
          <View x={PAD} y={PAD + 64 + i() * (ITEM_H + 12)} width={WIDTH - PAD * 2} height={ITEM_H}
            borderRadius={LAYOUT.radius} color={sel() === i() ? COLORS.focus : COLORS.background}>
            <Text x={24} y={(ITEM_H - FONT.body) / 2 - 4} width={WIDTH - PAD * 2 - 48} maxWidth={WIDTH - PAD * 2 - 48}
              contain="width" maxLines={1} fontSize={FONT.body}
              color={sel() === i() ? COLORS.onFocus : COLORS.text}>{it.label}</Text>
          </View>
        )}</For>
      </View>
    </View>
  );
}
