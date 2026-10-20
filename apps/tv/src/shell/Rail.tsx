import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { settings } from '../state/appState.ts';
import { iconTexture } from '../vod/icons.ts';
import { Clock } from './Clock.tsx';
import {
  onRailClose, RAIL_CLOSE, RAIL_ICON, RAIL_ITEMS, RAIL_LABELS, RAIL_OPEN_W, RAIL_ROW_H, railIcon, railItemAt, railY, stepRail, type RailId,
} from './railLogic.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from './theme.ts';

/** The rail node that `focusRailCollapsed` is focusing, until its focus arrives (Lightning focuses on a later tick). */
let quietNext: ElementNode | undefined;
/** Each mounted rail's collapse, for a rail that already has the focus. */
const collapsers = new Map<ElementNode, () => void>();

/**
 * Focuses the rail without opening it: for focus a screen moves by itself (it was opened from the rail, or it has no
 * content to focus), so the screen stays in view. The cursor shows on the collapsed icons; Up, Down or Left opens it.
 */
export function focusRailCollapsed(node: ElementNode | undefined): void {
  if (!node) return;
  const collapse = collapsers.get(node);
  if (node.states.has('$focus') && collapse) { collapse(); return; }
  quietNext = node;
  node.setFocus();
}

/**
 * The left rail: one focusable node. Collapsed (128 px) it shows icons, the current screen's in full colour with a
 * bar beside it. Focused from the content (Left, Back) it opens to 320 px over a scrim (content does not move): Up/Down
 * move a cursor, Ok opens the item (Ok on the current screen returns to the content), Right returns to the content.
 * Focus a screen sets by itself (`focusRailCollapsed`) leaves it collapsed with the cursor on the icons; Up, Down or
 * Left opens it. Back is left to the screen.
 * Pointer: a click opens the item; the open rail has a close button in its top-right corner.
 */
export function Rail(props: {
  ref?: (el: ElementNode) => void;
  active: RailId;
  onSelect: (id: RailId) => void;
  onRight: () => boolean;
  onFocusChanged?: (f: boolean) => void;
  /** False: the pointer passes over the rail (a modal keyboard is open). Default true. */
  pointerEnabled?: boolean;
}) {
  const [focused, setFocused] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [cursor, setCursor] = createSignal<RailId>(props.active);
  const [hover, setHover] = createSignal<RailId | 'close' | undefined>(undefined);
  let node: ElementNode | undefined;
  /** Closes the panel and hands focus to the content; with no content to take it, the rail stays focused, collapsed. */
  const close = () => {
    setOpen(false);
    props.onRight();
  };
  const step = (d: 1 | -1) => {
    if (open()) setCursor(stepRail(cursor(), d));
    else setOpen(true);
    return true;
  };
  usePointerTarget({
    node: () => node,
    enabled: () => props.pointerEnabled !== false,
    onHover: (p) => setHover(!p ? undefined : open() && onRailClose(p.x, p.y) ? 'close' : railItemAt(p.y)),
    subAt: (p) => { const id = railItemAt(p.y); return id ? RAIL_ITEMS.indexOf(id) : undefined; },
    onClick: (p) => {
      if (open() && onRailClose(p.x, p.y)) return close();
      const id = railItemAt(p.y);
      if (id) props.onSelect(id);
    },
  });
  onCleanup(() => {
    if (node) collapsers.delete(node);
    if (quietNext === node) quietNext = undefined;
  });
  const pad = (RAIL_ROW_H - RAIL_ICON) / 2;
  const width = () => (open() ? RAIL_OPEN_W : LAYOUT.railW);
  return (
    <View ref={(el) => { node = el; collapsers.set(el, () => setOpen(false)); props.ref?.(el); }} width={width()} height={LAYOUT.height} zIndex={50}
      onFocusChanged={(f: boolean) => {
        setFocused(f);
        setOpen(f && quietNext !== node);
        if (quietNext === node) quietNext = undefined;
        if (f) setCursor(props.active);
        props.onFocusChanged?.(f);
      }}
      onUp={() => step(-1)}
      onDown={() => step(1)}
      onLeft={() => { setOpen(true); return true; }}
      onRight={() => { setOpen(false); return props.onRight(); }}
      onEnter={() => { if (cursor() === props.active) return props.onRight(); props.onSelect(cursor()); return true; }}>
      <Show when={open()}>
        <View x={RAIL_OPEN_W} width={LAYOUT.width - RAIL_OPEN_W} height={LAYOUT.height} zIndex={0} color={COLORS.scrim} />
        <View width={RAIL_OPEN_W} height={LAYOUT.height} zIndex={0} color={COLORS.background} />
        <Show when={pointerMode()}>
          <View x={RAIL_CLOSE.x} y={RAIL_CLOSE.y} width={RAIL_CLOSE.size} height={RAIL_CLOSE.size} borderRadius={RAIL_CLOSE.size / 2} zIndex={1}
            color={hover() === 'close' ? COLORS.hover : COLORS.background}>
            <View x={(RAIL_CLOSE.size - 28) / 2} y={(RAIL_CLOSE.size - 28) / 2} width={28} height={28} zIndex={2} src={iconTexture('close')}
              color={hover() === 'close' ? COLORS.text : COLORS.subtle} />
          </View>
        </Show>
      </Show>
      <Show when={settings()?.showClock === true}>
        <Clock x={0} y={LAYOUT.safeY} width={LAYOUT.railW} align="center" size={TYPE.meta} />
      </Show>
      <For each={RAIL_ITEMS}>{(id) => {
        const lit = () => focused() && cursor() === id;
        const current = () => id === props.active;
        const tint = () => (lit() ? COLORS.onFocus : current() || open() ? COLORS.text : COLORS.subtle);
        return (
          <View y={railY(id)} zIndex={1}>
            <Show when={lit()}>
              <View x={24} y={-pad} width={width() - 48} height={RAIL_ROW_H} borderRadius={RAIL_ROW_H / 2} zIndex={1} color={COLORS.focus} />
            </Show>
            <Show when={!lit() && pointerMode() && hover() === id}>
              <View x={24} y={-pad} width={width() - 48} height={RAIL_ROW_H} borderRadius={RAIL_ROW_H / 2} zIndex={1} color={COLORS.hover} />
            </Show>
            <Show when={current() && !lit()}>
              <View x={20} y={(RAIL_ICON - 28) / 2} width={4} height={28} borderRadius={2} zIndex={1} color={COLORS.text} />
            </Show>
            <View x={(LAYOUT.railW - RAIL_ICON) / 2} width={RAIL_ICON} height={RAIL_ICON} zIndex={2} src={iconTexture(railIcon(id))} color={tint()} />
            <Show when={open()}>
              <Text x={LAYOUT.railW - 8} y={(RAIL_ICON - TYPE.body) / 2 - 2} fontSize={TYPE.body} zIndex={2} {...(current() ? STRONG : {})} color={tint()}>
                {RAIL_LABELS[id]}
              </Text>
            </Show>
          </View>
        );
      }}</For>
    </View>
  );
}
