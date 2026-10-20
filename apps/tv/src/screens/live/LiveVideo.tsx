import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { CooldownNotice } from '../../components/CooldownNotice.tsx';
import { MESSAGE_BOXES, messageTop } from '../../components/messageFit.ts';
import { pointerMode, usePointerTarget } from '../../input/pointer.ts';
import { PAUSED_NOTE } from '../../playback/devResume.ts';
import { playback } from '../../playback/playback.ts';
import { COLORS, LAYOUT, TYPE } from '../../shell/theme.ts';
import { activeMaxConnections } from '../../state/activeLimit.ts';
import { cooldown } from '../../state/appState.ts';
import { cooldownCopy, freshNow } from '../../state/cooldownLogic.ts';
import { previewMessage } from '../homeLogic.ts';
import { LIVE_PREVIEW_RECT } from './liveLogic.ts';

const R = LIVE_PREVIEW_RECT;
const BOX = MESSAGE_BOXES.live;
const PAD = 24;

/**
 * Live TV's mini video: the canvas is opaque everywhere except `LIVE_PREVIEW_RECT`, a hole onto the `<video>` under
 * it. Inside the hole: the status message while nothing plays (compact copy for the 416×234 box), or the cooldown
 * notice with Retry (OK on the grid retries too). Drawn first, so everything else draws over the background.
 * Pointer: a click on the window is `onVideoClick` (undefined turns the click area off); the cooldown's Retry,
 * registered later, wins over it.
 */
export function LiveVideo(props: { now: number; pausedNote: boolean; onRetry: () => void; onVideoClick?: () => void }) {
  let video: ElementNode | undefined;
  usePointerTarget({ node: () => video, enabled: () => props.onVideoClick !== undefined, onClick: () => props.onVideoClick?.() });
  const playing = () => playback.current() !== undefined;
  const message = () => previewMessage(playing() ? playback.status() : undefined, playing(),
    props.pausedNote ? PAUSED_NOTE : undefined, activeMaxConnections(), true);
  const failed = () => playing() && playback.status()?.kind === 'failed';
  const notice = () => cooldownCopy(cooldown(), freshNow(props.now), pointerMode());
  return (
    <View width={LAYOUT.width} height={LAYOUT.height}>
      <View width={LAYOUT.width} height={R.y} color={COLORS.background} />
      <View y={R.y + R.h} width={LAYOUT.width} height={LAYOUT.height - R.y - R.h} color={COLORS.background} />
      <View y={R.y} width={R.x} height={R.h} color={COLORS.background} />
      <View x={R.x + R.w} y={R.y} width={LAYOUT.width - R.x - R.w} height={R.h} color={COLORS.background} />
      {/* The click area. No colour: it draws nothing, so the hole stays open. */}
      <View ref={(el) => { video = el; }} x={R.x} y={R.y} width={R.w} height={R.h} />
      <Show when={notice()}>{(c) => (
        <CooldownNotice x={R.x} y={R.y} width={R.w} height={R.h} text={c().text} hint={c().hint} onRetry={props.onRetry} />
      )}</Show>
      <Show when={notice() ? undefined : message()}>{(m) => (
        <View x={R.x} y={R.y} width={R.w} height={R.h} borderRadius={LAYOUT.radius}
          color={failed() || !playing() ? COLORS.surface : COLORS.panel}>
          <Text x={PAD} y={messageTop(m(), BOX, R.h)} width={R.w - PAD * 2} maxWidth={R.w - PAD * 2} contain="width"
            maxLines={BOX.maxLines} lineHeight={BOX.lineH} textAlign="center" fontSize={TYPE.body}
            color={failed() ? COLORS.text : COLORS.muted}>{m()}</Text>
        </View>
      )}</Show>
    </View>
  );
}
