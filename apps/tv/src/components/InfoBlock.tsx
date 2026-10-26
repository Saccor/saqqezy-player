import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, on } from 'solid-js';
import { stopMotion, tween } from '../shell/motion.ts';
import { COLORS, LINE, MOTION, RADIUS, STRONG, TYPE } from '../shell/theme.ts';
import { INFO_PROGRESS_W, infoBlockLayout, metaLineLayout, overlineWidth } from './infoBlockLogic.ts';
import { keepSpaces, textWidth } from './textWidth.ts';

const TRACK_H = 4;
const ICON = 24;

/**
 * Title, meta line, optional progress, optional description (spec 2026-10-26 §1.3), for the browse strip, the guide's
 * focused programme, the live banner and the VOD title. Feed it dwell-settled values; it never shows a spinner.
 * `fadeOnTitle`: a new title fades in over MOTION.textIn (the first title, and later meta or description, show at once).
 */
export function InfoBlock(props: {
  x?: number; y?: number; width: number;
  overline?: string;
  /** Room taken at the right of the overline's line (badges): the overline ends before it. */
  overlineEndGap?: number;
  title: string;
  titleSize?: 'title' | 'hero';
  /** A small icon before the title (the catch-up mark), from the app's icon set. */
  titleIcon?: string;
  meta?: string;
  /** 0..1: a track after the meta text. */
  progress?: number;
  trailing?: string;
  description?: string;
  /** Default 1 (spec); the guide's expanded details pass 3. */
  descriptionLines?: number;
  fadeOnTitle?: boolean;
  /** The title colour: the guide's "no information" fallback is dimmer. */
  titleDim?: boolean;
}) {
  let node: ElementNode | undefined;
  createEffect(on(() => props.title, (title, prev) => {
    if (!props.fadeOnTitle || !node || !title || !prev) return;
    stopMotion(node);
    node.alpha = MOTION.startAlpha;
    tween(node, { alpha: 1 }, MOTION.textIn);
  }, { defer: true }));
  const lines = () => (props.description ? props.descriptionLines ?? 1 : 0);
  const metaLine = () => props.meta !== undefined || props.progress !== undefined || props.trailing !== undefined;
  const l = () => infoBlockLayout({ overline: props.overline !== undefined, titleSize: props.titleSize ?? 'title', metaLine: metaLine(), descriptionLines: lines() });
  const size = () => (props.titleSize === 'hero' ? TYPE.hero : TYPE.title);
  const titleX = () => (props.titleIcon ? ICON + TYPE.meta / 2 : 0);
  const meta = () => metaLineLayout(Math.ceil(textWidth(props.meta ?? '', TYPE.meta)), props.progress !== undefined);
  return (
    <View ref={(el) => { node = el; }} x={props.x ?? 0} y={props.y ?? 0} width={props.width} height={l().height} zIndex={2}>
      <Show when={props.overline}>
        <Text width={overlineWidth(props.width, props.overlineEndGap ?? 0)} maxWidth={overlineWidth(props.width, props.overlineEndGap ?? 0)} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{keepSpaces(props.overline ?? '')}</Text>
      </Show>
      <Show when={props.titleIcon}>{(src) => (
        <View y={l().titleY + (size() - ICON) / 2} width={ICON} height={ICON} src={src()} color={COLORS.muted} />
      )}</Show>
      <Text x={titleX()} y={l().titleY} width={props.width - titleX()} maxWidth={props.width - titleX()} contain="width" maxLines={1}
        fontSize={size()} {...STRONG} color={props.titleDim ? COLORS.textSecondary : COLORS.text}>{keepSpaces(props.title)}</Text>
      <Show when={metaLine()}>
        <View y={l().metaY} width={props.width} height={LINE.meta}>
          <Text width={props.width} maxWidth={props.width} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{keepSpaces(props.meta ?? '')}</Text>
          <Show when={props.progress !== undefined}>
            <View x={meta().trackX} y={(TYPE.meta - TRACK_H) / 2} width={INFO_PROGRESS_W} height={TRACK_H} color={COLORS.track} borderRadius={RADIUS.pill(TRACK_H)}>
              <View width={Math.round(INFO_PROGRESS_W * (props.progress ?? 0))} height={TRACK_H} color={COLORS.accent} borderRadius={RADIUS.pill(TRACK_H)} />
            </View>
          </Show>
          <Show when={props.trailing}>
            <Text x={meta().trailingX} width={props.width - meta().trailingX} maxWidth={props.width - meta().trailingX} contain="width" maxLines={1}
              fontSize={TYPE.meta} color={COLORS.muted}>{keepSpaces(props.trailing ?? '')}</Text>
          </Show>
        </View>
      </Show>
      <Show when={props.description}>
        <Text y={l().descriptionY} width={props.width} maxWidth={props.width} contain="width" maxLines={lines()} lineHeight={LINE.body}
          fontSize={TYPE.body} color={COLORS.textSecondary}>{keepSpaces(props.description ?? '')}</Text>
      </Show>
    </View>
  );
}
