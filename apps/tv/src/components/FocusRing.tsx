import { Show, View } from '@lightningtv/solid';
import { COLORS, FOCUS } from '../shell/theme.ts';

/**
 * The card focus mark (spec §1.2): a light ring outside a dark gap, so it reads on any artwork. Pointer hover: a thin
 * muted ring. Place it first inside the card's node, at the card's 0,0; it draws at zIndex 0, below the card.
 */
export function FocusRing(props: { w: number; h: number; radius: number; lit: boolean; hover?: boolean }) {
  const out = FOCUS.offset + FOCUS.ring;
  return (
    <>
      <Show when={props.lit}>
        <View x={-out} y={-out} width={props.w + out * 2} height={props.h + out * 2} zIndex={0}
          borderRadius={props.radius + out} color={COLORS.focus} />
        <View x={-FOCUS.offset} y={-FOCUS.offset} width={props.w + FOCUS.offset * 2} height={props.h + FOCUS.offset * 2} zIndex={0}
          borderRadius={props.radius + FOCUS.offset} color={COLORS.background} />
      </Show>
      <Show when={!props.lit && props.hover}>
        <View x={-2} y={-2} width={props.w + 4} height={props.h + 4} zIndex={0} borderRadius={props.radius + 2} color={COLORS.muted} />
      </Show>
    </>
  );
}
