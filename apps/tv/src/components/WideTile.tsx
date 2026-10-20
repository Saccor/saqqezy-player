import { Show, Text, View } from '@lightningtv/solid';
import type { StartCell } from '@iptv/app-api';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { FocusRing } from './FocusRing.tsx';
import { COLORS, FOCUS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { progressOf } from '../screens/homeLogic.ts';
import { programmeContext, type ProgrammeCell } from '../screens/searchLogic.ts';
import { channelsLabel, eventWhen } from '../screens/startLogic.ts';

export const WIDE_W = 314;
export const WIDE_H = 176;
export const WIDE_GAP = 24;
const PAD = 18;
const LOGO = 56;
const TRACK_H = 4;

/** A Start cell, or a programme from Search's results. */
export type WideCell = StartCell | ProgrammeCell;

/**
 * A landscape tile for a channel, a sports event (Start page) or a programme (Search). Logos and icons come only from
 * the user's own data.
 */
export function WideTile(props: { x: number; y: number; cell: WideCell; lit: boolean; hover?: boolean; now: number }) {
  const image = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.logo;
    if (c.type === 'event') return c.event.icon;
    return c.type === 'programme' ? c.hit.channel.logo : undefined;
  };
  // The bold main line names the thing to watch; the muted line above it gives context (drawn only when non-empty and
  // different from the main line). Channel: name / programme. Event: when · channels / title. Programme: when · channel /
  // title. View all: just the label.
  const contextLine = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.name;
    if (c.type === 'event') return `${eventWhen(c.event, props.now)} · ${channelsLabel(c.event.channelCount)}`;
    if (c.type === 'programme') return programmeContext(c, props.now);
    return '';
  };
  const mainLine = () => {
    const c = props.cell;
    if (c.type === 'channel') return c.channel.now?.title ?? 'No guide information';
    if (c.type === 'event') return c.event.title;
    if (c.type === 'programme') return c.hit.title;
    return c.type === 'viewAll' ? 'View all' : '';
  };
  const w = WIDE_W - 2 * PAD;
  /** On-now programmes show how far along they are. */
  const onAir = () => (props.cell.type === 'programme' && props.cell.when === 'onNow' ? props.cell.hit : undefined);
  return (
    <View x={props.x} y={props.y} width={WIDE_W} height={WIDE_H} scale={props.lit ? FOCUS.scale : 1} zIndex={props.lit ? 2 : 1}>
      <FocusRing w={WIDE_W} h={WIDE_H} radius={LAYOUT.radius} lit={props.lit} hover={props.hover} />
      <View width={WIDE_W} height={WIDE_H} zIndex={1} color={COLORS.surface} borderRadius={LAYOUT.radius} />
      <Show when={image()} keyed>
        {(u) => <View x={PAD} y={PAD} width={LOGO} height={LOGO} zIndex={2} src={rawViaDevProxy(u)} />}
      </Show>
      <Show when={contextLine() && contextLine() !== mainLine()}>
        <Text x={PAD + (image() ? LOGO + 14 : 0)} y={PAD + (LOGO - TYPE.meta) / 2 - 2} width={w - (image() ? LOGO + 14 : 0)} maxWidth={w - (image() ? LOGO + 14 : 0)}
          contain="width" maxLines={1} zIndex={3} fontSize={TYPE.meta} color={COLORS.muted}>{contextLine()}</Text>
      </Show>
      <Text x={PAD} y={WIDE_H - PAD - TYPE.meta - 14} width={w} maxWidth={w} contain="width" maxLines={1} zIndex={3}
        fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{mainLine()}</Text>
      <Show when={onAir()} keyed>
        {(p) => (
          <View x={PAD} y={WIDE_H - PAD / 2 - TRACK_H} width={w} height={TRACK_H} zIndex={3} color={COLORS.track}>
            <View width={Math.round(w * progressOf(p, props.now))} height={TRACK_H} color={COLORS.accent} />
          </View>
        )}
      </Show>
    </View>
  );
}
