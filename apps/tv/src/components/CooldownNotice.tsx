import { Text, View, type ElementNode } from '@lightningtv/solid';
import { usePointerTarget } from '../input/pointer.ts';
import { COLORS, LAYOUT, RADIUS, TYPE } from '../shell/theme.ts';
import { stackedMessage } from './messageFit.ts';

/**
 * The refusal cooldown message (Home's preview box, the Player's centre): the neutral copy, and a hint with the
 * wait and how to retry. OK is handled by the screen; a pointer click on the box calls `onRetry`.
 */
export function CooldownNotice(props: {
  x?: number; y?: number; width: number; height: number; zIndex?: number;
  text: string; hint: string; fontSize?: number;
  onRetry: () => void;
}) {
  let node: ElementNode | undefined;
  usePointerTarget({ node: () => node, onClick: () => props.onRetry() });
  const pad = 32;
  const size = () => props.fontSize ?? TYPE.body;
  const w = () => props.width - pad * 2;
  // The hint goes under the message's last line (a third line used to run into it in Home's preview).
  const s = () => stackedMessage(props.text, { width: w(), fontSize: size(), maxLines: 3 }, props.height, TYPE.meta);
  return (
    <View ref={(el) => { node = el; }} x={props.x ?? 0} y={props.y ?? 0} width={props.width} height={props.height}
      color={COLORS.surface} borderRadius={RADIUS.card} zIndex={props.zIndex ?? 4}>
      <Text x={pad} y={s().textY} width={w()} maxWidth={w()} contain="width" maxLines={s().lines} lineHeight={s().lineH}
        textAlign="center" fontSize={size()} color={COLORS.text}>{props.text}</Text>
      <Text x={pad} y={s().hintY} width={w()} maxWidth={w()} contain="width" maxLines={1}
        textAlign="center" fontSize={TYPE.meta} color={COLORS.muted}>{props.hint}</Text>
    </View>
  );
}
