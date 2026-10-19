import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { onUnmappedKey } from '../input/keys.ts';
import { usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { iconTexture } from '../vod/icons.ts';
import { fractionAt } from '../vod/timelineLogic.ts';
import { volume, volumeRecent, volumeSet, volumeStep, volumeSupported, volumeToggleMute } from '../video/volume.ts';
import { volumeKeyStep, volumePercent } from '../video/volumeLogic.ts';

const W = 400;
const H = 64;
const ICON = 40;
const ICON_HIT_W = 72;
const BAR_X = 80;
const BAR_W = 220;
const BAR_H = 8;
const KNOB = 20;
const PCT_X = BAR_X + BAR_W + 16;
/** Below the shell's clock (top right, one heading line). */
const Y = LAYOUT.safeY + 56;

/**
 * The fullscreen players' volume (the app owns the sound only off TVs; elsewhere this renders nothing): a top-right
 * pill (under the clock) with a speaker, a slider and the level. The keyboard's + and - step it; it shows for 2 s after a change, while
 * `pinned` (the VOD overlay is up) and while the pointer is over it. Pointer: the speaker mutes, a click or drag on
 * the slider sets the level, the wheel steps it.
 */
export function VolumeOsd(props: {
  /** Keep it shown (the screen's own controls are up, so the slider can be reached with the pointer). */
  pinned?: boolean;
  /** The pointer moved over it (keeps the screen's overlay up). */
  onHover?: () => void;
  onHoverChange?: (over: boolean) => void;
}) {
  if (!volumeSupported) return null;
  const [hovered, setHovered] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let node: ElementNode | undefined;

  const shown = () => volumeRecent() || hovered() || dragging() || props.pinned === true;
  const level = () => volume().level;
  const silent = () => volumePercent(volume()) === 0;
  const fill = () => (volume().muted ? 0 : level()) * BAR_W;
  const barFraction = (x: number) => fractionAt(x - BAR_X, BAR_W);

  usePointerTarget({
    node: () => node,
    onHover: (p) => {
      const over = p !== undefined;
      if (over !== hovered()) props.onHoverChange?.(over);
      setHovered(over);
      if (over) props.onHover?.();
    },
    onClick: (p) => {
      if (p.x < ICON_HIT_W) volumeToggleMute();
      else volumeSet(barFraction(p.x));
    },
    onDrag: (p, phase) => {
      if (phase === 'cancel') { setDragging(false); return; }
      setDragging(phase !== 'end');
      volumeSet(barFraction(p.x));
    },
    onWheel: (dy) => {
      if (dy !== 0) volumeStep(dy < 0 ? 1 : -1);
      return true;
    },
  });

  onMount(() => {
    const off = onUnmappedKey((e) => {
      const dir = volumeKeyStep(e);
      if (dir === undefined) return;
      e.preventDefault();
      volumeStep(dir);
    });
    onCleanup(off);
  });
  onCleanup(() => {
    if (hovered()) props.onHoverChange?.(false);
  });

  return (
    <Show when={shown()}>
      <View ref={(el) => { node = el; }} zIndex={42} x={LAYOUT.width - LAYOUT.safeX - W} y={Y} width={W} height={H}
        color={COLORS.panel} borderRadius={H / 2}>
        <View x={24} y={(H - ICON) / 2} width={ICON} height={ICON} src={iconTexture(silent() ? 'mute' : 'volume')}
          color={hovered() ? COLORS.text : COLORS.muted} />
        <View x={BAR_X} y={(H - BAR_H) / 2} width={BAR_W} height={BAR_H} borderRadius={BAR_H / 2} color={COLORS.surface} />
        <View x={BAR_X} y={(H - BAR_H) / 2} width={Math.max(BAR_H, fill())} height={BAR_H} borderRadius={BAR_H / 2}
          color={silent() ? COLORS.muted : COLORS.focus} />
        <View x={BAR_X + fill() - KNOB / 2} y={(H - KNOB) / 2} width={KNOB} height={KNOB} borderRadius={KNOB / 2}
          color={COLORS.text} />
        <Text x={PCT_X} y={(H - FONT.body) / 2 - 4} width={W - PCT_X - 20} maxWidth={W - PCT_X - 20} contain="width"
          textAlign="right" maxLines={1} fontSize={FONT.body} color={COLORS.text}>{`${volumePercent(volume())}%`}</Text>
      </View>
    </Show>
  );
}
