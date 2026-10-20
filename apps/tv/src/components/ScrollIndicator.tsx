import { Show, View } from '@lightningtv/solid';
import { COLORS } from '../shell/theme.ts';
import { scrollThumb } from './scrollThumb.ts';

const W = 4;

/** A 4 px track with a thumb, right of a long grid or list. Draws nothing when everything fits. */
export function ScrollIndicator(props: { x: number; y: number; height: number; total: number; visible: number; first: number }) {
  const thumb = () => scrollThumb(props.total, props.visible, props.first, props.height);
  return (
    <Show when={thumb()}>
      {(t) => (
        <View x={props.x} y={props.y} width={W} height={props.height} borderRadius={W / 2} color={COLORS.track}>
          <View y={t().y} width={W} height={t().h} borderRadius={W / 2} color={COLORS.subtle} />
        </View>
      )}
    </Show>
  );
}
