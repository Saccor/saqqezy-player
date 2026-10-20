import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { onUnmappedKey } from '../input/keys.ts';
import { usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { iconTexture } from '../vod/icons.ts';
import { fractionAt } from '../vod/timelineLogic.ts';
import { volume, volumeRecent, volumeSet, volumeStep, volumeSupported, volumeToggleMute } from '../video/volume.ts';
import { volumeKeyStep, volumePercent } from '../video/volumeLogic.ts';

const BAR_H = 8;
const KNOB = 20;
const PCT_W = 64;
const OSD_W = 340;
const OSD_H = 64;
/** Below the shell's clock (top right, one heading line). */
const OSD_Y = LAYOUT.safeY + 56;

/**
 * The volume control: a pill with a speaker (click: mute), a slider (click or drag: set) and the level; the wheel over
 * it steps the volume. Pointer-only (never focused): the keyboard's + and - set the volume anywhere in the players.
 */
export function VolumeControl(props: {
  x: number; y: number; width: number; height: number;
  /** Pill fill and border: the bar it sits in decides (VOD buttons: surface; pointer bars: panel with a focus ring). */
  fill?: number;
  border?: boolean;
  onHoverChange?: (over: boolean) => void;
  /** Every pointer move, drag step and wheel step over it (keeps the screen's controls up). */
  onActive?: () => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let node: ElementNode | undefined;
  const icon = () => Math.round(props.height * 0.55);
  const iconX = () => Math.round(props.height * 0.3);
  const barX = () => iconX() + icon() + 14;
  const barW = () => Math.max(40, props.width - barX() - PCT_W - 16);
  const silent = () => volumePercent(volume()) === 0;
  const fill = () => (volume().muted ? 0 : volume().level) * barW();
  const lit = () => hovered() || dragging();

  usePointerTarget({
    node: () => node,
    onHover: (p) => {
      const over = p !== undefined;
      if (over !== hovered()) props.onHoverChange?.(over);
      setHovered(over);
      if (over) props.onActive?.();
    },
    onClick: (p) => {
      props.onActive?.();
      if (p.x < barX() - 6) volumeToggleMute();
      else volumeSet(fractionAt(p.x - barX(), barW()));
    },
    onDrag: (p, phase) => {
      if (phase === 'cancel') { setDragging(false); return; }
      setDragging(phase !== 'end');
      props.onActive?.();
      volumeSet(fractionAt(p.x - barX(), barW()));
    },
    onWheel: (dy) => {
      props.onActive?.();
      if (dy !== 0) volumeStep(dy < 0 ? 1 : -1);
      return true;
    },
  });
  onCleanup(() => { if (hovered()) props.onHoverChange?.(false); });

  return (
    <View ref={(el) => { node = el; }} x={props.x} y={props.y} width={props.width} height={props.height}
      color={props.fill ?? COLORS.panel} borderRadius={props.height / 2}
      border={props.border ? { width: 2, color: lit() ? COLORS.focus : COLORS.muted } : undefined}>
      <View x={iconX()} y={(props.height - icon()) / 2} width={icon()} height={icon()} src={iconTexture(silent() ? 'mute' : 'volume')}
        color={lit() ? COLORS.text : COLORS.muted} />
      <View x={barX()} y={(props.height - BAR_H) / 2} width={barW()} height={BAR_H} borderRadius={BAR_H / 2} color={COLORS.background} />
      <View x={barX()} y={(props.height - BAR_H) / 2} width={Math.max(BAR_H, fill())} height={BAR_H} borderRadius={BAR_H / 2}
        color={silent() ? COLORS.muted : COLORS.accent} />
      <View x={barX() + fill() - KNOB / 2} y={(props.height - KNOB) / 2} width={KNOB} height={KNOB} borderRadius={KNOB / 2}
        color={COLORS.text} scale={lit() ? 1.15 : 1} />
      <Text x={props.width - PCT_W - 16} y={(props.height - FONT.body) / 2 - 4} width={PCT_W} maxWidth={PCT_W} contain="width"
        textAlign="right" maxLines={1} fontSize={FONT.body} color={COLORS.text}>{`${volumePercent(volume())}%`}</Text>
    </View>
  );
}

/**
 * The fullscreen players' volume keys (+ and -) and the top-right pill that confirms a change for 2 s. The pill stays
 * away while `inBar` (the screen's own bar shows the volume control); the pointer over it keeps it up. Off TVs only
 * (the app owns the sound there); elsewhere it renders nothing.
 */
export function VolumeOsd(props: {
  /** The screen's bar with its own volume control is up: no pill. */
  inBar?: boolean;
  onHoverChange?: (over: boolean) => void;
}) {
  if (!volumeSupported) return null;
  const [hovered, setHovered] = createSignal(false);
  const shown = () => props.inBar !== true && (volumeRecent() || hovered());

  onMount(() => {
    const off = onUnmappedKey((e) => {
      const dir = volumeKeyStep(e);
      if (dir === undefined) return;
      e.preventDefault();
      volumeStep(dir);
    });
    onCleanup(off);
  });

  return (
    <Show when={shown()}>
      <View zIndex={42}>
        <VolumeControl x={LAYOUT.width - LAYOUT.safeX - OSD_W} y={OSD_Y} width={OSD_W} height={OSD_H}
          onHoverChange={(v) => { setHovered(v); props.onHoverChange?.(v); }} />
      </View>
    </Show>
  );
}
