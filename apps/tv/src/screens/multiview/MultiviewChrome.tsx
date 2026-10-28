/**
 * What Multiview draws over and around each window (the windows themselves are playback slots under the UI): the
 * pointer area, the focus ring, a failure card, the "Freeing…" and "Starting…" pills, the sound disc and the name strip.
 */
import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { FocusRing } from '../../components/FocusRing.tsx';
import { MULTIVIEW_COPY } from '../../copy.ts';
import { usePointerTarget } from '../../input/pointer.ts';
import { ALPHA, centerText, COLORS, LAYOUT, RADIUS, SPACE, STRONG, TYPE } from '../../shell/theme.ts';
import type { Rect, TileGeometry } from './layout.ts';
import type { MvHealth } from './mvHealth.ts';

/** The height of a window's status pill (and of the sound mark on a small window). */
const STATUS_PILL_H = 40;

/** A window's pointer area: hover focuses it (the sound follows after the rest), click, double click, right click. */
export function WindowHit(props: {
  rect: Rect; onHover: () => void; onClick: () => void; onDoubleClick: () => void; onMenu: () => void; onWheel: (dy: number) => boolean;
}) {
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node,
    onHover: (p) => { if (p) props.onHover(); },
    onClick: () => props.onClick(),
    onDoubleClick: () => props.onDoubleClick(),
    onContextMenu: () => props.onMenu(),
    onWheel: (dy) => props.onWheel(dy),
  });
  return <View ref={(el) => { node = el; }} x={props.rect.x} y={props.rect.y} width={props.rect.w} height={props.rect.h} />;
}

/** One window's chrome. `full`: the window shown full screen (if any); `awake`: the chrome is not dimmed by idling. */
export function WindowChrome(props: {
  t: TileGeometry;
  full: number | undefined;
  awake: boolean;
  focused: boolean;
  /** This window has the sound (shown while more than one window is open). */
  sound: boolean;
  /** What the window says instead of its picture (`MvHealth.failure`). */
  fail: ReturnType<MvHealth['failure']>;
  freeing: boolean;
  starting: boolean;
  name: string;
  /** Retry would stop other windows first ("Watch this one instead"). */
  watchInstead: boolean;
}) {
  const t = () => props.t;
  const r = () => (props.full === t().tile ? { x: 0, y: 0, w: LAYOUT.width, h: LAYOUT.height } : t().rect);
  const large = () => props.full === t().tile || t().sizeClass === 'large';
  const chrome = () => props.awake;
  const fail = () => props.fail;
  const pad = () => (large() ? 24 : 16);
  const scrimH = () => (large() ? 128 : 72);
  const iconS = () => (large() ? SPACE.xl : STATUS_PILL_H);
  return (
    <View>
      <View x={r().x} y={r().y}>
        <FocusRing w={r().w} h={r().h} radius={RADIUS.card} lit={props.focused && chrome()} clear />
      </View>
      <Show when={fail()}>{(f) => (
        <View x={r().x} y={r().y} width={r().w} height={r().h} color={COLORS.surface} borderRadius={RADIUS.card}>
          <Text x={pad()} y={r().h / 2 - SPACE.xl - SPACE.m} width={r().w - pad() * 2} maxWidth={r().w - pad() * 2} contain="width" maxLines={3}
            textAlign="center" fontSize={large() ? TYPE.body : TYPE.meta} color={COLORS.text}>{f().text}</Text>
          <Text x={pad()} y={r().h / 2 + SPACE.xl} width={r().w - pad() * 2} maxWidth={r().w - pad() * 2} contain="width" maxLines={1}
            textAlign="center" fontSize={TYPE.meta} color={COLORS.muted}>
            {f().retryNow
              ? [f().hint, MULTIVIEW_COPY.retry, MULTIVIEW_COPY.closeWindow].filter(Boolean).join(' · ')
              : f().retry.enabled
              ? `${props.watchInstead ? MULTIVIEW_COPY.watchInstead : MULTIVIEW_COPY.retry} · ${MULTIVIEW_COPY.closeWindow}`
              : MULTIVIEW_COPY.closeWindow}
          </Text>
        </View>
      )}</Show>
      <Show when={props.freeing}>
        <View x={r().x + pad()} y={r().y + pad()} width={300} height={STATUS_PILL_H} borderRadius={RADIUS.pill(STATUS_PILL_H)} color={COLORS.panel}>
          <Text x={16} y={centerText(STATUS_PILL_H, TYPE.meta)} fontSize={TYPE.meta} color={COLORS.text}>{MULTIVIEW_COPY.freeing}</Text>
        </View>
      </Show>
      <Show when={!fail() && props.starting}>
        <View x={r().x + pad()} y={r().y + pad()} width={160} height={STATUS_PILL_H} borderRadius={RADIUS.pill(STATUS_PILL_H)} color={COLORS.panel}>
          <Text x={16} y={centerText(STATUS_PILL_H, TYPE.meta)} fontSize={TYPE.meta} color={COLORS.text}>{MULTIVIEW_COPY.starting}</Text>
        </View>
      </Show>
      <Show when={props.sound}>
        <View x={r().x + r().w - pad() - iconS()} y={r().y + pad()} width={iconS()} height={iconS()}
          borderRadius={RADIUS.pill(iconS())} color={COLORS.panel} alpha={chrome() ? 1 : ALPHA.dimmed}>
          <Text y={centerText(iconS(), TYPE.meta)} width={iconS()} contain="width" textAlign="center" fontSize={TYPE.meta} color={COLORS.text}>♪</Text>
        </View>
      </Show>
      <Show when={chrome() && !fail()}>
        <View x={r().x} y={r().y + r().h - scrimH()} width={r().w} height={scrimH()} color={COLORS.panel}>
          <Text x={pad()} y={centerText(scrimH(), large() ? TYPE.body : TYPE.meta)} width={r().w - pad() * 2} maxWidth={r().w - pad() * 2} contain="width"
            maxLines={1} fontSize={large() ? TYPE.body : TYPE.meta} {...STRONG} color={COLORS.text}>{props.name}</Text>
        </View>
      </Show>
    </View>
  );
}
