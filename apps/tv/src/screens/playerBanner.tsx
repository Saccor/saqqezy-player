import { Show, Text, View } from '@lightningtv/solid';
import type { ChannelRow } from '@iptv/app-api';
import { BADGE_H, BadgeRow } from '../components/Badge.tsx';
import { InfoBlock } from '../components/InfoBlock.tsx';
import { Tile } from '../components/Tile.tsx';
import { LOGO_TILE } from '../components/tileLogic.ts';
import { formatClock } from '../shell/logic.ts';
import { BACKGROUND_RGB, COLORS, LAYOUT, LINE, SPACE, STRONG, TYPE } from '../shell/theme.ts';
import { iconTexture } from '../vod/icons.ts';
import { scrimTexture } from '../vod/scrim.ts';
import { bannerNextLine, NO_GUIDE_INFO, progressOf } from './homeLogic.ts';

/** The banner's band: its text and progress, from the bottom safe edge up. */
const BANNER_H = 210;
const BANNER_W = LAYOUT.width - LAYOUT.safeX * 2;
/** The fade behind the band: from the screen's bottom edge up this far (plus the pointer lift). */
const FADE_H = 460;
const TOP = SPACE.m;
const TEXT_X = LOGO_TILE + LAYOUT.gap;
const TEXT_W = BANNER_W - TEXT_X;
/** The right column: the clock, then the live pill and its hint. */
const RIGHT_W = 220;
/** The media badges' room, right-aligned on the channel line. */
const BADGES_W = Math.round(TEXT_W / 2);
const TITLE_Y = TOP + LINE.meta + SPACE.s;

/**
 * Bottom info band over the video, on a fade rather than a panel: the channel logo, then an InfoBlock (channel line,
 * programme title, start time with a progress track and the end time, the next programme), the clock, the live pill
 * and its hint at the right, and what is playing as badges. Purely visual; the Player decides when it is shown.
 */
export function PlayerBanner(props: {
  channel: ChannelRow; now: number; showClock: boolean; live?: { text: string; hint?: string };
  /** Moves the banner up by this many px (the Player's pointer row is showing below it). */
  lift?: number;
  /** What is playing (`mediaBadges`), at the right of the channel line. */
  badges?: readonly string[];
}) {
  const c = () => props.channel;
  const lift = () => props.lift ?? 0;
  const bandY = () => LAYOUT.height - LAYOUT.safeY - BANNER_H - lift();
  const rightCol = () => (props.showClock || props.live ? RIGHT_W + LAYOUT.gap : 0);
  const badgesRight = () => BANNER_W - (props.showClock ? RIGHT_W + LAYOUT.gap : 0);
  const archive = () => c().archiveDays !== undefined;
  return (
    <View x={LAYOUT.safeX} y={bandY()} width={BANNER_W} height={BANNER_H} zIndex={5}>
      {/* The fade reaches the screen's bottom edge and grows with the lift, so the pointer row sits on it too. */}
      <View x={-LAYOUT.safeX} y={LAYOUT.height - FADE_H - lift() - bandY()} width={LAYOUT.width} height={FADE_H + lift()}
        src={scrimTexture('banner', BACKGROUND_RGB)} />
      <Tile variant="logo" x={0} y={TOP} url={c().logo} name={c().name} lit={false} />

      <InfoBlock x={TEXT_X} y={TOP} width={TEXT_W - rightCol()}
        overline={`${c().number}  ${c().name}`} title={c().now?.title ?? NO_GUIDE_INFO}
        titleIcon={c().now && archive() ? iconTexture('archive') : undefined}
        meta={c().now ? formatClock(new Date(c().now!.start)) : undefined}
        progress={c().now ? progressOf(c().now!, props.now) : undefined}
        trailing={c().now ? formatClock(new Date(c().now!.stop)) : undefined}
        description={c().next ? bannerNextLine(c().next!) : undefined} />

      <Show when={props.showClock}>
        <Text x={BANNER_W - RIGHT_W} y={TOP} width={RIGHT_W} maxWidth={RIGHT_W} contain="width" textAlign="right"
          maxLines={1} fontSize={TYPE.body} color={COLORS.text}>{formatClock(new Date(props.now))}</Text>
      </Show>
      <Show when={props.live} keyed>{(l) => (
        <View x={BANNER_W - RIGHT_W} y={TITLE_Y + SPACE.s} width={RIGHT_W} height={LINE.title + LINE.meta}>
          <Text width={RIGHT_W} maxWidth={RIGHT_W} contain="width" textAlign="right" maxLines={1}
            fontSize={TYPE.meta} {...STRONG} color={COLORS.text}>{l.text}</Text>
          <Show when={l.hint}>
            <Text y={LINE.meta} width={RIGHT_W} maxWidth={RIGHT_W} contain="width" textAlign="right" maxLines={1}
              fontSize={TYPE.meta} color={COLORS.muted}>{l.hint}</Text>
          </Show>
        </View>
      )}</Show>
      {/* What is playing ("1080p · 50 fps · H.264 · Stereo AAC"): right-aligned on the channel line, left of the clock. */}
      <BadgeRow x={badgesRight() - BADGES_W} y={TOP + (LINE.meta - BADGE_H) / 2} maxWidth={BADGES_W} badges={props.badges ?? []} align="right" />
    </View>
  );
}
