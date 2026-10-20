import { Show, Text, View } from '@lightningtv/solid';
import type { StartCell } from '@iptv/app-api';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { FocusRing } from './FocusRing.tsx';
import { COLORS, FOCUS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { channelsLabel, eventWhen } from '../screens/startLogic.ts';

export const WIDE_W = 314;
export const WIDE_H = 176;
export const WIDE_GAP = 24;
const PAD = 18;
const LOGO = 56;

/** A landscape tile for a channel or a sports event (Start page). Logos and icons come only from the user's own data. */
export function WideTile(props: { x: number; y: number; cell: StartCell; lit: boolean; hover?: boolean; now: number }) {
  const image = () => (props.cell.type === 'channel' ? props.cell.channel.logo : props.cell.type === 'event' ? props.cell.event.icon : undefined);
  const line1 = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.name;
    if (c.type === 'event') return c.event.title;
    return c.type === 'viewAll' ? 'View all' : '';
  };
  const line2 = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.now?.title ?? 'No guide information';
    if (c.type === 'event') return `${eventWhen(c.event, props.now)} · ${channelsLabel(c.event.channelCount)}`;
    return '';
  };
  const w = WIDE_W - 2 * PAD;
  return (
    <View x={props.x} y={props.y} width={WIDE_W} height={WIDE_H} scale={props.lit ? FOCUS.scale : 1} zIndex={props.lit ? 2 : 1}>
      <FocusRing w={WIDE_W} h={WIDE_H} radius={LAYOUT.radius} lit={props.lit} hover={props.hover} />
      <View width={WIDE_W} height={WIDE_H} zIndex={1} color={COLORS.surface} borderRadius={LAYOUT.radius} />
      <Show when={image()} keyed>
        {(u) => <View x={PAD} y={PAD} width={LOGO} height={LOGO} zIndex={2} src={rawViaDevProxy(u)} />}
      </Show>
      <Text x={PAD + (image() ? LOGO + 14 : 0)} y={PAD + (LOGO - TYPE.meta) / 2 - 2} width={w - (image() ? LOGO + 14 : 0)} maxWidth={w - (image() ? LOGO + 14 : 0)}
        contain="width" maxLines={1} zIndex={3} fontSize={TYPE.meta} color={COLORS.muted}>{line1()}</Text>
      <Text x={PAD} y={WIDE_H - PAD - TYPE.meta - 14} width={w} maxWidth={w} contain="width" maxLines={1} zIndex={3}
        fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{line2() || line1()}</Text>
    </View>
  );
}
