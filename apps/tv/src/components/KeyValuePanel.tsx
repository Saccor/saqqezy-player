import { For, Show, Text, View } from '@lightningtv/solid';
import { COLORS, LINE, RADIUS, SPACE, STRONG, TYPE } from '../shell/theme.ts';
import { KV_LABEL_W, KV_LINE_H, keyValueHeight } from './infoBlockLogic.ts';

/**
 * Two columns of label and value (spec 2026-10-26 §1.3): stream info, diagnostics. `framed` draws it as a panel over
 * video; unframed it sits inside a page or, from phase 2, a Sheet tab. Values never hold a URL path or credentials
 * (`streamInfoLines` gives host and format only).
 */
export function KeyValuePanel(props: { x?: number; y?: number; width: number; title?: string; lines: readonly (readonly [string, string])[]; maxLines?: number; framed?: boolean }) {
  const shown = () => props.lines.slice(0, props.maxLines ?? props.lines.length);
  const pad = () => (props.framed ? SPACE.l : 0);
  const top = () => pad() + (props.title ? LINE.body + SPACE.m : 0);
  const inner = () => props.width - pad() * 2;
  return (
    <View x={props.x ?? 0} y={props.y ?? 0} width={props.width} height={keyValueHeight(shown().length, props.title !== undefined, props.framed === true)}
      color={props.framed ? COLORS.panel : COLORS.transparent} borderRadius={RADIUS.card} zIndex={20}>
      <Show when={props.title}>
        <Text x={pad()} y={pad()} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.title ?? ''}</Text>
      </Show>
      <For each={shown()}>{(line, i) => (
        <View x={pad()} y={top() + i() * KV_LINE_H} width={inner()} height={KV_LINE_H}>
          <Text width={KV_LABEL_W - SPACE.m} maxWidth={KV_LABEL_W - SPACE.m} contain="width" maxLines={1} fontSize={TYPE.meta} color={COLORS.muted}>{line[0]}</Text>
          <Text x={KV_LABEL_W} width={inner() - KV_LABEL_W} maxWidth={inner() - KV_LABEL_W} contain="width" maxLines={1}
            fontSize={TYPE.meta} color={COLORS.text}>{line[1]}</Text>
        </View>
      )}</For>
    </View>
  );
}
