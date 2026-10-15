import { For, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { createDebounce } from '../playback/debounce.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { TABS, TABS_W, TAB_GAP, TAB_H, TAB_LABELS, TAB_SWITCH_MS, TAB_W, stepTab, tabAt, type TabId } from '../vod/tabLogic.ts';

export const TAB_BAR_X = LAYOUT.safeX;
export const TAB_BAR_Y = LAYOUT.safeY + 20;

/**
 * Live TV · Movies. One focusable node: Left/Right move a cursor, and resting on another tab for TAB_SWITCH_MS
 * switches to it (Ok switches at once). Unfocused, it shows the active tab. Pointer: a click switches.
 */
export function TabBar(props: {
  ref?: (el: ElementNode) => void;
  active: TabId;
  onSelect: (t: TabId) => void;
  onDown: () => boolean;
  onFocusChanged?: (f: boolean) => void;
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [cursor, setCursor] = createSignal<TabId>(props.active);
  const [hover, setHover] = createSignal<TabId | undefined>(undefined);
  let node: ElementNode | undefined;
  const debounce = createDebounce<TabId>(TAB_SWITCH_MS, (t) => { if (t !== props.active) props.onSelect(t); });
  onCleanup(() => debounce.cancel());
  const move = (d: 1 | -1) => {
    const next = stepTab(cursor(), d);
    if (next !== cursor()) {
      setCursor(next);
      debounce.schedule(next);
    }
    return true;
  };
  const onDown = () => {
    if (debounce.pending()) {
      debounce.cancel();
      props.onSelect(cursor());
      return true;
    }
    return props.onDown();
  };
  usePointerTarget({
    node: () => node,
    enabled: () => props.pointerEnabled !== false,
    onHover: (p) => setHover(p ? tabAt(p.x) : undefined),
    subAt: (p) => {
      const t = tabAt(p.x);
      return t ? TABS.indexOf(t) : undefined;
    },
    onClick: (p) => {
      const t = tabAt(p.x);
      if (!t) return;
      debounce.cancel();
      setCursor(t);
      if (t !== props.active) props.onSelect(t);
    },
  });
  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={TAB_BAR_X} y={TAB_BAR_Y} width={TABS_W} height={TAB_H}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        if (f) setCursor(props.active);
        else debounce.cancel();
        props.onFocusChanged?.(f);
      }}
      onLeft={() => move(-1)} onRight={() => move(1)} onUp={() => true} onDown={onDown}
      onEnter={() => {
        debounce.cancel();
        if (cursor() !== props.active) props.onSelect(cursor());
        return true;
      }}>
      <For each={TABS}>{(t, i) => {
        const lit = () => focused() && cursor() === t;
        const active = () => t === props.active;
        const fill = () => (lit() ? COLORS.focus : active() ? COLORS.surface : hover() === t && pointerMode() ? COLORS.hover : 0x00000000);
        return (
          <View x={i() * (TAB_W + TAB_GAP)} width={TAB_W} height={TAB_H} borderRadius={TAB_H / 2} color={fill()}>
            <Text y={(TAB_H - FONT.small) / 2 - 3} width={TAB_W} maxWidth={TAB_W} contain="width" textAlign="center" fontSize={FONT.small}
              color={lit() ? COLORS.onFocus : active() ? COLORS.text : COLORS.muted}>{TAB_LABELS[t]}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}
