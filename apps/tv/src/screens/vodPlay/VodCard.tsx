/**
 * The VOD player's centre card: a failure (its cause, and Try again unless the format is unsupported), the
 * next-episode countdown, or in catch-up the end card and "Not available".
 */
import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { ActionBar } from '../../components/ActionBar.tsx';
import { BUTTON_H } from '../../components/Button.tsx';
import { messageTop, type MessageBox } from '../../components/messageFit.ts';
import { COLORS, LAYOUT, LINE, RADIUS, SPACE, STRONG, TYPE } from '../../shell/theme.ts';
import { CARD_H, CARD_TEXT_H, CARD_W } from './layout.ts';
import { cardActionsX, type CardAction } from './vodPlayLogic.ts';

export function VodCard(props: {
  shown: boolean;
  /** The card's text and the box it fits (body size, up to three lines for a long refusal that names the account's limit). */
  card: { text: string; box: MessageBox };
  /** The buttons show (an unsupported format has none: Back still works). */
  withActions: boolean;
  actions: CardAction[];
  onAction: (id: string) => void;
  actionsRef: (el: ElementNode) => void;
}) {
  return (
    <Show when={props.shown}>
      <View zIndex={30} x={(LAYOUT.width - CARD_W) / 2} y={(LAYOUT.height - CARD_H) / 2 - SPACE.xl * 2 - SPACE.l} width={CARD_W} height={CARD_H}
        color={COLORS.surface} borderRadius={RADIUS.card}>
        {/* The text area above the buttons: y 24 to 148. */}
        <Text x={SPACE.xl} y={24 + messageTop(props.card.text, props.card.box, CARD_TEXT_H)} width={CARD_W - SPACE.xl * 2} maxWidth={CARD_W - SPACE.xl * 2}
          contain="width" textAlign="center" maxLines={props.card.box.maxLines} lineHeight={LINE.body}
          fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.card.text}</Text>
        <Show when={props.withActions}>
          <ActionBar ref={props.actionsRef}
            x={cardActionsX(props.actions, CARD_W)} y={CARD_H - BUTTON_H - SPACE.xl}
            actions={props.actions} onAction={props.onAction} />
        </Show>
      </View>
    </Show>
  );
}
