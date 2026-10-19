import { Show, Text, View } from '@lightningtv/solid';
import type { StartCell } from '@iptv/app-api';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { channelsLabel, eventWhen } from '../screens/startLogic.ts';

export const WIDE_W = 282;
export const WIDE_H = 159;
export const WIDE_GAP = 24;
const PAD = 16;
const LOGO_H = 64;

/** A landscape tile for a channel or a sports event (Start page). Logos and icons come only from the user's own data. */
export function WideTile(props: { x: number; y: number; cell: StartCell; lit: boolean; hover?: boolean; now: number }) {
  const ring = () => (props.lit ? COLORS.focus : props.hover ? COLORS.muted : undefined);
  const ringW = () => (props.lit ? 4 : 2);
  const image = () => (props.cell.type === 'channel' ? props.cell.channel.logo : props.cell.type === 'event' ? props.cell.event.icon : undefined);
  const line1 = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.name;
    if (c.type === 'event') return c.event.title;
    return c.type === 'viewAll' ? `See all (${c.total})` : '';
  };
  const line2 = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.now?.title ?? 'No guide information';
    if (c.type === 'event') return `${eventWhen(c.event, props.now)} · ${channelsLabel(c.event.channelCount)}`;
    return '';
  };
  const live = () => props.cell.type === 'event' && eventWhen(props.cell.event, props.now) === 'Live';
  const star = () => props.cell.type === 'event' && props.cell.event.followed;
  const w = WIDE_W - 2 * PAD;
  return (
    <View x={props.x} y={props.y} width={WIDE_W} height={WIDE_H} scale={props.lit ? 1.06 : 1} zIndex={props.lit ? 2 : 1}>
      <Show when={ring()}>
        {(c) => (
          <View x={-ringW()} y={-ringW()} width={WIDE_W + ringW() * 2} height={WIDE_H + ringW() * 2} zIndex={0}
            borderRadius={LAYOUT.radius + ringW()} color={c()} />
        )}
      </Show>
      <View width={WIDE_W} height={WIDE_H} zIndex={1} color={COLORS.surface} borderRadius={LAYOUT.radius} />
      <Show when={image()} keyed>
        {(u) => <View x={PAD} y={PAD} width={LOGO_H * 1.6} height={LOGO_H} zIndex={2} src={rawViaDevProxy(u)} />}
      </Show>
      <Show when={live()}>
        <View x={WIDE_W - PAD - 64} y={PAD} width={64} height={30} zIndex={3} borderRadius={15} color={0xd93b3bff}>
          <Text y={4} width={64} textAlign="center" fontSize={18} color={COLORS.onFocus}>Live</Text>
        </View>
      </Show>
      <Show when={star()}>
        <Text x={WIDE_W - PAD - (live() ? 100 : 28)} y={PAD} zIndex={3} fontSize={FONT.small} color={COLORS.focus}>★</Text>
      </Show>
      <Text x={PAD} y={WIDE_H - PAD - 64} width={w} maxWidth={w} contain="width" maxLines={1} zIndex={3} fontSize={FONT.body} color={COLORS.text}>{line1()}</Text>
      <Text x={PAD} y={WIDE_H - PAD - 28} width={w} maxWidth={w} contain="width" maxLines={1} zIndex={3} fontSize={FONT.small} color={COLORS.muted}>{line2()}</Text>
    </View>
  );
}
