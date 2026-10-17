import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { jumpLabel, type Scrub } from '../vod/seekLogic.ts';
import { bubbleX, fractionAt } from '../vod/timelineLogic.ts';
import { clock } from '../vod/vodPlayerLogic.ts';

/** The hit area's height: the bar sits in its middle (a thin bar alone is hard to hit with a pointer). */
export const TIMELINE_H = 64;
const BAR_H = 10;
const BAR_H_ACTIVE = 16;
const KNOB = 28;
const MARKER_W = 6;
const MARKER_H = 40;
const BUBBLE_W = 200;
const BUBBLE_H = 84;
const HOVER_W = 140;
const HOVER_H = 52;
const BUFFERED = 0xffffff4d;
const AHEAD = 0x4f8cff66;
const BACK = 0xffffff80;

/**
 * The VOD timeline: the track, the buffered range, the played part and (focused) a knob at the playhead; a pending
 * scrub draws a marker with a bubble (target time and jump) above it; in pointer mode a hover bubble names the time
 * under the cursor. One focusable node: the screen passes the keys. Pointer: a click seeks there, a drag scrubs.
 */
export function Timeline(props: {
  ref?: (el: ElementNode) => void;
  x: number; y: number; width: number;
  posMs: number;
  durMs: number | undefined;
  bufferedEndMs: number | undefined;
  scrub: Scrub | undefined;
  onLeft: () => boolean;
  onRight: () => boolean;
  onEnter: () => boolean;
  onUp?: () => boolean;
  onDown: () => boolean;
  onFocusChanged?: (f: boolean) => void;
  /** A click at `fraction` (0..1) of the bar. */
  onPointerSeek: (fraction: number) => void;
  onDrag: (fraction: number, phase: 'start' | 'move' | 'end' | 'cancel') => void;
  /** The pointer moved over the bar (keeps the overlay up). */
  onHover?: () => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hoverX, setHoverX] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;

  const frac = (ms: number | undefined) => {
    const d = props.durMs;
    return d === undefined || ms === undefined || d <= 0 ? 0 : Math.max(0, Math.min(1, ms / d));
  };
  const xAt = (ms: number | undefined) => props.width * frac(ms);
  const active = () => focused() || (pointerMode() && hoverX() !== undefined) || props.scrub !== undefined;
  const barH = () => (active() ? BAR_H_ACTIVE : BAR_H);
  const barY = () => (TIMELINE_H - barH()) / 2;

  usePointerTarget({
    node: () => node,
    onHover: (p) => {
      setHoverX(p?.x);
      if (p) props.onHover?.();
    },
    onClick: (p) => props.onPointerSeek(fractionAt(p.x, props.width)),
    onDrag: (p, phase) => props.onDrag(fractionAt(p.x, props.width), phase),
  });

  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x} y={props.y} width={props.width} height={TIMELINE_H}
      onFocusChanged={(f: boolean) => { setFocused(f); props.onFocusChanged?.(f); }}
      onLeft={() => props.onLeft()} onRight={() => props.onRight()} onEnter={() => props.onEnter()}
      onUp={() => props.onUp?.() ?? true} onDown={() => props.onDown()}>
      <View y={barY()} width={props.width} height={barH()} borderRadius={barH() / 2} color={COLORS.surface} />
      <Show when={props.bufferedEndMs !== undefined && props.durMs !== undefined}>
        <View y={barY()} width={Math.max(barH(), xAt(props.bufferedEndMs))} height={barH()} borderRadius={barH() / 2}
          color={BUFFERED} />
      </Show>
      <View y={barY()} width={Math.max(barH(), xAt(props.posMs))} height={barH()} borderRadius={barH() / 2} color={COLORS.focus} />
      {/* A pending scrub: the stretch between the playhead and the target (ahead: light blue; back: whitened over the played part). */}
      <Show when={props.scrub}>{(s) => (
        <View x={Math.min(xAt(props.posMs), xAt(s().targetMs))} y={barY()}
          width={Math.abs(xAt(s().targetMs) - xAt(props.posMs))} height={barH()}
          color={s().targetMs >= props.posMs ? AHEAD : BACK} />
      )}</Show>
      <Show when={focused() && !props.scrub && props.durMs !== undefined}>
        <View x={xAt(props.posMs) - KNOB / 2} y={(TIMELINE_H - KNOB) / 2} width={KNOB} height={KNOB} borderRadius={KNOB / 2}
          color={COLORS.text} />
      </Show>

      <Show when={props.scrub}>{(s) => {
        const mx = () => xAt(s().targetMs);
        const bx = () => bubbleX(mx(), BUBBLE_W, 0, props.width);
        return (
          <View>
            <View x={mx() - MARKER_W / 2} y={(TIMELINE_H - MARKER_H) / 2} width={MARKER_W} height={MARKER_H}
              borderRadius={MARKER_W / 2} color={COLORS.text} />
            <View x={bx()} y={-BUBBLE_H - 4} width={BUBBLE_W} height={BUBBLE_H} borderRadius={LAYOUT.radius} color={COLORS.panel}>
              <Text y={8} width={BUBBLE_W} maxWidth={BUBBLE_W} contain="width" textAlign="center" maxLines={1}
                fontSize={FONT.heading} color={COLORS.text}>{clock(s().targetMs)}</Text>
              <Text y={50} width={BUBBLE_W} maxWidth={BUBBLE_W} contain="width" textAlign="center" maxLines={1}
                fontSize={FONT.small} color={COLORS.muted}>{jumpLabel(s().targetMs - s().fromMs)}</Text>
            </View>
          </View>
        );
      }}</Show>

      <Show when={pointerMode() && !props.scrub && hoverX() !== undefined && props.durMs !== undefined}>
        <View>
          <View x={(hoverX() ?? 0) - 1} y={barY() - 4} width={2} height={barH() + 8} color={COLORS.text} />
          <View x={bubbleX(hoverX() ?? 0, HOVER_W, 0, props.width)} y={-HOVER_H + 4} width={HOVER_W} height={HOVER_H}
            borderRadius={LAYOUT.radius} color={COLORS.panel}>
            <Text y={(HOVER_H - FONT.body) / 2 - 4} width={HOVER_W} maxWidth={HOVER_W} contain="width" textAlign="center"
              maxLines={1} fontSize={FONT.body} color={COLORS.text}>
              {clock(fractionAt(hoverX() ?? 0, props.width) * (props.durMs ?? 0))}
            </Text>
          </View>
        </View>
      </Show>
    </View>
  );
}
