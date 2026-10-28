/**
 * What the VOD player draws over the video: the subtitle cue (outlined, lifted above the controls while they show) and
 * the controls' band (title, badges, timeline, times, the control row and the desktop volume).
 */
import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo } from 'solid-js';
import type { CatchupPlayable } from '@iptv/app-api';
import { ActionBar, type Action } from '../../components/ActionBar.tsx';
import { BadgeRow } from '../../components/Badge.tsx';
import { BUTTON_H } from '../../components/Button.tsx';
import { InfoBlock } from '../../components/InfoBlock.tsx';
import { Timeline, TIMELINE_H } from '../../components/Timeline.tsx';
import { VolumeControl } from '../../components/VolumeOsd.tsx';
import { PLAYER_COPY, VOD_COPY } from '../../copy.ts';
import { pointerMode } from '../../input/pointer.ts';
import { SHELL_BACK_LABEL } from '../../shell/logic.ts';
import { BACKGROUND_RGB, COLORS, LAYOUT, LINE, RADIUS, TYPE } from '../../shell/theme.ts';
import { volumeSupported } from '../../video/volume.ts';
import { seekLimitMs } from '../../vod/catchupLogic.ts';
import { iconTexture } from '../../vod/icons.ts';
import { scrimTexture } from '../../vod/scrim.ts';
import type { Scrub } from '../../vod/seekLogic.ts';
import { elapsedText, groupXs, remainingText } from '../../vod/timelineLogic.ts';
import {
  ACTIONS_Y, BACK_W, BADGES_LABEL_Y, BAND_H, BAND_Y, CATCHUP_H, CATCHUP_W, CONTENT_W, CONTENT_X, LABEL_Y, NEXT_W, OPTIONS_W, ROUND_W,
  SUB_OUTLINE, SUB_OUTLINE_COLOR, TIMELINE_Y, TIMES_Y, TIME_W, TITLE_Y, TRACKS_W, VOLUME_W, liveEdgeX,
} from './layout.ts';

/** The subtitle cue: above the video, below the overlay; lifted above the band while it shows. */
export function SubtitleCue(props: { cue: string; overlayShown: boolean }) {
  const subLines = () => props.cue.split('\n').length;
  const subY = () => (props.overlayShown ? TITLE_Y - LAYOUT.gap : LAYOUT.height - LAYOUT.safeY - 20) - subLines() * LINE.title;
  return (
    // A dark outline (offset copies) keeps the text readable on bright pictures without a font shadow.
    <Show when={props.cue}>
      <View zIndex={5}>
        <For each={SUB_OUTLINE}>{([dx, dy]) => (
          <Text x={CONTENT_X + dx} y={subY() + dy} width={CONTENT_W} maxWidth={CONTENT_W} contain="width" textAlign="center"
            maxLines={3} fontSize={TYPE.title} lineHeight={LINE.title} color={SUB_OUTLINE_COLOR}>{props.cue}</Text>
        )}</For>
        <Text x={CONTENT_X} y={subY()} width={CONTENT_W} maxWidth={CONTENT_W} contain="width" textAlign="center"
          maxLines={3} fontSize={TYPE.title} lineHeight={LINE.title} color={COLORS.text}>{props.cue}</Text>
      </View>
    </Show>
  );
}

/**
 * The controls' band while it shows. The control row is one focus row in three groups: pointer Back and the volume on
 * the left (the shell's Back pill would sit on the row, so it is off here), the transport icons centred, the track and
 * episode buttons on the right. The volume is pointer-only (the keyboard has + and -): it takes its place in the left
 * group but is no focus stop.
 */
export function VodControls(props: {
  visible: boolean;
  title: string;
  /** The episode label ('' for a movie). */
  label: string;
  badges: string[];
  posMs: number;
  durMs: number | undefined;
  bufferedEndMs: number | undefined;
  scrub: Scrub | undefined;
  now: number;
  paused: boolean;
  hasNext: boolean;
  /** Catch-up: the programme playing (its live edge shows while it is on air), with the timeline's length. */
  catchup: CatchupPlayable | undefined;
  catchupDurMs: number | undefined;
  timelineRef: (el: ElementNode) => void;
  barRef: (el: ElementNode) => void;
  onScrubKey: (key: 'Left' | 'Right') => boolean;
  onTimelineEnter: () => boolean;
  onTimelineDown: () => boolean;
  onTimelineFocus: (focused: boolean) => void;
  onPointerSeek: (fraction: number) => void;
  onDrag: (fraction: number, phase: 'start' | 'move' | 'end' | 'cancel') => void;
  /** Any pointer activity on the band keeps it up. */
  onActive: () => void;
  onAction: (id: string) => void;
  onBarUp: () => boolean;
  onBarFocus: (focused: boolean) => void;
}) {
  const row = createMemo(() => {
    const left: Action[] = pointerMode() ? [{ id: 'back', label: SHELL_BACK_LABEL, width: BACK_W }] : [];
    const centre: Action[] = [
      { id: 'back30', label: VOD_COPY.back30, width: ROUND_W, round: true, icon: iconTexture('back30') },
      { id: 'back10', label: VOD_COPY.back10, width: ROUND_W, round: true, icon: iconTexture('back10') },
      { id: 'toggle', label: props.paused ? 'Play' : 'Pause', width: ROUND_W, round: true, icon: iconTexture(props.paused ? 'play' : 'pause') },
      { id: 'fwd10', label: VOD_COPY.forward10, width: ROUND_W, round: true, icon: iconTexture('fwd10') },
      { id: 'fwd30', label: VOD_COPY.forward30, width: ROUND_W, round: true, icon: iconTexture('fwd30') },
    ];
    const right: Action[] = [
      { id: 'tracks', label: VOD_COPY.subtitles, width: TRACKS_W },
      { id: 'options', label: PLAYER_COPY.options, width: OPTIONS_W, round: true, icon: iconTexture('gear') },
      ...(props.hasNext ? [{ id: 'next', label: VOD_COPY.nextEpisode, width: NEXT_W }] : []),
    ];
    const leftWs = [...left.map((a) => a.width), ...(volumeSupported ? [VOLUME_W] : [])];
    const xs = groupXs(CONTENT_W, 16, leftWs, centre.map((a) => a.width), right.map((a) => a.width));
    const volumeX = volumeSupported ? xs[left.length] : undefined;
    const rest = xs.slice(leftWs.length);
    const actions: Action[] = [
      ...left.map((a, i) => ({ ...a, x: xs[i] })),
      ...[...centre, ...right].map((a, i) => ({ ...a, x: rest[i] })),
    ];
    return { actions, volumeX };
  });

  return (
    <Show when={props.visible}>
      <View zIndex={10} width={LAYOUT.width} height={LAYOUT.height}>
        <View y={BAND_Y} width={LAYOUT.width} height={BAND_H} src={scrimTexture('player', BACKGROUND_RGB)} />
        <InfoBlock x={CONTENT_X} y={TITLE_Y} width={CONTENT_W} title={props.title} meta={props.label || undefined} />
        <BadgeRow x={CONTENT_X} y={props.label ? BADGES_LABEL_Y : LABEL_Y} maxWidth={CONTENT_W} badges={props.badges} />
        <Timeline ref={props.timelineRef} x={CONTENT_X} y={TIMELINE_Y} width={CONTENT_W}
          posMs={props.posMs} durMs={props.durMs} bufferedEndMs={props.bufferedEndMs} scrub={props.scrub}
          onLeft={() => props.onScrubKey('Left')} onRight={() => props.onScrubKey('Right')} onEnter={props.onTimelineEnter}
          onDown={props.onTimelineDown} onFocusChanged={props.onTimelineFocus}
          onPointerSeek={props.onPointerSeek} onDrag={props.onDrag} onHover={props.onActive} />
        {/* Catch-up of a programme on air: the live edge, as far as a seek can go. */}
        <Show when={props.catchup && props.now < props.catchup.stop}>
          <View x={liveEdgeX(seekLimitMs(props.catchup!, props.now), props.catchupDurMs)}
            y={TIMELINE_Y + TIMELINE_H / 2 - CATCHUP_H / 2} width={CATCHUP_W} height={CATCHUP_H} color={COLORS.accent} borderRadius={RADIUS.pill(CATCHUP_W)} />
        </Show>
        <Text x={CONTENT_X} y={TIMES_Y} width={TIME_W} maxWidth={TIME_W} contain="width" maxLines={1}
          fontSize={TYPE.meta} color={COLORS.text}>{elapsedText(props.posMs, props.durMs)}</Text>
        <Show when={props.durMs !== undefined}>
          <Text x={CONTENT_X + CONTENT_W - TIME_W} y={TIMES_Y} width={TIME_W} maxWidth={TIME_W} contain="width" textAlign="right"
            maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{remainingText(props.posMs, props.durMs ?? 0, props.now)}</Text>
        </Show>
        <ActionBar ref={props.barRef} x={CONTENT_X} y={ACTIONS_Y} actions={row().actions} onAction={props.onAction}
          initial="toggle" onUp={props.onBarUp} onDown={() => true}
          onFocusChanged={props.onBarFocus} />
        {/* After the bar: its hit area spans the row, and the later target wins where they overlap. */}
        <Show when={row().volumeX !== undefined}>
          <VolumeControl x={CONTENT_X + (row().volumeX ?? 0)} y={ACTIONS_Y} width={VOLUME_W} height={BUTTON_H} fill={COLORS.surfaceRaised}
            onActive={props.onActive} />
        </Show>
      </View>
    </Show>
  );
}
