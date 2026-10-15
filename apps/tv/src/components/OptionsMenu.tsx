import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerBackdrop, usePointerTarget, type Point } from '../input/pointer.ts';
import { rowAt } from '../input/pointerLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export interface OptionItem { id: string; label: string; value?: string }

const W = 640;
const PAD = 32;
const ITEM_H = 72;
const ITEM_GAP = 10;
const HEAD = 64;
const X = LAYOUT.width - LAYOUT.safeX - W;
const Y = LAYOUT.safeY + 64;

/**
 * Player options panel on the right. One focusable node: Up/Down move, Ok calls `onChoose` (the menu stays
 * open; the Player decides). It handles no Back itself: the Player registers it with `router.pushOverlay`.
 * Remount it (keyed) to reset the selection when the page changes.
 *
 * Pointer: a click on an item chooses it, hover highlights it, the wheel moves the selection, and a click outside the
 * panel is Back.
 */
export function OptionsMenu(props: {
  ref: (el: ElementNode) => void;
  title: string;
  items: OptionItem[];
  onChoose: (id: string) => void;
}) {
  const [sel, setSel] = createSignal(0);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let backdrop: ElementNode | undefined;
  let panel: ElementNode | undefined;
  const move = (d: number) => {
    setSel((s) => Math.max(0, Math.min(props.items.length - 1, s + d)));
    return true;
  };
  // Digits are swallowed so they never reach the Player's number entry while the menu is open.
  const digitHandlers = Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [`onDigit${d}`, () => true]),
  );
  const height = () => PAD * 2 + HEAD + props.items.length * (ITEM_H + ITEM_GAP);
  const indexAt = (p: Point) => rowAt(p.y - PAD - HEAD, 0, ITEM_H + ITEM_GAP, props.items.length);
  // Backdrop first, then the panel: the panel wins where they overlap.
  usePointerBackdrop(() => backdrop);
  usePointerTarget({
    node: () => panel,
    layer: 'overlay',
    onHover: (p) => setHover(p ? indexAt(p) : undefined),
    onClick: (p) => {
      const i = indexAt(p);
      const it = i === undefined ? undefined : props.items[i];
      if (i === undefined || !it) return;
      setSel(i);
      props.onChoose(it.id);
    },
    onWheel: (dy) => {
      if (dy !== 0) move(dy);
      return true;
    },
  });
  return (
    <View ref={(el) => { panel = el; props.ref(el); }} x={X} y={Y} width={W} height={height()}
      color={COLORS.panel} borderRadius={LAYOUT.radius * 2} zIndex={40}
      onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => true} onRight={() => true}
      onChannelUp={() => true} onChannelDown={() => true} onMenu={() => true} onLongOk={() => true} onInfo={() => true}
      onRed={() => true} {...digitHandlers}
      onEnter={() => { const it = props.items[sel()]; if (it) props.onChoose(it.id); return true; }}>
      {/* The click-outside area: the whole screen. No colour: it draws nothing. */}
      <View ref={(el) => { backdrop = el; }} x={-X} y={-Y} width={LAYOUT.width} height={LAYOUT.height} />
      <Text x={PAD} y={PAD} fontSize={FONT.heading} color={COLORS.text}>{props.title}</Text>
      <For each={props.items}>{(it, i) => (
        <View x={PAD} y={PAD + HEAD + i() * (ITEM_H + ITEM_GAP)} width={W - PAD * 2} height={ITEM_H}
          borderRadius={LAYOUT.radius}
          color={sel() === i() ? COLORS.focus : pointerMode() && hover() === i() ? COLORS.hover : COLORS.surface}>
          <Text x={24} y={(ITEM_H - FONT.body) / 2 - 4} width={W - PAD * 2 - 48} maxWidth={W - PAD * 2 - 48} contain="width"
            maxLines={1} fontSize={FONT.body} color={sel() === i() ? COLORS.onFocus : COLORS.text}>{it.label}</Text>
          <Text x={W - PAD * 2 - 24 - 240} y={(ITEM_H - FONT.body) / 2 - 4} width={240} maxWidth={240} contain="width"
            textAlign="right" maxLines={1} fontSize={FONT.body}
            color={sel() === i() ? COLORS.onFocus : COLORS.muted}>{it.value ?? ''}</Text>
        </View>
      )}</For>
    </View>
  );
}
