import { For, Show, Text, View, type ElementNode, type JSX } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { pointerMode, usePointerBackdrop, usePointerTarget, type Point } from '../input/pointer.ts';
import { panelRowHit } from '../input/pointerLogic.ts';
import { drawnFocus } from '../shell/focusStyle.ts';
import { riseIn, scrimIn } from '../shell/motion.ts';
import { router } from '../shell/router.ts';
import { COLORS, LAYOUT, RADIUS, SPACE, STRONG, TYPE, centerText } from '../shell/theme.ts';
import { BADGE_H, Badge } from './Badge.tsx';
import {
  SHEET_CHECK_W, SHEET_FOOTER_LINE, SHEET_ICON_H, SHEET_ICON_W, SHEET_MAX_ROWS, SHEET_MORE_W, SHEET_PAD, SHEET_PITCH, SHEET_ROW_GAP,
  SHEET_ROW_H, SHEET_TABS_H, SHEET_VALUE_W, fromOptionItem, sheetClamp, sheetFollow, sheetFooter, sheetFrame, sheetListTop, sheetMore,
  sheetScroll, sheetSelectable, sheetStep, stackOpen, stackPop, stackPush, stackRestore, stackTop, tabStep,
  type OptionItem, type SheetPage, type SheetPlacement, type SheetRow, type SheetStack, type SheetTab,
} from './sheetLogic.ts';

export interface SheetProps {
  ref: (el: ElementNode) => void;
  title: string;
  rows: readonly SheetRow[];
  /** OK on a row (not on a `page` row, which opens in place). The sheet stays open: the caller decides. */
  onSelect: (row: SheetRow, index: number) => void;
  /** Default 'side' (right, 640 wide). */
  placement?: SheetPlacement;
  /** Tabs replace `title`'s rows with the active tab's page; Left/Right switch them. */
  tabs?: readonly SheetTab[];
  /** Left (-1) / Right (1) on the selected row (a delay); true when handled. */
  onAdjust?: (row: SheetRow, index: number, dir: 1 | -1) => boolean;
  /** A status or attribution line ("Loading…"). Never key hints. */
  footer?: string;
  /** The row selected when the sheet opens, and again whenever `resetKey` changes. */
  initial?: number;
  resetKey?: string;
  /** 'id': the selection stays on the same row id when the rows change (action menus). Default 'index'. */
  follow?: 'index' | 'id';
  /** Default true. False over full-screen video (the old right-hand options menu had none). */
  scrim?: boolean;
  /** 'player' also swallows digits, CH±, Info and Red so they never reach the player underneath. */
  swallow?: 'menu' | 'player';
  /** False: neither the sheet nor its backdrop takes the pointer (a keyboard is open above). Default true. */
  pointerEnabled?: boolean;
  zIndex?: number;
  /** Prefix of the Back layer each open sub-page pushes. Default 'sheet'. */
  backLayerId?: string;
}

const DIGITS = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [`onDigit${d}`, () => true]));
const PLAYER_KEYS = { ...DIGITS, onChannelUp: () => true, onChannelDown: () => true, onInfo: () => true, onRed: () => true };

/** One sheet row: focus fill with onFocus text when lit; at rest no fill. A selected row shows a ✓ in accent. */
export function SheetRowView(props: { x?: number; y: number; width: number; row: SheetRow; lit: boolean }) {
  const x = () => props.x ?? 0;
  const fg = () => (props.lit ? COLORS.onFocus : props.row.quiet ? COLORS.muted : COLORS.text);
  const sub = () => (props.lit ? COLORS.onFocusMuted : COLORS.muted);
  const opens = () => props.row.more === true || props.row.page !== undefined;
  const lead = () => (props.row.icon ? SPACE.l + SHEET_ICON_W + SPACE.m : SPACE.l);
  const moreX = () => props.width - SPACE.l - SHEET_MORE_W;
  const checkX = () => props.width - SPACE.l - (opens() ? SHEET_MORE_W : 0) - SHEET_CHECK_W;
  const valueX = () => checkX() + (props.row.checked ? 0 : SHEET_CHECK_W) - SHEET_VALUE_W;
  const labelW = () => (props.row.value !== undefined ? valueX() - SPACE.m : checkX()) - lead();
  return (
    <Show when={!props.row.heading} fallback={
      <Text x={x() + SPACE.l} y={props.y + SHEET_ROW_H - TYPE.meta - SPACE.m} width={props.width - SPACE.xl} maxWidth={props.width - SPACE.xl}
        contain="width" maxLines={1} fontSize={TYPE.meta} {...STRONG} color={COLORS.muted}>{props.row.label}</Text>
    }>
      <View x={x()} y={props.y} width={props.width} height={SHEET_ROW_H} borderRadius={RADIUS.card}
        color={props.lit ? COLORS.focus : COLORS.transparent}>
        <Show when={props.row.icon}>{(icon) => (
          <Show when={icon().src} fallback={<Badge x={SPACE.l} y={(SHEET_ROW_H - BADGE_H) / 2} text={icon().badge ?? ''} lit={props.lit} />}>
            {(src) => <View x={SPACE.l} y={(SHEET_ROW_H - SHEET_ICON_H) / 2} width={SHEET_ICON_W} height={SHEET_ICON_H} src={src()} />}
          </Show>
        )}</Show>
        <Text x={lead()} y={centerText(SHEET_ROW_H, TYPE.body)} width={labelW()} maxWidth={labelW()} contain="width" maxLines={1}
          fontSize={TYPE.body} color={fg()}>{props.row.label}</Text>
        <Show when={props.row.value !== undefined}>
          <Text x={valueX()} y={centerText(SHEET_ROW_H, TYPE.body)} width={SHEET_VALUE_W} maxWidth={SHEET_VALUE_W} contain="width"
            textAlign="right" maxLines={1} fontSize={TYPE.body} color={sub()}>{props.row.value ?? ''}</Text>
        </Show>
        <Show when={props.row.checked}>
          <Text x={checkX()} y={centerText(SHEET_ROW_H, TYPE.body)} width={SHEET_CHECK_W} maxWidth={SHEET_CHECK_W} contain="width"
            textAlign="center" fontSize={TYPE.body} color={props.lit ? COLORS.onFocus : COLORS.accent}>{'✓'}</Text>
        </Show>
        <Show when={opens()}>
          <Text x={moreX()} y={centerText(SHEET_ROW_H, TYPE.body)} fontSize={TYPE.body} color={fg()}>{'›'}</Text>
        </Show>
      </View>
    </Show>
  );
}

/**
 * The one menu surface (spec 2026-10-26 §1.3). One focusable node; see the key contract in the plan (Task 7). It handles
 * no Back at its top level: the caller registers it with `router.pushOverlay`, so Back closes it.
 */
export function Sheet(props: SheetProps) {
  const [selIndex, setSelIndex] = createSignal(props.initial ?? 0);
  const [selId, setSelId] = createSignal<string | undefined>(undefined);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  const [tab, setTab] = createSignal(0);
  const [stack, setStack] = createSignal<SheetStack | undefined>(undefined);
  createEffect(on(() => props.resetKey, () => { setSelIndex(props.initial ?? 0); setSelId(undefined); }, { defer: true }));

  const hasTabs = () => props.tabs !== undefined && props.tabs.length > 0 && stack() === undefined;
  const page = (): SheetPage => {
    const s = stack();
    if (s) return stackTop(s);
    const t = props.tabs?.[tab()];
    return t ? t.page : { id: 'root', title: props.title, rows: props.rows };
  };
  const rows = () => page().rows;
  const header = () => (stack() ? `‹ ${page().title}` : props.title);
  const current = () => (props.follow === 'id' ? sheetFollow(selId(), selIndex(), rows()) : sheetClamp(selIndex(), rows()));
  const setSel = (i: number) => { setSelIndex(i); setSelId(rows()[i]?.id); };
  let top = 0;
  const scrollTop = createMemo(() => { top = sheetScroll(current(), top, rows().length); return top; });
  const shown = () => Math.min(SHEET_MAX_ROWS, Math.max(rows().length, 1));
  const footer = () => sheetFooter(rows(), current(), props.footer, sheetMore(scrollTop(), rows().length));
  const frame = () => sheetFrame(props.placement ?? 'side', shown(), footer().length, hasTabs());
  const listTop = () => sheetListTop(hasTabs());
  const tabW = () => (frame().w - SHEET_PAD * 2) / (props.tabs?.length || 1);
  const visible = () => rows().slice(scrollTop(), scrollTop() + SHEET_MAX_ROWS).map((row, k) => ({ row, i: scrollTop() + k }));
  const lit = () => drawnFocus(current(), hover(), pointerMode());

  const layers: (() => void)[] = [];
  const pop = () => {
    const s = stack();
    if (!s) return;
    layers.pop();
    const below = stackPop(s);
    setStack(below && below.pages.length > 1 ? below : undefined);
    setSelIndex(stackRestore(s));
    setSelId(undefined);
  };
  const push = (sub: SheetPage) => {
    const next = stackPush(stack() ?? stackOpen(page()), sub, current());
    setStack(next);
    setSelIndex(0);
    setSelId(undefined);
    layers.push(router.pushOverlay(`${props.backLayerId ?? 'sheet'}:${next.pages.length - 1}`, pop));
  };
  onCleanup(() => { while (layers.length > 0) layers.pop()!(); });

  const move = (d: 1 | -1) => { setSel(sheetStep(current(), d, rows())); return true; };
  const side = (d: 1 | -1) => {
    const i = current();
    const r = rows()[i];
    if (props.onAdjust && r && sheetSelectable(r)) { props.onAdjust(r, i, d); return true; }
    if (hasTabs()) { setTab(tabStep(tab(), d, props.tabs!.length)); setSelIndex(0); setSelId(undefined); }
    return true;
  };
  const enter = (i: number) => {
    const r = rows()[i];
    if (!r || !sheetSelectable(r)) return;
    if (r.page) push(r.page);
    else props.onSelect(r, i);
  };

  let backdrop: ElementNode | undefined;
  let lift: ElementNode | undefined;
  let panel: ElementNode | undefined;
  const indexAt = (p: Point) => {
    const k = panelRowHit(p, frame().w, SHEET_PAD, listTop(), SHEET_PITCH, SHEET_ROW_GAP, Math.min(SHEET_MAX_ROWS, rows().length - scrollTop()));
    return k === undefined ? undefined : scrollTop() + k;
  };
  const enabled = () => props.pointerEnabled !== false;
  // Backdrop first, then the panel: the panel wins where they overlap.
  usePointerBackdrop(() => backdrop, undefined, false, enabled);
  usePointerTarget({
    node: () => panel,
    layer: 'overlay',
    enabled,
    subAt: (p) => indexAt(p),
    onHover: (p) => {
      const i = p ? indexAt(p) : undefined;
      setHover(i !== undefined && sheetSelectable(rows()[i]) ? i : undefined);
    },
    onClick: (p) => {
      const i = indexAt(p);
      if (i === undefined) return;
      setSel(i);
      enter(i);
    },
    onWheel: (dy) => { if (dy !== 0) move(dy > 0 ? 1 : -1); return true; },
  });
  const scrim = () => props.scrim !== false;

  return (
    <View ref={(el) => { backdrop = el; if (scrim()) scrimIn(el, () => lift); }} width={LAYOUT.width} height={LAYOUT.height}
      color={scrim() ? COLORS.scrim : COLORS.transparent} zIndex={props.zIndex ?? 60}>
      <View ref={(el) => { lift = el; if (!scrim()) riseIn(el); }}>
        <View ref={(el) => { panel = el; props.ref(el); }} x={frame().x} y={frame().y} width={frame().w} height={frame().h}
          color={COLORS.panel} borderRadius={RADIUS.card}
          onUp={() => move(-1)} onDown={() => move(1)} onLeft={() => side(-1)} onRight={() => side(1)}
          onMenu={() => true} onLongOk={() => true} {...(props.swallow === 'player' ? PLAYER_KEYS : {})}
          onEnter={() => { enter(current()); return true; }}>
          <Text x={SHEET_PAD} y={SHEET_PAD} width={frame().w - SHEET_PAD * 2} maxWidth={frame().w - SHEET_PAD * 2} contain="width"
            maxLines={1} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{header()}</Text>
          <Show when={hasTabs()}>
            <For each={props.tabs ?? []}>{(t, k) => (
              <Text x={SHEET_PAD + k() * tabW()} y={SHEET_PAD + SHEET_TABS_H}
                fontSize={TYPE.body} {...(k() === tab() ? STRONG : {})} color={k() === tab() ? COLORS.text : COLORS.muted}>{t.label}</Text>
            )}</For>
          </Show>
          <For each={visible()}>{(v) => (
            <SheetRowView x={SHEET_PAD} y={listTop() + (v.i - scrollTop()) * SHEET_PITCH} width={frame().w - SHEET_PAD * 2}
              row={v.row} lit={lit() === v.i} />
          )}</For>
          <For each={footer()}>{(line, k) => (
            <Text x={SHEET_PAD} y={listTop() + shown() * SHEET_PITCH - SHEET_ROW_GAP + SPACE.s + k() * SHEET_FOOTER_LINE}
              width={frame().w - SHEET_PAD * 2} maxWidth={frame().w - SHEET_PAD * 2} contain="width" maxLines={1}
              fontSize={TYPE.meta} color={COLORS.muted}>{line}</Text>
          )}</For>
        </View>
      </View>
    </View>
  );
}

/**
 * A promise-based action sheet as a router overlay (Back answers undefined), replacing `createChoiceMenu`
 * (`components/choiceMenu.tsx`) with the same contract: `close()` removes it silently (the screen is going away);
 * `close({ answer: true })` closes it like Back from code. Drawn like the old right-hand options menu: no scrim, the
 * player keys swallowed.
 */
export function createSheetChoice(id: string, refocus: () => void) {
  const [state, setState] = createSignal<{ title: string; items: OptionItem[]; answer: (v?: string) => void } | undefined>();
  let node: ElementNode | undefined;
  let removeLayer: (() => void) | undefined;
  const close = (o?: { answer?: boolean }) => {
    const s = state();
    if (o?.answer && s) { s.answer(undefined); return; }
    removeLayer?.(); removeLayer = undefined; setState(undefined);
  };
  const choose = (title: string, items: OptionItem[]) => new Promise<string | undefined>((resolve) => {
    const answer = (v?: string) => { close(); refocus(); resolve(v === 'cancel' ? undefined : v); };
    setState({ title, items, answer });
    removeLayer = router.pushOverlay(id, () => { removeLayer = undefined; setState(undefined); refocus(); resolve(undefined); });
    queueMicrotask(() => node?.setFocus());
  });
  const SheetView = (): JSX.Element => (
    <Show when={state()}>{(s) => (
      <View zIndex={80}>
        <Sheet ref={(el) => { node = el; }} title={s().title} rows={s().items.map(fromOptionItem)} scrim={false} swallow="player" zIndex={40}
          onSelect={(r) => s().answer(r.id)} />
      </View>
    )}</Show>
  );
  return { choose, close, isOpen: () => state() !== undefined, View: SheetView };
}
