import { Show, Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { monogram } from '../screens/guideLogic.ts';
import { bannerNextLine, NO_GUIDE_INFO, progressOf } from '../screens/homeLogic.ts';
import { formatClock } from '../shell/logic.ts';
import { BACKGROUND_RGB, COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { iconTexture } from '../vod/icons.ts';
import { scrimTexture } from '../vod/scrim.ts';
import { logoCache } from './logoCache.ts';
import { logoKey } from './logoKey.ts';

/** The banner's band: its text and progress, from the bottom safe edge up. */
export const BANNER_H = 210;
const BANNER_W = LAYOUT.width - LAYOUT.safeX * 2;
/** The fade behind the band: from the screen's bottom edge up this far (plus the pointer lift). */
const FADE_H = 460;
const TOP = 16;
const LOGO = 96;
const TEXT_X = LOGO + LAYOUT.gap;
const TEXT_W = BANNER_W - TEXT_X;
/** The right column of line 1 and below it: the clock, then the live pill and its hint. */
const RIGHT_W = 220;
const LINE1_Y = TOP;
const TITLE_Y = TOP + 38;
const TITLE_H = 56;
const ICON = 20;
const PROGRESS_Y = TOP + 110;
const TIME_W = 80;
const TRACK_H = 4;
const NEXT_Y = TOP + 150;
/** About the width of a semibold digit at body size (the number and the name share line 1). */
const DIGIT_W = Math.ceil(TYPE.body * 0.62);

function BannerLogo(props: { url: string | undefined; name: string }) {
  const [failedUrl, setFailedUrl] = createSignal<string | undefined>(undefined);
  const key = () => logoKey(props.url, failedUrl(), (u) => logoCache.usable(u));
  return (
    <View y={TOP} width={LOGO} height={LOGO} borderRadius={LAYOUT.radius} color={COLORS.surfaceRaised}>
      {/* No logo in the user's own data: a tile with two initials. */}
      <Show when={key() === undefined}>
        <Text y={(LOGO - TYPE.title) / 2 - 2} width={LOGO} maxWidth={LOGO} contain="width" textAlign="center" maxLines={1}
          fontSize={TYPE.title} color={COLORS.muted} {...STRONG}>{monogram(props.name)}</Text>
      </Show>
      <Show when={key()} keyed>
        {(url) => {
          logoCache.touch(url);
          return (
            <View width={LOGO} height={LOGO} borderRadius={LAYOUT.radius} src={rawViaDevProxy(url)}
              onEvent={{ failed: () => { logoCache.markFailed(url); setFailedUrl(url); } }} />
          );
        }}
      </Show>
    </View>
  );
}

/**
 * Bottom info band over the video, on a fade rather than a panel: the logo, then "number channel" with the clock,
 * the programme title (the live pill and its hint at the right), a full-width progress track between the start and
 * end times, and the next programme. Purely visual; the Player decides when it is shown.
 */
export function InfoBanner(props: {
  channel: ChannelRow; now: number; showClock: boolean; live?: { text: string; hint?: string };
  /** Moves the banner up by this many px (the Player's pointer row is showing below it). */
  lift?: number;
}) {
  const c = () => props.channel;
  const lift = () => props.lift ?? 0;
  const bandY = () => LAYOUT.height - LAYOUT.safeY - BANNER_H - lift();
  const numW = () => String(c().number).length * DIGIT_W;
  const nameX = () => TEXT_X + numW() + LAYOUT.gap / 2;
  const nameW = () => BANNER_W - nameX() - (props.showClock ? RIGHT_W + LAYOUT.gap : 0);
  const archive = () => c().archiveDays !== undefined;
  const titleX = () => TEXT_X + (archive() ? ICON + 12 : 0);
  const titleW = () => BANNER_W - titleX() - (props.live ? RIGHT_W + LAYOUT.gap : 0);
  const trackX = TEXT_X + TIME_W + LAYOUT.gap / 2;
  const trackW = BANNER_W - trackX - TIME_W - LAYOUT.gap / 2;
  return (
    <View x={LAYOUT.safeX} y={bandY()} width={BANNER_W} height={BANNER_H} zIndex={5}>
      {/* The fade reaches the screen's bottom edge and grows with the lift, so the pointer row sits on it too. */}
      <View x={-LAYOUT.safeX} y={LAYOUT.height - FADE_H - lift() - bandY()} width={LAYOUT.width} height={FADE_H + lift()}
        src={scrimTexture('banner', BACKGROUND_RGB)} />
      <BannerLogo url={c().logo} name={c().name} />

      <Text x={TEXT_X} y={LINE1_Y} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{`${c().number}`}</Text>
      <Text x={nameX()} y={LINE1_Y} width={nameW()} maxWidth={nameW()} contain="width" maxLines={1}
        fontSize={TYPE.body} color={COLORS.textSecondary}>{c().name}</Text>
      <Show when={props.showClock}>
        <Text x={BANNER_W - RIGHT_W} y={LINE1_Y} width={RIGHT_W} maxWidth={RIGHT_W} contain="width" textAlign="right"
          maxLines={1} fontSize={TYPE.body} color={COLORS.text}>{formatClock(new Date(props.now))}</Text>
      </Show>
      <Show when={props.live} keyed>{(l) => (
        <View x={BANNER_W - RIGHT_W} y={TITLE_Y + 4} width={RIGHT_W} height={64}>
          <Text width={RIGHT_W} maxWidth={RIGHT_W} contain="width" textAlign="right" maxLines={1}
            fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{l.text}</Text>
          <Show when={l.hint}>
            <Text y={32} width={RIGHT_W} maxWidth={RIGHT_W} contain="width" textAlign="right" maxLines={1}
              fontSize={TYPE.meta} color={COLORS.muted}>{l.hint}</Text>
          </Show>
        </View>
      )}</Show>

      <Show when={c().now} keyed fallback={
        <Text x={TEXT_X} y={TITLE_Y} width={BANNER_W - TEXT_X - (props.live ? RIGHT_W + LAYOUT.gap : 0)}
          maxWidth={BANNER_W - TEXT_X - (props.live ? RIGHT_W + LAYOUT.gap : 0)} contain="width" maxLines={1}
          fontSize={TYPE.playerTitle} {...STRONG} color={COLORS.textSecondary}>{NO_GUIDE_INFO}</Text>
      }>{(n) => (
        <>
          {/* Catch-up channel: the programme on now can play from its start (Options → From the start). */}
          <Show when={archive()}>
            <View x={TEXT_X} y={TITLE_Y + (TITLE_H - ICON) / 2} width={ICON} height={ICON} src={iconTexture('archive')}
              color={COLORS.muted} />
          </Show>
          <Text x={titleX()} y={TITLE_Y} width={titleW()} maxWidth={titleW()} contain="width" maxLines={1}
            fontSize={TYPE.playerTitle} {...STRONG} color={COLORS.text}>{n.title}</Text>
          <Text x={TEXT_X} y={PROGRESS_Y} width={TIME_W} maxWidth={TIME_W} contain="width" maxLines={1}
            fontSize={TYPE.meta} color={COLORS.muted}>{formatClock(new Date(n.start))}</Text>
          <View x={trackX} y={PROGRESS_Y + (TYPE.meta * 1.2 - TRACK_H) / 2} width={trackW} height={TRACK_H}
            color={COLORS.track} borderRadius={TRACK_H / 2}>
            <View width={Math.round(trackW * progressOf(n, props.now))} height={TRACK_H} color={COLORS.text}
              borderRadius={TRACK_H / 2} />
          </View>
          <Text x={BANNER_W - TIME_W} y={PROGRESS_Y} width={TIME_W} maxWidth={TIME_W} contain="width" textAlign="right"
            maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{formatClock(new Date(n.stop))}</Text>
        </>
      )}</Show>
      <Show when={bannerNextLine(c().next)}>{(line) => (
        <Text x={TEXT_X} y={c().now ? NEXT_Y : PROGRESS_Y} width={TEXT_W} maxWidth={TEXT_W} contain="width" maxLines={1}
          fontSize={TYPE.meta} color={COLORS.muted}>{line()}</Text>
      )}</Show>
    </View>
  );
}
