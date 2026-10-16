import { View } from '@lightningtv/solid';
import { posterCache } from '../components/posterCache.ts';
import { BACKGROUND_RGB, LAYOUT } from '../shell/theme.ts';
import { CrossFadeArt } from './CrossFadeArt.tsx';
import { scrimTexture } from './scrim.ts';

/**
 * The detail screens' backdrop art (top right, from the source's data only) with its left and bottom fades into the
 * background; a new backdrop cross-fades in over 200 ms. Place it first in the screen; it takes zIndex 0 and 1, so the
 * screen's content goes at zIndex 2 or above (a late image is inserted last and would otherwise cover the rest).
 */
export function DetailBackdrop(props: { url: string | undefined }) {
  return (
    <>
      <View zIndex={0}>
        <CrossFadeArt x={640} y={0} width={1280} height={720} url={props.url && posterCache.usable(props.url) ? props.url : undefined}
          onFailed={(u) => posterCache.markFailed(u)} />
      </View>
      <View zIndex={1} x={640} y={0} width={1280} height={720} src={scrimTexture('left', BACKGROUND_RGB)} />
      <View zIndex={1} y={440} width={LAYOUT.width} height={280} src={scrimTexture('down', BACKGROUND_RGB)} />
    </>
  );
}
