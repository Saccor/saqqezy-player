import { Show, Text, View } from '@lightningtv/solid';
import type { ChannelRow } from '@iptv/app-api';
import type { SupervisorStatus } from '@iptv/player';
import { formatRange, previewMessage, progressOf } from '../screens/homeLogic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export const PREVIEW_W = 588;
export const PREVIEW_H = Math.round((PREVIEW_W * 9) / 16);

/**
 * Right column. The 16:9 area at the top draws nothing while playing: it is a hole through the transparent
 * canvas onto the `<video>` (Home sets the video rect to the same box). Below: name, now (time + progress)
 * and "Up next".
 */
export function PreviewPanel(props: {
  x: number; y: number;
  channel: ChannelRow | undefined;
  status: SupervisorStatus | undefined;
  playing: boolean;
  now: number;
}) {
  const msg = () => previewMessage(props.playing ? props.status : undefined, props.playing);
  const failed = () => props.playing && props.status?.kind === 'failed';
  const infoY = PREVIEW_H + LAYOUT.gap;
  return (
    <View x={props.x} y={props.y} width={PREVIEW_W} height={PREVIEW_H + 360}>
      <Show when={msg()}>{(m) => (
        <View width={PREVIEW_W} height={PREVIEW_H} borderRadius={LAYOUT.radius}
          color={failed() || !props.playing ? COLORS.surface : COLORS.panel}>
          <Text x={24} y={PREVIEW_H / 2 - FONT.body} width={PREVIEW_W - 48} maxWidth={PREVIEW_W - 48} contain="width"
            maxLines={2} textAlign="center" fontSize={FONT.body} color={failed() ? COLORS.text : COLORS.muted}>{m()}</Text>
        </View>
      )}</Show>
      <Show when={props.channel}>{(c) => (
        <View y={infoY} width={PREVIEW_W} height={340}>
          <Text width={PREVIEW_W} maxWidth={PREVIEW_W} contain="width" maxLines={1} fontSize={FONT.heading}
            color={COLORS.text}>{`${c().number} · ${c().name}`}</Text>
          <Show when={c().now} fallback={
            <Text y={52} fontSize={FONT.body} color={COLORS.muted}>{'No guide information'}</Text>
          }>{(n) => (
            <View y={52} width={PREVIEW_W} height={120}>
              <Text width={PREVIEW_W} maxWidth={PREVIEW_W} contain="width" maxLines={1} fontSize={FONT.body}
                color={COLORS.text}>{n().title}</Text>
              <Text y={38} fontSize={FONT.small} color={COLORS.muted}>{formatRange(n().start, n().stop)}</Text>
              <View y={76} width={PREVIEW_W} height={6} color={0x2a3140ff} borderRadius={3}>
                <View width={Math.round(PREVIEW_W * progressOf(n(), props.now))} height={6} color={COLORS.focus} borderRadius={3} />
              </View>
            </View>
          )}</Show>
          <Show when={c().next}>{(n) => (
            <View y={196} width={PREVIEW_W} height={100}>
              <Text fontSize={FONT.small} color={COLORS.muted}>{'Up next'}</Text>
              <Text y={34} width={PREVIEW_W} maxWidth={PREVIEW_W} contain="width" maxLines={1} fontSize={FONT.body}
                color={COLORS.text}>{`${formatRange(n().start, n().stop)} · ${n().title}`}</Text>
            </View>
          )}</Show>
        </View>
      )}</Show>
    </View>
  );
}
