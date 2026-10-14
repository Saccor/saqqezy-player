import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export interface OptionItem { id: string; label: string; value?: string }

const W = 640;
const PAD = 32;
const ITEM_H = 72;
const ITEM_GAP = 10;

/**
 * Player options panel on the right. One focusable node: Up/Down move, Ok calls `onChoose` (the menu stays
 * open; the Player decides). It handles no Back itself: the Player registers it with `router.pushOverlay`.
 * Remount it (keyed) to reset the selection when the page changes.
 */
export function OptionsMenu(props: {
  ref: (el: ElementNode) => void;
  title: string;
  items: OptionItem[];
  onChoose: (id: string) => void;
}) {
  const [sel, setSel] = createSignal(0);
  const move = (d: number) => {
    setSel((s) => Math.max(0, Math.min(props.items.length - 1, s + d)));
    return true;
  };
  const height = () => PAD * 2 + 64 + props.items.length * (ITEM_H + ITEM_GAP);
  return (
    <View ref={props.ref} x={LAYOUT.width - LAYOUT.safeX - W} y={LAYOUT.safeY + 64} width={W} height={height()}
      color={COLORS.panel} borderRadius={LAYOUT.radius * 2} zIndex={40}
      onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => true} onRight={() => true}
      onChannelUp={() => true} onChannelDown={() => true} onMenu={() => true} onLongOk={() => true} onInfo={() => true}
      onRed={() => true}
      onEnter={() => { const it = props.items[sel()]; if (it) props.onChoose(it.id); return true; }}>
      <Text x={PAD} y={PAD} fontSize={FONT.heading} color={COLORS.text}>{props.title}</Text>
      <For each={props.items}>{(it, i) => (
        <View x={PAD} y={PAD + 64 + i() * (ITEM_H + ITEM_GAP)} width={W - PAD * 2} height={ITEM_H}
          borderRadius={LAYOUT.radius} color={sel() === i() ? COLORS.focus : COLORS.surface}>
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
