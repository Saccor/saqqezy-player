import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { settings } from '../state/appState.ts';
import { iconTexture } from '../vod/icons.ts';
import { Clock } from './Clock.tsx';
import type { TabId } from '../vod/tabLogic.ts';
import { RAIL_ICON, RAIL_ITEMS, RAIL_LABELS, RAIL_OPEN_W, RAIL_ROW_H, railIcon, railItemAt, railY, stepRail, type RailId } from './railLogic.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from './theme.ts';

/**
 * The left rail: one focusable node. Collapsed (128 px) it shows icons, the current screen's in full colour with a
 * bar beside it. Focused it opens to 320 px over a scrim (content does not move): Up/Down move a cursor, Ok opens the
 * item (Ok on the current screen returns to the content), Right returns to the content. Back is left to the screen.
 * Pointer: a click opens the item.
 */
export function Rail(props: {
  ref?: (el: ElementNode) => void;
  active: TabId;
  onSelect: (id: RailId) => void;
  onRight: () => boolean;
  onFocusChanged?: (f: boolean) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [cursor, setCursor] = createSignal<RailId>(props.active);
  const [hover, setHover] = createSignal<RailId | undefined>(undefined);
  let node: ElementNode | undefined;
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? railItemAt(p.y) : undefined),
    subAt: (p) => { const id = railItemAt(p.y); return id ? RAIL_ITEMS.indexOf(id) : undefined; },
    onClick: (p) => { const id = railItemAt(p.y); if (id) props.onSelect(id); },
  });
  const pad = (RAIL_ROW_H - RAIL_ICON) / 2;
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} width={focused() ? RAIL_OPEN_W : LAYOUT.railW} height={LAYOUT.height} zIndex={50}
      onFocusChanged={(f: boolean) => { setFocused(f); if (f) setCursor(props.active); props.onFocusChanged?.(f); }}
      onUp={() => { setCursor(stepRail(cursor(), -1)); return true; }}
      onDown={() => { setCursor(stepRail(cursor(), 1)); return true; }}
      onLeft={() => true}
      onRight={() => props.onRight()}
      onEnter={() => { if (cursor() === props.active) return props.onRight(); props.onSelect(cursor()); return true; }}>
      <Show when={focused()}>
        <View x={RAIL_OPEN_W} width={LAYOUT.width - RAIL_OPEN_W} height={LAYOUT.height} color={COLORS.scrim} />
        <View width={RAIL_OPEN_W} height={LAYOUT.height} color={COLORS.background} />
      </Show>
      <Show when={settings()?.showClock === true}>
        <Clock x={0} y={LAYOUT.safeY} width={LAYOUT.railW} align="center" size={TYPE.meta} />
      </Show>
      <For each={RAIL_ITEMS}>{(id) => {
        const lit = () => focused() && cursor() === id;
        const current = () => id === props.active;
        const tint = () => (lit() ? COLORS.onFocus : current() || focused() ? COLORS.text : COLORS.subtle);
        return (
          <View y={railY(id)}>
            <Show when={lit()}>
              <View x={24} y={-pad} width={RAIL_OPEN_W - 48} height={RAIL_ROW_H} borderRadius={RAIL_ROW_H / 2} color={COLORS.focus} />
            </Show>
            <Show when={!lit() && pointerMode() && hover() === id}>
              <View x={24} y={-pad} width={(focused() ? RAIL_OPEN_W : LAYOUT.railW) - 48} height={RAIL_ROW_H} borderRadius={RAIL_ROW_H / 2} color={COLORS.hover} />
            </Show>
            <Show when={current() && !lit()}>
              <View x={20} y={(RAIL_ICON - 28) / 2} width={4} height={28} borderRadius={2} color={COLORS.text} />
            </Show>
            <View x={(LAYOUT.railW - RAIL_ICON) / 2} width={RAIL_ICON} height={RAIL_ICON} src={iconTexture(railIcon(id))} color={tint()} />
            <Show when={focused()}>
              <Text x={LAYOUT.railW - 8} y={(RAIL_ICON - TYPE.body) / 2 - 2} fontSize={TYPE.body} {...(current() ? STRONG : {})} color={tint()}>
                {RAIL_LABELS[id]}
              </Text>
            </Show>
          </View>
        );
      }}</For>
    </View>
  );
}
