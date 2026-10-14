import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export type ContextAction = 'favourite' | 'hide' | 'cancel';

const WIDTH = 560;
const ITEM_H = 72;
const PAD = 32;

/**
 * Channel options over a scrim. One focusable node; Up/Down choose, Ok confirms. It handles no Back itself:
 * Home registers it with `router.pushOverlay`, so Back closes it like Cancel.
 */
export function ContextMenu(props: {
  ref: (el: ElementNode) => void;
  title: string;
  favourite: boolean;
  onChoose: (action: ContextAction) => void;
}) {
  const [sel, setSel] = createSignal(0);
  const items = (): { action: ContextAction; label: string }[] => [
    { action: 'favourite', label: props.favourite ? 'Remove from favourites' : 'Add to favourites' },
    { action: 'hide', label: 'Hide channel' },
    { action: 'cancel', label: 'Cancel' },
  ];
  const height = PAD * 2 + 64 + items().length * (ITEM_H + 12);
  const move = (d: number) => {
    setSel((s) => Math.max(0, Math.min(items().length - 1, s + d)));
    return true;
  };
  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={50}>
      <View ref={props.ref} x={(LAYOUT.width - WIDTH) / 2} y={(LAYOUT.height - height) / 2} width={WIDTH} height={height}
        color={COLORS.surface} borderRadius={LAYOUT.radius * 2}
        onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => true} onRight={() => true}
        onMenu={() => true} onLongOk={() => true}
        onEnter={() => { props.onChoose(items()[sel()]?.action ?? 'cancel'); return true; }}>
        <Text x={PAD} y={PAD} width={WIDTH - PAD * 2} maxWidth={WIDTH - PAD * 2} contain="width" maxLines={1}
          fontSize={FONT.heading} color={COLORS.text}>{props.title}</Text>
        <For each={items()}>{(it, i) => (
          <View x={PAD} y={PAD + 64 + i() * (ITEM_H + 12)} width={WIDTH - PAD * 2} height={ITEM_H}
            borderRadius={LAYOUT.radius} color={sel() === i() ? COLORS.focus : COLORS.background}>
            <Text x={24} y={(ITEM_H - FONT.body) / 2 - 4} fontSize={FONT.body}
              color={sel() === i() ? COLORS.onFocus : COLORS.text}>{it.label}</Text>
          </View>
        )}</For>
      </View>
    </View>
  );
}
