import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import type { ProgrammeHit } from '@iptv/app-api';
import { imageSrc } from '../images/imageSrc.ts';
import { FocusRing } from './FocusRing.tsx';
import { useFocusScale } from '../shell/motion.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { progressOf } from '../screens/homeLogic.ts';
import { COMPACT_H, COMPACT_W, MATCH_GRID_H, WIDE_H, WIDE_W, wideLines, type WideCell } from './wideTileLogic.ts';

export { COMPACT_H, COMPACT_W, MATCH_GRID_H, WIDE_GAP, WIDE_H, WIDE_W, wideSize, type WideCell } from './wideTileLogic.ts';

const PAD = 18;
const LOGO = 56;
const TRACK_H = 4;
/** Compact: a smaller pad and logo; the context line on top, then two lines (the sides, or the title), then the detail. */
const C_PAD = 16;
const C_LOGO = 48;
const C_LINE1_Y = 14;
const C_LINE2_Y = 44;
const C_LINE3_Y = 74;
const C_LINE4_Y = 104;

/**
 * A landscape tile for a channel, a sports event (Start page) or a programme (Search). Logos and icons come only from
 * the user's own data. `compact` (Start's match and channel rows, View all): 360×112, three lines beside a small logo; with
 * `detail` 360×136. The focus ring and scale are the same as the full tile's.
 */
export function WideTile(props: {
  x: number; y: number; cell: WideCell; lit: boolean; hover?: boolean; now: number;
  /** Channels: "105 · Name" in the context line, so duplicates (HD/SD, regional) can be told apart (Search). */
  channelNumbers?: boolean;
  compact?: boolean;
  /** Compact only: a muted fourth line (View all: the competition). Defined, even empty, makes the tile MATCH_GRID_H tall. */
  detail?: string;
}) {
  const image = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.logo;
    if (c.type === 'event') return c.event.icon;
    return c.type === 'programme' ? c.hit.channel.logo : undefined;
  };
  const lines = () => wideLines(props.cell, props.now, props.channelNumbers, props.compact === true);
  const tw = () => (props.compact ? COMPACT_W : WIDE_W);
  const th = () => (props.compact ? (props.detail !== undefined ? MATCH_GRID_H : COMPACT_H) : WIDE_H);
  /** On-now programmes show how far along they are. */
  const onAir = () => (props.cell.type === 'programme' && props.cell.when === 'onNow' ? props.cell.hit : undefined);
  let node: ElementNode | undefined;
  // The scale is owned by the motion helper (animated focus scale and OK dip, compact and full alike), never a prop.
  useFocusScale(() => node, () => props.lit);
  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={tw()} height={th()} zIndex={props.lit ? 2 : 1}>
      <FocusRing w={tw()} h={th()} radius={LAYOUT.radius} lit={props.lit} hover={props.hover} />
      <View width={tw()} height={th()} zIndex={1} color={COLORS.surface} borderRadius={LAYOUT.radius} />
      <Show when={props.compact} fallback={<FullBody image={image()} context={lines().context} main={lines().main} onAir={onAir()} now={props.now} />}>
        <CompactBody image={image()} context={lines().context} main={lines().main} sides={lines().sides} detail={props.detail} live={lines().live} h={th()} />
      </Show>
    </View>
  );
}

function FullBody(props: { image: string | undefined; context: string; main: string; onAir: ProgrammeHit | undefined; now: number }) {
  const w = WIDE_W - 2 * PAD;
  const tx = () => (props.image ? LOGO + 14 : 0);
  return (
    <>
      <Show when={props.image} keyed>
        {(u) => <View x={PAD} y={PAD} width={LOGO} height={LOGO} zIndex={2} src={imageSrc(u, LOGO, LOGO)} />}
      </Show>
      <Show when={props.context}>
        <Text x={PAD + tx()} y={PAD + (LOGO - TYPE.meta) / 2 - 2} width={w - tx()} maxWidth={w - tx()}
          contain="width" maxLines={1} zIndex={3} fontSize={TYPE.meta} color={COLORS.muted}>{props.context}</Text>
      </Show>
      <Text x={PAD} y={WIDE_H - PAD - TYPE.meta - 14} width={w} maxWidth={w} contain="width" maxLines={1} zIndex={3}
        fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{props.main}</Text>
      <Show when={props.onAir} keyed>
        {(p) => (
          <View x={PAD} y={WIDE_H - PAD / 2 - TRACK_H} width={w} height={TRACK_H} zIndex={3} color={COLORS.track}>
            <View width={Math.round(w * progressOf(p, props.now))} height={TRACK_H} color={COLORS.accent} />
          </View>
        )}
      </Show>
    </>
  );
}

function CompactBody(props: { image: string | undefined; context: string; main: string; sides: [string, string] | undefined; detail: string | undefined; live: boolean; h: number }) {
  const tx = () => C_PAD + (props.image ? C_LOGO + 14 : 0);
  const w = () => COMPACT_W - C_PAD - tx();
  const line = (y: number, text: string, strong: boolean, maxLines = 1) => (
    <Text x={tx()} y={y} width={w()} maxWidth={w()} contain="width" maxLines={maxLines} zIndex={3}
      fontSize={TYPE.meta} {...(strong ? STRONG : {})} color={strong ? COLORS.text : COLORS.muted}>{text}</Text>
  );
  return (
    <>
      <Show when={props.image} keyed>
        {(u) => <View x={C_PAD} y={(props.h - C_LOGO) / 2} width={C_LOGO} height={C_LOGO} zIndex={2} src={imageSrc(u, C_LOGO, C_LOGO)} />}
      </Show>
      <Show when={props.context} fallback={
        // Only the main line (View all): centred in the tile.
        <Text x={tx()} y={(props.h - TYPE.meta) / 2 - 4} width={w()} maxWidth={w()} contain="width" maxLines={1} zIndex={3}
          fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{props.main}</Text>
      }>
        <Text x={tx()} y={C_LINE1_Y} width={w()} maxWidth={w()} contain="width" maxLines={1} zIndex={3}
          fontSize={TYPE.meta} color={props.live ? COLORS.accent : COLORS.muted}>{props.context}</Text>
        <Show when={props.sides} keyed fallback={line(C_LINE2_Y, props.main, true, 2)}>
          {(s) => <>{line(C_LINE2_Y, s[0], true)}{line(C_LINE3_Y, s[1], true)}</>}
        </Show>
        <Show when={props.detail}>{line(C_LINE4_Y, props.detail ?? '', false)}</Show>
      </Show>
    </>
  );
}
