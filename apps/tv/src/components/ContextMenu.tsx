import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerBackdrop, usePointerTarget, type Point } from '../input/pointer.ts';
import { rowAt } from '../input/pointerLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export interface ContextMenuItem<A extends string> { action: A; label: string }

const WIDTH = 640;
const ITEM_H = 72;
const PAD = 32;
/** The title band above the first item. */
const HEAD = 64;

/**
 * Channel options over a scrim. One focusable node; Up/Down choose, Ok confirms. It handles no Back itself:
 * Home registers it with `router.pushOverlay`, so Back closes it like Cancel. `items` come from
 * `buildChannelMenu` (homeMenuLogic.ts); the last one should be the cancel action.
 *
 * Pointer: a click on an item chooses it, hover highlights it, the wheel moves the selection, and a click outside the
 * panel is Back.
 */
export function ContextMenu<A extends string>(props: {
  ref: (el: ElementNode) => void;
  title: string;
  items: readonly ContextMenuItem<A>[];
  cancel: A;
  onChoose: (action: A) => void;
  /** False: neither the panel nor the backdrop takes the pointer (Home's keyboard is open above). Default true. */
  pointerEnabled?: boolean;
}) {
  const [selRaw, setSelRaw] = createSignal(0);
  const [selAction, setSelAction] = createSignal<A | undefined>(undefined);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let scrim: ElementNode | undefined;
  let panel: ElementNode | undefined;
  // The items can change while the menu is open (a remote layout change): the selection stays on the same
  // action when it is still there, else on the same row, clamped.
  const sel = () => {
    const a = selAction();
    const i = a === undefined ? -1 : props.items.findIndex((it) => it.action === a);
    return i >= 0 ? i : Math.max(0, Math.min(selRaw(), props.items.length - 1));
  };
  const setSel = (i: number) => { setSelRaw(i); setSelAction(() => props.items[i]?.action); };
  const height = () => PAD * 2 + HEAD + props.items.length * (ITEM_H + 12);
  const move = (d: number) => {
    setSel(Math.max(0, Math.min(props.items.length - 1, sel() + d)));
    return true;
  };
  const indexAt = (p: Point) => rowAt(p.y - PAD - HEAD, 0, ITEM_H + 12, props.items.length);
  // Backdrop first, then the panel: the panel wins where they overlap.
  const enabled = () => props.pointerEnabled !== false;
  usePointerBackdrop(() => scrim, undefined, false, enabled);
  usePointerTarget({
    node: () => panel,
    layer: 'overlay',
    enabled,
    subAt: (p) => indexAt(p),
    onHover: (p) => setHover(p ? indexAt(p) : undefined),
    onClick: (p) => {
      const i = indexAt(p);
      const it = i === undefined ? undefined : props.items[i];
      if (i === undefined || !it) return;
      setSel(i);
      props.onChoose(it.action);
    },
    onWheel: (dy) => {
      if (dy !== 0) move(dy);
      return true;
    },
  });
  return (
    <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={50}>
      <View ref={(el) => { panel = el; props.ref(el); }} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - height()) / 2}
        width={WIDTH} height={height()} color={COLORS.surface} borderRadius={LAYOUT.radius * 2}
        onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => true} onRight={() => true}
        onMenu={() => true} onLongOk={() => true}
        onEnter={() => { props.onChoose(props.items[sel()]?.action ?? props.cancel); return true; }}>
        <Text x={PAD} y={PAD} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width" maxLines={1}
          fontSize={FONT.heading} color={COLORS.text}>{props.title}</Text>
        <For each={props.items}>{(it, i) => (
          <View x={PAD} y={PAD + HEAD + i() * (ITEM_H + 12)} width={WIDTH - PAD * 2} height={ITEM_H}
            borderRadius={LAYOUT.radius}
            color={sel() === i() ? COLORS.focus : pointerMode() && hover() === i() ? COLORS.hover : COLORS.background}>
            <Text x={24} y={(ITEM_H - FONT.body) / 2 - 4} width={WIDTH - PAD * 2 - 48} maxWidth={WIDTH - PAD * 2 - 48}
              contain="width" maxLines={1} fontSize={FONT.body}
              color={sel() === i() ? COLORS.onFocus : COLORS.text}>{it.label}</Text>
          </View>
        )}</For>
      </View>
    </View>
  );
}
