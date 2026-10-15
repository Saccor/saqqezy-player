import { Show, Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { formatRange, progressOf } from '../screens/homeLogic.ts';
import { formatClock } from '../shell/logic.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { logoCache } from './logoCache.ts';

export const BANNER_H = 250;
const BANNER_W = LAYOUT.width - LAYOUT.safeX * 2;
const PAD = 28;
const NUM_W = 130;
const LOGO_W = 150;
const LOGO_H = 90;
const TEXT_X = PAD + NUM_W + LAYOUT.gap + LOGO_W + LAYOUT.gap;
const CLOCK_W = 140;
const TEXT_W = BANNER_W - TEXT_X - PAD - CLOCK_W - LAYOUT.gap;
const BAR_W = 520;
const TRACK = 0x2a3140ff;

function BannerLogo(props: { url: string | undefined }) {
  const [failed, setFailed] = createSignal(false);
  const usable = () => !failed() && logoCache.usable(props.url);
  return (
    <View x={PAD + NUM_W + LAYOUT.gap} y={PAD} width={LOGO_W} height={LOGO_H} borderRadius={LAYOUT.radius} color={COLORS.surface}>
      <Show when={usable() ? props.url : undefined} keyed>
        {(url) => {
          logoCache.touch(url);
          return (
            <View x={6} y={6} width={LOGO_W - 12} height={LOGO_H - 12} src={rawViaDevProxy(url)}
              onEvent={{ failed: () => { logoCache.markFailed(url); setFailed(true); } }} />
          );
        }}
      </Show>
    </View>
  );
}

/**
 * Bottom info banner over the video: number, logo, name, now (time range + progress), next, and the clock, and the live pill.
 * Purely visual; the Player decides when it is shown.
 */
export function InfoBanner(props: {
  channel: ChannelRow; now: number; showClock: boolean; live?: { text: string; hint?: string };
  /** Moves the banner up by this many px (the Player's pointer row is showing below it). */
  lift?: number;
}) {
  const c = () => props.channel;
  return (
    <View x={LAYOUT.safeX} y={LAYOUT.height - LAYOUT.safeY - BANNER_H - (props.lift ?? 0)} width={BANNER_W} height={BANNER_H}
      color={COLORS.osd} borderRadius={LAYOUT.radius * 2} zIndex={5}>
      <View x={PAD} y={PAD} width={NUM_W} height={LOGO_H} borderRadius={LAYOUT.radius} color={COLORS.focus}>
        <Text y={(LOGO_H - FONT.title) / 2 - 2} width={NUM_W} maxWidth={NUM_W} contain="width" textAlign="center"
          fontSize={FONT.title} color={COLORS.onFocus}>{`${c().number}`}</Text>
      </View>
      <Show when={c().logo} keyed>{(url) => <BannerLogo url={url} />}</Show>
      <Text x={TEXT_X} y={PAD} width={TEXT_W} maxWidth={TEXT_W} contain="width" maxLines={1}
        fontSize={FONT.title} color={COLORS.text}>{c().name}</Text>
      <Show when={props.showClock}>
        <Text x={BANNER_W - PAD - CLOCK_W} y={PAD + 8} width={CLOCK_W} maxWidth={CLOCK_W} contain="width" textAlign="right"
          fontSize={FONT.heading} color={COLORS.text}>{formatClock(new Date(props.now))}</Text>
      </Show>
      <Show when={props.live} keyed>{(l) => (
        <View x={BANNER_W - PAD - CLOCK_W} y={PAD + 76} width={CLOCK_W} height={110}>
          <Text width={CLOCK_W} maxWidth={CLOCK_W} contain="width" textAlign="right" maxLines={1}
            fontSize={FONT.body} color={l.hint ? COLORS.text : COLORS.focus}>{l.text}</Text>
          <Show when={l.hint}>
            <Text y={44} width={CLOCK_W} maxWidth={CLOCK_W} contain="width" textAlign="right" maxLines={1}
              fontSize={FONT.small} color={COLORS.muted}>{l.hint}</Text>
          </Show>
        </View>
      )}</Show>
      <Show when={c().now} keyed fallback={
        <Text x={TEXT_X} y={PAD + 76} fontSize={FONT.body} color={COLORS.muted}>{'No guide information'}</Text>
      }>{(n) => (
        <View x={TEXT_X} y={PAD + 76} width={TEXT_W} height={70}>
          <Text width={TEXT_W - BAR_W - LAYOUT.gap} maxWidth={TEXT_W - BAR_W - LAYOUT.gap} contain="width" maxLines={1}
            fontSize={FONT.body} color={COLORS.text}>{`Now · ${n.title}`}</Text>
          <Text y={38} fontSize={FONT.small} color={COLORS.muted}>{formatRange(n.start, n.stop)}</Text>
          <View x={TEXT_W - BAR_W} y={12} width={BAR_W} height={8} color={TRACK} borderRadius={4}>
            <View width={Math.round(BAR_W * progressOf(n, props.now))} height={8} color={COLORS.focus} borderRadius={4} />
          </View>
        </View>
      )}</Show>
      <Show when={c().next} keyed>{(n) => (
        <Text x={TEXT_X} y={PAD + 160} width={TEXT_W} maxWidth={TEXT_W} contain="width" maxLines={1}
          fontSize={FONT.body} color={COLORS.muted}>{`Next · ${formatRange(n.start, n.stop)} · ${n.title}`}</Text>
      )}</Show>
    </View>
  );
}
