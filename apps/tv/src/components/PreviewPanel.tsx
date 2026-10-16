import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import type { ChannelRow } from '@iptv/app-api';
import type { SupervisorStatus } from '@iptv/player';
import { usePointerTarget } from '../input/pointer.ts';
import { CooldownNotice } from './CooldownNotice.tsx';
import { formatRange, previewMessage, progressOf } from '../screens/homeLogic.ts';
import { activeMaxConnections } from '../state/activeLimit.ts';
import { MESSAGE_BOXES, messageTop } from './messageFit.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

export const PREVIEW_W = 588;
export const PREVIEW_H = Math.round((PREVIEW_W * 9) / 16);
const STARTING_W = 140;

/**
 * Right column. The 16:9 area at the top draws nothing while playing: it is a hole through the transparent
 * canvas onto the `<video>` (Home sets the video rect to the same box). Below: name, now (time + progress)
 * and "Up next" for `channel` (Home passes the playing channel, or the focused one while its preview is
 * `starting`, which adds a subtle "Starting…" next to the name). A pointer click on the video box calls
 * `onVideoClick`; hover shows nothing.
 */
export function PreviewPanel(props: {
  x: number; y: number;
  channel: ChannelRow | undefined;
  starting?: boolean;
  status: SupervisorStatus | undefined;
  playing: boolean;
  /** Shown in the empty video box instead of "Preview" while nothing plays (Home: paused after a reload). */
  idle?: string;
  now: number;
  onVideoClick?: () => void;
  /** The source is cooling down: this copy fills the video box instead of any status message. */
  cooldown?: { text: string; hint: string };
  onRetry?: () => void;
}) {
  let video: ElementNode | undefined;
  usePointerTarget({ node: () => video, enabled: () => props.onVideoClick !== undefined, onClick: () => props.onVideoClick?.() });
  const msg = () => previewMessage(props.playing ? props.status : undefined, props.playing, props.idle, activeMaxConnections());
  const failed = () => props.playing && props.status?.kind === 'failed';
  const infoY = PREVIEW_H + LAYOUT.gap;
  const titleW = () => (props.starting ? PREVIEW_W - STARTING_W - LAYOUT.gap : PREVIEW_W);
  return (
    <View x={props.x} y={props.y} width={PREVIEW_W} height={PREVIEW_H + 360}>
      {/* The video box's click area. No colour: it draws nothing. */}
      <View ref={(el) => { video = el; }} width={PREVIEW_W} height={PREVIEW_H} />
      <Show when={props.cooldown}>{(c) => (
        <CooldownNotice width={PREVIEW_W} height={PREVIEW_H} text={c().text} hint={c().hint}
          onRetry={() => props.onRetry?.()} />
      )}</Show>
      <Show when={props.cooldown ? undefined : msg()}>{(m) => (
        <View width={PREVIEW_W} height={PREVIEW_H} borderRadius={LAYOUT.radius}
          color={failed() || !props.playing ? COLORS.surface : COLORS.panel}>
          <Text x={24} y={messageTop(m(), MESSAGE_BOXES.preview, PREVIEW_H)} width={PREVIEW_W - 48} maxWidth={PREVIEW_W - 48}
            contain="width" maxLines={MESSAGE_BOXES.preview.maxLines} lineHeight={MESSAGE_BOXES.preview.lineH} textAlign="center" fontSize={FONT.body} color={failed() ? COLORS.text : COLORS.muted}>{m()}</Text>
        </View>
      )}</Show>
      <Show when={props.channel}>{(c) => (
        <View y={infoY} width={PREVIEW_W} height={340}>
          <Text width={titleW()} maxWidth={titleW()} contain="width" maxLines={1} fontSize={FONT.heading}
            color={COLORS.text}>{`${c().number} · ${c().name}`}</Text>
          <Show when={props.starting}>
            <Text x={PREVIEW_W - STARTING_W} y={(FONT.heading - FONT.small) / 2} width={STARTING_W} maxWidth={STARTING_W}
              contain="width" maxLines={1} textAlign="right" fontSize={FONT.small} color={COLORS.muted}>{'Starting…'}</Text>
          </Show>
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
