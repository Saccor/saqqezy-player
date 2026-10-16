import { Text, View, type ElementNode } from '@lightningtv/solid';
import { Index, createMemo, createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT } from '../shell/theme.ts';
import { seasonTabWidth, stripAt, stripOffset, stripStarts } from '../vod/seriesDetailLogic.ts';

export const SEASON_TAB_H = 56;
const GAP = 12;
/** Skeleton pills while the series loads. */
const SKELETON = [180, 180, 180];
const SHOWN = 0x2a3448ff;

/**
 * The season pills (not focusable: the screen owns the keys). `sel` is the pill the keys are on; `shown` the season whose
 * episodes are listed (underlined). Lit: the selected pill is filled with the focus colour. The strip scrolls to keep
 * `sel` in view. `labels` undefined: skeleton pills. Pointer: a click reports the pill, hover lightens it.
 */
export function SeasonTabs(props: {
  x: number; y: number; width: number;
  labels: readonly string[] | undefined;
  sel: number;
  shown: number;
  lit: boolean;
  onTabClick?: (i: number) => void;
}) {
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  let lastOffset = 0;
  const widths = createMemo(() => (props.labels ? props.labels.map(seasonTabWidth) : SKELETON));
  const starts = createMemo(() => stripStarts(widths(), GAP));
  const offset = createMemo(() => (lastOffset = stripOffset(starts(), widths(), props.sel, props.width, lastOffset)));
  const at = (px: number) => (props.labels ? stripAt(starts(), widths(), px + offset()) : undefined);
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? at(p.x) : undefined),
    subAt: (p) => at(p.x),
    onClick: (p) => { const i = at(p.x); if (i !== undefined) props.onTabClick?.(i); },
  });
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={SEASON_TAB_H} clipping>
      <Index each={widths()}>{(w, i) => {
        const label = () => props.labels?.[i];
        const lit = () => props.lit && props.sel === i;
        const shown = () => props.labels !== undefined && props.shown === i;
        const fill = () => (lit() ? COLORS.focus : hover() === i && pointerMode() ? COLORS.hover : shown() ? SHOWN : COLORS.surface);
        return (
          <View x={(starts()[i] ?? 0) - offset()} width={w()} height={SEASON_TAB_H} borderRadius={SEASON_TAB_H / 2} color={fill()}>
            <Text y={(SEASON_TAB_H - FONT.body) / 2 - 2} width={w()} maxWidth={w()} contain="width" maxLines={1} textAlign="center"
              fontSize={FONT.body} color={lit() ? COLORS.onFocus : shown() ? COLORS.text : COLORS.muted}>{label() ?? ''}</Text>
            <View x={w() / 2 - 20} y={SEASON_TAB_H - 6} width={40} height={4} borderRadius={2}
              color={COLORS.focus} alpha={shown() && !lit() ? 1 : 0} />
          </View>
        );
      }}</Index>
    </View>
  );
}
