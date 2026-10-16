import { Show, View } from '@lightningtv/solid';
import { posterCache } from '../components/posterCache.ts';
import { rawViaDevProxy } from '../net/devProxy.ts';
import { COLORS, LAYOUT } from '../shell/theme.ts';
import { scrimTexture } from './scrim.ts';

/** The background colour without alpha (0xRRGGBB), for the fade textures. */
const BG_RGB = Math.floor(COLORS.background / 0x100);

/**
 * The detail screens' backdrop art (top right, from the source's data only) with its left and bottom fades into the
 * background. Place it first in the screen; it takes zIndex 0 and 1, so the screen's content goes at zIndex 2 or above
 * (a late image is inserted last and would otherwise cover the rest).
 */
export function DetailBackdrop(props: { url: string | undefined }) {
  return (
    <>
      <View zIndex={0}>
        <Show when={props.url && posterCache.usable(props.url) ? props.url : undefined} keyed>
          {(u) => <View x={640} y={0} width={1280} height={720} src={rawViaDevProxy(u)} onEvent={{ failed: () => posterCache.markFailed(u) }} />}
        </Show>
      </View>
      <View zIndex={1} x={640} y={0} width={1280} height={720} src={scrimTexture('left', BG_RGB)} />
      <View zIndex={1} y={440} width={LAYOUT.width} height={280} src={scrimTexture('down', BG_RGB)} />
    </>
  );
}
