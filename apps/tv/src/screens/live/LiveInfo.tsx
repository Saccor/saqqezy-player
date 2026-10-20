import { Show, Text, View } from '@lightningtv/solid';
import type { ChannelRow } from '@iptv/app-api';
import { COLORS, LAYOUT, STRONG, TYPE } from '../../shell/theme.ts';
import { NO_INFO, isOnAir, type Block } from '../guideLogic.ts';
import { formatRange, progressOf } from '../homeLogic.ts';
import { INFO_W, INFO_X, timeLeftLabel } from './liveLogic.ts';

const TITLE_Y = 36;
const TIME_Y = 94;
const DESC_Y = 134;
const DESC_LINE_H = 34;
/** Expanded details end at y 54 + 134 + 3 × 34 = 290, clear of the ruler at 312. */
const DESC_LINES_EXPANDED = 3;
/** "20:00–21:30" at meta size is about 132 px wide: the progress track starts after it. */
const TRACK_X = 152;
const TRACK_W = 160;
const TRACK_H = 4;
const LEFT_X = TRACK_X + TRACK_W + 16;

/**
 * The focused programme, right of the mini video: "{number} · {channel}", the title, the time range (with progress
 * and time left while it is on air) and the description (2 lines, 3 when `expanded`). With no block it shows the
 * channel's `now` when the row carries one, else the guide's "No information" with no time line. The screen feeds
 * it through `dwellSignal`, so holding a key does not rewrite it on every step.
 */
export function LiveInfo(props: { block?: Block; channel?: ChannelRow; now: number; expanded?: boolean }) {
  /** The programme shown: a real block, else the row's now; a filler counts as none. */
  const prog = () => {
    const b = props.block;
    if (b && !b.filler) return b;
    if (!b) return props.channel?.now;
    return undefined;
  };
  const channelLine = () => {
    const c = props.channel;
    return c ? `${c.number} · ${c.name}` : '';
  };
  const onAir = () => {
    const p = prog();
    return p !== undefined && isOnAir(p, props.now);
  };
  return (
    <View x={INFO_X} y={LAYOUT.safeY} width={INFO_W} height={DESC_Y + DESC_LINE_H * DESC_LINES_EXPANDED}>
      <Text width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={TYPE.meta}
        color={COLORS.muted}>{channelLine()}</Text>
      <Text y={TITLE_Y} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={TYPE.title} {...STRONG}
        color={COLORS.text}>{prog()?.title ?? NO_INFO}</Text>
      <Show when={prog()}>{(p) => (
        <View y={TIME_Y} width={INFO_W} height={DESC_Y - TIME_Y}>
          <Text width={TRACK_X} maxWidth={TRACK_X} contain="width" maxLines={1} fontSize={TYPE.meta}
            color={COLORS.muted}>{formatRange(p().start, p().stop)}</Text>
          <Show when={onAir()}>
            <View x={TRACK_X} y={(TYPE.meta - TRACK_H) / 2 + 2} width={TRACK_W} height={TRACK_H} color={COLORS.track}
              borderRadius={TRACK_H / 2}>
              <View width={Math.round(TRACK_W * progressOf(p(), props.now))} height={TRACK_H} color={COLORS.accent}
                borderRadius={TRACK_H / 2} />
            </View>
            <Text x={LEFT_X} width={INFO_W - LEFT_X} maxWidth={INFO_W - LEFT_X} contain="width" maxLines={1}
              fontSize={TYPE.meta} color={COLORS.muted}>{timeLeftLabel(p().stop, props.now)}</Text>
          </Show>
        </View>
      )}</Show>
      <Text y={DESC_Y} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={props.expanded ? DESC_LINES_EXPANDED : 2}
        lineHeight={DESC_LINE_H} fontSize={TYPE.meta} color={COLORS.textSecondary}>{prog()?.desc ?? ''}</Text>
    </View>
  );
}
