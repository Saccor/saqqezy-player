import { Text, View, type ElementNode } from '@lightningtv/solid';
import { usePointerTarget } from '../input/pointer.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

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
  const size = () => props.fontSize ?? FONT.body;
  const w = () => props.width - pad * 2;
  return (
    <View ref={(el) => { node = el; }} x={props.x ?? 0} y={props.y ?? 0} width={props.width} height={props.height}
      color={COLORS.surface} borderRadius={LAYOUT.radius} zIndex={props.zIndex ?? 4}>
      <Text x={pad} y={props.height / 2 - size() * 2} width={w()} maxWidth={w()} contain="width" maxLines={3}
        textAlign="center" fontSize={size()} color={COLORS.text}>{props.text}</Text>
      <Text x={pad} y={props.height / 2 + size() * 0.9} width={w()} maxWidth={w()} contain="width" maxLines={1}
        textAlign="center" fontSize={FONT.small} color={COLORS.muted}>{props.hint}</Text>
    </View>
  );
}
