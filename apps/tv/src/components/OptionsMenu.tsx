import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerBackdrop, usePointerTarget, type Point } from '../input/pointer.ts';
import { panelRowHit } from '../input/pointerLogic.ts';
import { riseIn } from '../shell/motion.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';

export interface OptionItem { id: string; label: string; value?: string }

const W = 640;
const PAD = 32;
const ITEM_H = 72;
const ITEM_GAP = 10;
const HEAD = 64;
const X = LAYOUT.width - LAYOUT.safeX - W;
const Y = LAYOUT.safeY + 64;
/** Items shown at once: the panel then ends inside the safe area (a long audio-track list ran off the screen). */
const VISIBLE = Math.floor((LAYOUT.height - LAYOUT.safeY - Y - PAD * 2 - HEAD + ITEM_GAP) / (ITEM_H + ITEM_GAP));
const VALUE_W = 240;
/** A label beside a value stops before it; without a value it takes the whole row. */
const LABEL_W_WITH_VALUE = W - PAD * 2 - 48 - VALUE_W - 16;

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
  /** The item selected when the menu opens (a long list opens at the current value). */
  initial?: number;
}) {
  const [sel, setSel] = createSignal(Math.max(0, Math.min(props.items.length - 1, props.initial ?? 0)));
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
  const shownCount = () => Math.min(props.items.length, VISIBLE);
  /** The first item shown: the window follows the selection, keeping it near the middle. */
  const top = () => Math.max(0, Math.min(sel() - Math.floor(VISIBLE / 2), props.items.length - VISIBLE));
  const shown = () => props.items.slice(top(), top() + VISIBLE);
  const height = () => PAD * 2 + HEAD + shownCount() * (ITEM_H + ITEM_GAP);
  const indexAt = (p: Point) => {
    const i = panelRowHit(p, W, PAD, PAD + HEAD, ITEM_H + ITEM_GAP, ITEM_GAP, shownCount());
    return i === undefined ? undefined : i + top();
  };
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
    <View ref={(el) => { panel = el; props.ref(el); riseIn(el); }} x={X} y={Y} width={W} height={height()}
      color={COLORS.panel} borderRadius={LAYOUT.radius * 2} zIndex={40}
      onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => true} onRight={() => true}
      onChannelUp={() => true} onChannelDown={() => true} onMenu={() => true} onLongOk={() => true} onInfo={() => true}
      onRed={() => true} {...digitHandlers}
      onEnter={() => { const it = props.items[sel()]; if (it) props.onChoose(it.id); return true; }}>
      {/* The click-outside area: the whole screen. No colour: it draws nothing. */}
      <View ref={(el) => { backdrop = el; }} x={-X} y={-Y} width={LAYOUT.width} height={LAYOUT.height} />
      <Text x={PAD} y={PAD} width={W - PAD * 2} maxWidth={W - PAD * 2} contain="width" maxLines={1} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.title}</Text>
      <For each={shown()}>{(it, v) => {
        const i = () => v() + top();
        const labelW = () => (it.value ? LABEL_W_WITH_VALUE : W - PAD * 2 - 48);
        return (
          <View x={PAD} y={PAD + HEAD + v() * (ITEM_H + ITEM_GAP)} width={W - PAD * 2} height={ITEM_H}
            borderRadius={LAYOUT.radius}
            color={sel() === i() ? COLORS.focus : pointerMode() && hover() === i() ? COLORS.hover : COLORS.surface}>
            <Text x={24} y={(ITEM_H - TYPE.body) / 2 - 4} width={labelW()} maxWidth={labelW()} contain="width"
              maxLines={1} fontSize={TYPE.body} color={sel() === i() ? COLORS.onFocus : COLORS.text}>{it.label}</Text>
            <Text x={W - PAD * 2 - 24 - VALUE_W} y={(ITEM_H - TYPE.body) / 2 - 4} width={VALUE_W} maxWidth={VALUE_W} contain="width"
              textAlign="right" maxLines={1} fontSize={TYPE.body}
              color={sel() === i() ? COLORS.onFocus : COLORS.muted}>{it.value ?? ''}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}
