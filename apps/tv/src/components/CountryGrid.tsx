import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { Match, Switch, createMemo, createSignal } from 'solid-js';
import type { CountryChoice } from '@iptv/app-api';
import { COUNTRIES_COPY } from '../copy.ts';
import { pointerMode, usePointerFocus, usePointerTarget } from '../input/pointer.ts';
import { motionLevel, tween, useFocusScale } from '../shell/motion.ts';
import { COLORS, FOCUS, MOTION, RADIUS, STRONG, TYPE } from '../shell/theme.ts';
import { Badge } from './Badge.tsx';
import { FocusRing } from './FocusRing.tsx';
import {
  CHIP, ROW_PITCH, DEVICE_CHIP_BOXES, CHIP_BOXES, cellAt, chipArt, chipLabel, choiceFolders, clampFocus, firstFocus, gridRows, keyAt, moveGrid, pickNumber,
  rowTops, scrollFor, type ChipArt, type GridEdge, type GridFocus, type GridSort,
} from './countryGridLogic.ts';

export interface CountryGridProps {
  ref?: (el: ElementNode) => void;
  x: number; y: number; width: number; height: number;
  choices: readonly CountryChoice[];
  codes: readonly string[];
  deviceCountry?: string;
  sort: GridSort;
  onSort: () => void;
  onToggle: (key: string) => void;
  /** Focus leaves the grid: Up from the top row, Down from the last, Left from column 0. True when handled. */
  onEdge: (edge: GridEdge) => boolean;
  flagOf: (key: string) => string | undefined;
  columns?: 3 | 4;
  /** The chip focused first (this TV's country). */
  initialKey?: string;
}

const NAME_SIZE = 32;
const COUNT_SIZE = 28;

function Chip(p: {
  choice: CountryChoice; x: number; y: number; lit: boolean; hover: boolean; number: number | undefined; device: boolean;
  art: ChipArt; ref: (el: ElementNode | undefined) => void;
}) {
  let node: ElementNode | undefined;
  useFocusScale(() => node, () => p.lit);
  const picked = () => p.number !== undefined;
  /** This TV's chip moves the flag left and puts the "This TV" badge beside it; name and count stay full width. */
  const box = () => (p.device ? DEVICE_CHIP_BOXES : CHIP_BOXES);
  return (
    <View ref={(el) => { node = el; p.ref(el); }} x={p.x} y={p.y} width={CHIP.w} height={CHIP.h}>
      <FocusRing w={CHIP.w} h={CHIP.h} radius={RADIUS.card} lit={p.lit} hover={p.hover} />
      <View width={CHIP.w} height={CHIP.h} zIndex={1} borderRadius={RADIUS.card}
        color={picked() ? COLORS.surfaceRaised : COLORS.surface}
        border={picked() ? { width: 4, color: COLORS.accent } : { width: 0, color: COLORS.transparent }}>
        <Show when={'src' in p.art ? p.art.src : undefined} fallback={
          <View x={box().flag.x} y={box().flag.y} width={box().flag.w} height={box().flag.h} borderRadius={RADIUS.card} color={COLORS.surfaceRaised}>
            <Text y={(box().flag.h - TYPE.body) / 2 - 4} width={box().flag.w} maxWidth={box().flag.w} contain="width" textAlign="center"
              fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{'badge' in p.art ? p.art.badge : ''}</Text>
          </View>
        }>{(src) => <View x={box().flag.x} y={box().flag.y} width={box().flag.w} height={box().flag.h} src={src()} />}</Show>
        <Text x={box().name.x} y={box().name.y} width={box().name.w} height={box().name.h} maxWidth={box().name.w} contain="width" maxLines={1}
          textAlign="center" fontSize={NAME_SIZE} {...STRONG} color={COLORS.text}>{p.choice.label}</Text>
        <Text x={box().count.x} y={box().count.y} width={box().count.w} height={box().count.h} maxWidth={box().count.w} contain="width"
          maxLines={1} textAlign="center" fontSize={COUNT_SIZE} color={COLORS.textSecondary}>
          {COUNTRIES_COPY.folders(choiceFolders(p.choice))}
        </Text>
        <Show when={p.device ? DEVICE_CHIP_BOXES.device : undefined}>{(d) => (
          <Badge x={d().x} y={d().y} text={COUNTRIES_COPY.thisTv} />
        )}</Show>
        <Show when={p.number}>{(n) => (
          <Badge x={box().pill.x} y={box().pill.y} tone="selected" text={`✓ ${n()}`} />
        )}</Show>
      </View>
    </View>
  );
}

/**
 * Your countries' flag grid (spec 2026-10-22-your-countries-flags): one focusable node; Up/Down between rows, Left/Right
 * within one, OK toggles the focused chip (or the A–Z toggle). Only the rows on screen are drawn, so at most 16 flag
 * textures load at once. Pointer: a click does what OK does.
 */
export function CountryGrid(props: CountryGridProps) {
  const columns = () => props.columns ?? 4;
  const rows = createMemo(() => gridRows(props.choices, props.sort, columns(), props.deviceCountry));
  const [focusRaw, setFocus] = createSignal<GridFocus>(firstFocus(rows(), props.initialKey));
  const focus = () => clampFocus(rows(), focusRaw());
  const [focused, setFocused] = createSignal(false);
  const [hover, setHover] = createSignal<GridFocus | undefined>(undefined);
  const focusFromPointer = usePointerFocus();
  const chipNodes = new Map<string, ElementNode>();
  let node: ElementNode | undefined;
  let lastTop = 0;
  const scrollTop = createMemo(() => {
    lastTop = scrollFor(rows(), focus().row, lastTop, props.height);
    return lastTop;
  });
  const tops = createMemo(() => rowTops(rows()));
  const byKey = createMemo(() => new Map(props.choices.map((c) => [c.key, c])));
  const order = createMemo(() => rows().flatMap((r) => (r.kind === 'chips' ? r.keys : [])));
  /** Indexes of the rows on screen (numbers, so `For` keeps their nodes while the grid scrolls). */
  const onScreen = createMemo(() => {
    const out: number[] = [];
    rows().forEach((r, i) => {
      const t = tops()[i]!;
      if (t + ROW_PITCH[r.kind] > scrollTop() && t < scrollTop() + props.height) out.push(i);
    });
    return out;
  });

  const pulse = (key: string) => {
    const n = chipNodes.get(key);
    if (!n || motionLevel() !== 'full') return;
    // Settle on the chip's current state: still focused keeps the focus scale, otherwise it is back to 1.
    const settle = () => (focused() && keyAt(rows(), focus()) === key ? FOCUS.scale : 1);
    tween(n, { scale: FOCUS.press }, MOTION.pressIn, () => tween(n, { scale: settle() }, MOTION.pressOut));
  };
  /** The focused chip's label sits on the grid node, the one node in the focus path, so the announcer reads it. */
  const focusLabel = () => {
    const key = keyAt(rows(), focus());
    const ch = key === undefined ? undefined : byKey().get(key);
    return ch ? chipLabel(ch, props.codes, order().indexOf(key!), order().length) : undefined;
  };
  const activate = (f: GridFocus) => {
    const row = rows()[f.row];
    if (row?.kind === 'sort') { if (row.toggle) props.onSort(); return; }
    const key = keyAt(rows(), f);
    if (key === undefined) return;
    props.onToggle(key);
    pulse(key);
  };
  const go = (dir: 'up' | 'down' | 'left' | 'right') => {
    const m = moveGrid(rows(), focus(), dir);
    if ('focus' in m) { setFocus(m.focus); return true; }
    return props.onEdge(m.edge);
  };

  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? cellAt(rows(), scrollTop(), p) : undefined),
    onClick: (p) => {
      const f = cellAt(rows(), scrollTop(), p);
      if (!f) return;
      setFocus(f);
      focusFromPointer(node);
      activate(f);
    },
    onWheel: (dy) => {
      if (dy !== 0) go(dy > 0 ? 'down' : 'up');
      return true;
    },
  });

  return (
    <View ref={(el) => { node = el; props.ref?.(el); }} x={props.x} y={props.y} width={props.width} height={props.height} clipping announce={focusLabel()}
      onFocusChanged={setFocused} onUp={() => go('up')} onDown={() => go('down')} onLeft={() => go('left')}
      onRight={() => go('right')} onEnter={() => { activate(focus()); return true; }}>
      <For each={onScreen()}>{(i) => {
        const row = () => rows()[i];
        const y = () => (tops()[i] ?? 0) - scrollTop();
        const toggle = () => { const r = row(); return r?.kind === 'sort' && r.toggle; };
        const keys = () => { const r = row(); return r?.kind === 'chips' ? r.keys : []; };
        const sortLit = () => focused() && focus().row === i;
        return (
          <Switch>
            <Match when={row()?.kind === 'sort'}>
              <View y={y()} width={300} height={48} borderRadius={24}
                color={toggle() ? (sortLit() ? COLORS.focus : COLORS.surfaceRaised) : COLORS.transparent}>
                <Text x={toggle() ? 24 : 0} y={(48 - TYPE.meta) / 2 - 3} width={276} maxWidth={276} contain="width" maxLines={1}
                  fontSize={TYPE.meta} color={sortLit() ? COLORS.onFocus : COLORS.muted}>
                  {props.sort === 'az' ? COUNTRIES_COPY.sortAz : COUNTRIES_COPY.sortMost}
                </Text>
              </View>
            </Match>
            <Match when={row()?.kind === 'heading'}>
              <Text y={y() + 12} fontSize={TYPE.body} {...STRONG} color={COLORS.textSecondary}>{COUNTRIES_COPY.languages}</Text>
            </Match>
            <Match when={row()?.kind === 'chips'}>
              <For each={keys()}>{(key, col) => {
                const lit = () => focused() && focus().row === i && focus().col === col();
                const hovered = () => pointerMode() && hover()?.row === i && hover()?.col === col();
                return (
                  <Show when={byKey().get(key)}>{(ch) => (
                    <Chip choice={ch()} x={col() * (CHIP.w + CHIP.gap)} y={y()} lit={lit()} hover={hovered()}
                      number={pickNumber(props.codes, key)} device={key === props.deviceCountry}
                      art={chipArt(key, props.flagOf)}
                      ref={(el) => { if (el) chipNodes.set(key, el); else chipNodes.delete(key); }} />
                  )}</Show>
                );
              }}</For>
            </Match>
          </Switch>
        );
      }}</For>
    </View>
  );
}
