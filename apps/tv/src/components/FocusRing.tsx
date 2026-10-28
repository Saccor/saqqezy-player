import { View } from '@lightningtv/solid';
import { COLORS, FOCUS } from '../shell/theme.ts';

/**
 * The tile focus mark (spec 2026-10-26 §1.2): a 4 px light ring at 4 px offset around a dark gap, so it reads on any
 * artwork. One node, always mounted: its fill is the dark gap (behind the tile) and its border the ring; it shows by
 * alpha, never by remounting. Pointer hover draws the same ring (one hover style, equal to focus). Place it first inside
 * the tile's node at 0,0; it draws at zIndex 0, below the tile. `clear` leaves the gap undrawn, for a video window (the
 * fill would hide the video plane behind it) or a box that is already drawn.
 */
export function FocusRing(props: { w: number; h: number; radius: number; lit: boolean; hover?: boolean; clear?: boolean }) {
  const out = FOCUS.offset + FOCUS.ring;
  return (
    <View x={-out} y={-out} width={props.w + out * 2} height={props.h + out * 2} zIndex={0}
      borderRadius={props.radius + out} color={props.clear ? COLORS.transparent : COLORS.background} border={{ width: FOCUS.ring, color: COLORS.focus }}
      alpha={props.lit || props.hover === true ? 1 : 0} />
  );
}
