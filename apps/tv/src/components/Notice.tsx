// apps/tv/src/components/Notice.tsx
import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { usePointerTarget } from '../input/pointer.ts';
import { riseIn } from '../shell/motion.ts';
import { COLORS, MOTION, RADIUS, STRONG, TYPE, centerText } from '../shell/theme.ts';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { NOTICE_PAD, NOTICE_SPINNER, SPINNER_DOT, noticeIds, noticeStack, sameIds, spinnerDots, type NoticeSpec, type PlacedNotice } from './noticeLogic.ts';
import { keepSpaces, textWidth } from './textWidth.ts';

export interface NoticeEntry extends NoticeSpec { onAction?: () => void }

const [entries, setEntries] = createSignal<readonly NoticeEntry[]>([]);

/**
 * Shows `spec()` while it returns one and removes it when it returns undefined or the owner unmounts: the "wait" kind
 * (stays while true: Loading…, Offline) and screen-owned errors (the refusal cooldown). Toasts use `showToast`.
 */
export function useNotice(spec: () => NoticeEntry | undefined): void {
  let shown: string | undefined;
  const drop = (id: string) => setEntries((l) => l.filter((e) => e.id !== id));
  createEffect(() => {
    const s = spec();
    if (shown !== undefined && shown !== s?.id) drop(shown);
    if (s) setEntries((l) => [...l.filter((e) => e.id !== s.id), s]);
    shown = s?.id;
  });
  onCleanup(() => { if (shown !== undefined) drop(shown); });
}

const DOTS = spinnerDots();

/** Eight dots, one lit at a time, 120 ms a step; sleeps while the page is hidden. */
function Spinner(props: { x: number; y: number }) {
  const [tick, setTick] = createSignal(0);
  onCleanup(visibleInterval(() => setTick((v) => (v + 1) % 8), 120));
  return (
    <View x={props.x} y={props.y} width={NOTICE_SPINNER} height={NOTICE_SPINNER}>
      <For each={DOTS}>{(d, i) => (
        <View x={d.x} y={d.y} width={SPINNER_DOT} height={SPINNER_DOT} borderRadius={RADIUS.pill(SPINNER_DOT)}
          color={(i() - tick() + 8) % 8 === 0 ? COLORS.text : COLORS.muted} />
      )}</For>
    </View>
  );
}

/** One notice pill (`panel` fill, pill radius). A click on an error with an action runs it, like OK on its screen. */
export function NoticePill(props: { placed: PlacedNotice; onAction?: () => void }) {
  let node: ElementNode | undefined;
  usePointerTarget({ node: () => node, enabled: () => props.onAction !== undefined, onClick: () => props.onAction?.() });
  const p = () => props.placed;
  const size = () => (p().spec.numeral ? TYPE.numeral : TYPE.body);
  return (
    <View ref={(el) => { node = el; riseIn(el, MOTION.toastIn); }} x={p().x} y={p().y} width={p().w} height={p().h}
      color={COLORS.panel} borderRadius={RADIUS.pill(p().h)} zIndex={30}>
      <Show when={p().spec.spinner}><Spinner x={NOTICE_PAD} y={(p().h - NOTICE_SPINNER) / 2} /></Show>
      <Text x={p().textX} y={centerText(p().h, size())} width={p().textW} maxWidth={p().textW} contain="width" maxLines={1}
        fontSize={size()} {...(p().spec.numeral ? STRONG : {})} color={COLORS.text}>{keepSpaces(p().spec.text)}</Text>
      <Show when={p().actionX !== undefined}>
        <Text x={p().actionX ?? 0} y={centerText(p().h, TYPE.body)} maxLines={1} fontSize={TYPE.body} {...STRONG}
          color={COLORS.text}>{p().spec.action ?? ''}</Text>
      </Show>
    </View>
  );
}

/**
 * The app-level host (App.tsx): every notice registered with `useNotice`, plus `extra` (the toast queue's current one).
 * Pills are keyed by notice id, so one that stays keeps its node (no rise-in replay, the spinner keeps turning) and only
 * its position and text update; the id list changes only when a notice comes or goes.
 */
export function NoticeLayer(props: { extra?: () => NoticeEntry | undefined }) {
  const placed = createMemo(() => {
    const t = props.extra?.();
    return noticeStack(t ? [...entries(), t] : [...entries()], textWidth);
  });
  const ids = createMemo(() => noticeIds(placed()), [], { equals: sameIds });
  return (
    <For each={ids()}>{(id) => {
      // Keeps the last placement while the pill is being removed, so it never reads a missing one.
      const p = createMemo<PlacedNotice>((prev) => placed().find((x) => x.spec.id === id) ?? prev!);
      return <NoticePill placed={p()} onAction={(p().spec as NoticeEntry).onAction} />;
    }}</For>
  );
}
