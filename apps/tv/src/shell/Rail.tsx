import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { pointerMode, usePointerTarget } from '../input/pointer.ts';
import { settings } from '../state/appState.ts';
import { iconTexture } from '../vod/icons.ts';
import { Clock } from './Clock.tsx';
import { stopMotion, tween } from './motion.ts';
import {
  onRailClose, RAIL_CLOSE, RAIL_ICON, RAIL_ITEMS, RAIL_LABELS, RAIL_OPEN_W, RAIL_ROW_H, railIcon, railItemAt, railY, stepRail, type RailId,
} from './railLogic.ts';
import { centerText, COLORS, LAYOUT, MOTION, RADIUS, SPACE, STRONG, TYPE } from './theme.ts';

/** The open panel's x while closed: tucked behind the collapsed rail. */
const PANEL_HIDDEN_X = LAYOUT.railW - RAIL_OPEN_W;
/** The close button's icon, and the current-item mark beside the icons. */
const CLOSE_ICON = 28;
const MARK_W = 4;
const MARK_H = 28;

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
 * Motion: opening slides the panel out from behind the collapsed rail (its `x`, never its width) while the scrim and
 * the labels fade in (160 ms); closing slides it back and fades the scrim (120 ms). Focus and keys never wait for it.
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
  /** The panel and scrim stay mounted; the motion helper owns their `x` and `alpha` (never bound as props). */
  let panel: ElementNode | undefined;
  let scrim: ElementNode | undefined;
  createEffect(on(open, (o, prev) => {
    if (!panel || !scrim) return;
    const x = o ? 0 : PANEL_HIDDEN_X;
    if (prev === undefined) {
      stopMotion(panel); stopMotion(scrim);
      panel.x = x; panel.alpha = o ? 1 : 0; scrim.alpha = o ? 1 : 0;
      return;
    }
    const token = o ? MOTION.railOpen : MOTION.railClose;
    if (o) panel.alpha = 1;
    const p = panel;
    tween(p, { x }, token, o ? undefined : () => { p.alpha = 0; });
    tween(scrim, { alpha: o ? 1 : 0 }, token);
  }));
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
  const lit = (id: RailId) => focused() && cursor() === id;
  const hovered = (id: RailId) => pointerMode() && hover() === id;
  const tint = (id: RailId) => (lit(id) || hovered(id) ? COLORS.onFocus : id === props.active || open() ? COLORS.text : COLORS.subtle);
  /** The labels share one layer, so they fade in as one animation once it is rendered. */
  const fadeIn = (el: ElementNode) => {
    el.alpha = MOTION.startAlpha;
    queueMicrotask(() => tween(el, { alpha: 1 }, MOTION.railOpen));
  };
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
      <View ref={(el) => { scrim = el; el.alpha = 0; }} x={RAIL_OPEN_W} width={LAYOUT.width - RAIL_OPEN_W} height={LAYOUT.height} zIndex={0} color={COLORS.scrim} />
      <View ref={(el) => { panel = el; el.alpha = 0; el.x = PANEL_HIDDEN_X; }} width={RAIL_OPEN_W} height={LAYOUT.height} zIndex={0} color={COLORS.background} />
      <Show when={open()}>
        <Show when={pointerMode()}>
          <View x={RAIL_CLOSE.x} y={RAIL_CLOSE.y} width={RAIL_CLOSE.size} height={RAIL_CLOSE.size} borderRadius={RADIUS.pill(RAIL_CLOSE.size)} zIndex={1}
            color={hover() === 'close' ? COLORS.focus : COLORS.background}>
            <View x={(RAIL_CLOSE.size - CLOSE_ICON) / 2} y={(RAIL_CLOSE.size - CLOSE_ICON) / 2} width={CLOSE_ICON} height={CLOSE_ICON} zIndex={2} src={iconTexture('close')}
              color={hover() === 'close' ? COLORS.onFocus : COLORS.subtle} />
          </View>
        </Show>
      </Show>
      <Show when={settings()?.showClock === true}>
        <Clock x={0} y={LAYOUT.safeY} width={LAYOUT.railW} align="center" size={TYPE.meta} />
      </Show>
      <For each={RAIL_ITEMS}>{(id) => {
        const current = () => id === props.active;
        return (
          <View y={railY(id)} zIndex={1}>
            <Show when={lit(id)}>
              <View x={24} y={-pad} width={width() - 48} height={RAIL_ROW_H} borderRadius={RADIUS.pill(RAIL_ROW_H)} zIndex={1} color={COLORS.focus} />
            </Show>
            <Show when={!lit(id) && pointerMode() && hover() === id}>
              <View x={24} y={-pad} width={width() - 48} height={RAIL_ROW_H} borderRadius={RADIUS.pill(RAIL_ROW_H)} zIndex={1} color={COLORS.focus} />
            </Show>
            <Show when={current() && !lit(id)}>
              <View x={SPACE.m} y={(RAIL_ICON - MARK_H) / 2} width={MARK_W} height={MARK_H} borderRadius={RADIUS.pill(MARK_W)} zIndex={1} color={COLORS.text} />
            </Show>
            <View x={(LAYOUT.railW - RAIL_ICON) / 2} width={RAIL_ICON} height={RAIL_ICON} zIndex={2} src={iconTexture(railIcon(id))} color={tint(id)} />
          </View>
        );
      }}</For>
      <Show when={open()}>
        <View ref={fadeIn} zIndex={2}>
          <For each={RAIL_ITEMS}>{(id) => (
            <Text x={LAYOUT.railW - 8} y={railY(id) + centerText(RAIL_ICON, TYPE.body)} fontSize={TYPE.body} zIndex={2}
              {...(id === props.active ? STRONG : {})} color={tint(id)}>
              {RAIL_LABELS[id]}
            </Text>
          )}</For>
        </View>
      </Show>
    </View>
  );
}
