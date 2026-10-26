import { Text, View, type ElementNode } from '@lightningtv/solid';
import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { GROUP_ALL, GROUP_FAV } from '@iptv/core';
import type { ChannelRow } from '@iptv/app-api';
import { api } from '../../api.ts';
import { ChannelList, ROW_H } from '../../components/ChannelList.tsx';
import { KEYBOARD_H, KEYBOARD_W, Keyboard } from '../../components/Keyboard.tsx';
import { MULTIVIEW_COPY } from '../../copy.ts';
import { router } from '../../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../../shell/theme.ts';
import {
  PICKER_SEARCH_DEBOUNCE_MS, PICKER_SEARCH_LIMIT, answerCount, backDecision, createRequestTokens, focusAfterSearch, searchRowLabel,
} from './pickerSearchLogic.ts';

/** The picker's panel (spec 2026-10-20-multiview §2.3): 560 px on the right, over the dimmed windows. */
export const PICKER_W = 560;
const PAD = 16;
/** The title, the info line under it (up to 2 lines), then the search row. */
const HEAD = 152;
/** The search row is one channel row high, under the title; the list starts below it. */
const LIST_Y = HEAD + ROW_H;
const LIST_H = Math.floor((LAYOUT.height - LIST_Y - LAYOUT.safeY) / ROW_H) * ROW_H;
const ROWS = LIST_H / ROW_H;
/** The keyboard is centred in the area left of the panel. */
const KB_X = (LAYOUT.width - PICKER_W - KEYBOARD_W) / 2;
const KB_Y = (LAYOUT.height - KEYBOARD_H) / 2;
const KEYBOARD_ID = 'multiviewPickerKeyboard';
const CHUNK = 40;

/**
 * Chooses a channel for a window. Favourites when there are some, else all channels. A highlighted row opens nothing:
 * only OK (or a click) picks, so browsing never costs a connection. Rows already in a window say "On screen".
 * Search: a row under the title opens an on-screen keyboard; typing (debounced) replaces the list with matching channels.
 * Back is the screen's (the picker is registered as an overlay there); it asks `backRef`'s function first, which
 * clears a query (returns true) so the list returns before the picker closes. The keyboard is its own overlay layer.
 */
export function MultiviewPicker(props: {
  ref: (el: ElementNode) => void;
  title: string;
  /** The info line under the title (`pickerHint`): it warns, it never blocks. */
  info?: string | undefined;
  now: number;
  onScreen: (channelId: string) => boolean;
  onPick: (channelId: string) => void;
  /** Hands the screen a function for Back: true when the picker used it (cleared the query), false to close. */
  backRef?: (fn: (() => boolean) | undefined) => void;
}) {
  const [group, setGroup] = createSignal(GROUP_ALL);
  const [total, setTotal] = createSignal(0);
  const [rows, setRows] = createSignal<ReadonlyMap<number, ChannelRow>>(new Map());
  const [focus, setFocus] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [query, setQuery] = createSignal('');
  const [found, setFound] = createSignal<{ query: string; rows: readonly ChannelRow[] } | undefined>(undefined);
  const [kbOpen, setKbOpen] = createSignal(false);
  const [searchLit, setSearchLit] = createSignal(false);
  const asked = new Set<number>();
  const tokens = createRequestTokens();
  let list: ElementNode | undefined;
  let searchNode: ElementNode | undefined;
  let kbNode: ElementNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeKbLayer: (() => void) | undefined;
  const searching = () => query().trim() !== '';
  /** Results replace the list once an answer is in; until then the previous rows stay (no blank list). */
  const shownTotal = () => { const f = found(); return f ? f.rows.length : total(); };

  const load = (index: number) => {
    const start = Math.max(0, Math.floor(index / CHUNK) * CHUNK);
    if (asked.has(start)) return;
    asked.add(start);
    api.getChannelSlice(group(), start, CHUNK).then(({ total: t, rows: got }) => {
      setTotal(t);
      setRows((m) => {
        const next = new Map(m);
        got.forEach((r, k) => next.set(start + k, r));
        return next;
      });
    }).catch(() => { asked.delete(start); });
  };
  const rowAt = (i: number): ChannelRow | undefined => (found() ? found()?.rows[i] : rows().get(i));
  const row = (i: number) => {
    if (found()) return found()?.rows[i];
    const r = rows().get(i);
    if (!r) load(i);
    return r;
  };
  const move = (d: number) => {
    // Up from the first row goes to the search row.
    if (d < 0 && focus() === 0) { searchNode?.setFocus(); return true; }
    const next = Math.max(0, Math.min(shownTotal() - 1, focus() + d));
    setFocus(next);
    if (next < top()) setTop(next);
    else if (next >= top() + ROWS) setTop(next - ROWS + 1);
    return true;
  };
  const pick = (i: number) => {
    const r = rowAt(i);
    if (r) props.onPick(r.id);
    return true;
  };

  const resetList = () => { setFocus(0); setTop(0); };
  const closeKeyboard = () => {
    removeKbLayer?.();
    removeKbLayer = undefined;
    setKbOpen(false);
  };
  const openKeyboard = () => {
    if (kbOpen()) return true;
    setKbOpen(true);
    removeKbLayer = router.pushOverlay(KEYBOARD_ID, () => {
      removeKbLayer = undefined;
      setKbOpen(false);
      queueMicrotask(() => searchNode?.setFocus());
    });
    queueMicrotask(() => kbNode?.setFocus());
    return true;
  };
  /** Done or Right on the keyboard: to the results when there are some, else the keyboard stays. */
  const toResults = () => {
    if (focusAfterSearch(found()?.rows.length ?? 0) === 'keyboard') return;
    closeKeyboard();
    resetList();
    queueMicrotask(() => list?.setFocus());
  };
  const runSearch = (q: string) => {
    const mine = tokens.next();
    api.searchChannels(q, PICKER_SEARCH_LIMIT).then((got) => {
      if (!tokens.isLatest(mine)) return;
      setFound({ query: q, rows: got });
      resetList();
    }).catch(() => { if (tokens.isLatest(mine)) { setFound({ query: q, rows: [] }); resetList(); } });
  };
  const onQuery = (v: string) => {
    setQuery(v);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    tokens.invalidate();
    if (v.trim() === '') { setFound(undefined); resetList(); return; }
    timer = setTimeout(() => { timer = undefined; runSearch(v.trim()); }, PICKER_SEARCH_DEBOUNCE_MS);
  };
  /** Back that reaches the picker (the keyboard layer is above it): clear a query, else let the screen close. */
  const back = () => {
    if (backDecision({ keyboardOpen: kbOpen(), query: query() }) !== 'clearQuery') return false;
    onQuery('');
    queueMicrotask(() => list?.setFocus());
    return true;
  };
  props.backRef?.(back);
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
    tokens.invalidate();
    removeKbLayer?.();
    props.backRef?.(undefined);
  });

  onMount(() => {
    api.getGroups().then((groups) => {
      const fav = groups.find((g) => g.id === GROUP_FAV);
      if (fav && fav.count > 0) setGroup(GROUP_FAV);
      load(0);
    }).catch(() => load(0));
    queueMicrotask(() => list?.setFocus());
  });

  const x = LAYOUT.width - PICKER_W;
  const label = createMemo(() => searchRowLabel(query(), answerCount(query(), found() && { query: found()!.query, count: found()!.rows.length })));
  const ROW_W = PICKER_W - PAD * 2;
  return (
    <View x={0} y={0} width={LAYOUT.width} height={LAYOUT.height} zIndex={60}>
      {/* The windows keep playing behind, dimmed. */}
      <View x={0} y={0} width={x} height={LAYOUT.height} color={COLORS.scrim} />
      <View x={x} y={0} width={PICKER_W} height={LAYOUT.height} color={COLORS.panel}>
        <Text x={PAD + 8} y={28} width={PICKER_W - PAD * 2} maxWidth={PICKER_W - PAD * 2} contain="width" maxLines={1}
          fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{props.title}</Text>
        <Show when={props.info}>
          <Text x={PAD + 8} y={72} width={PICKER_W - PAD * 2 - 16} maxWidth={PICKER_W - PAD * 2 - 16} contain="width" maxLines={2}
            fontSize={TYPE.meta} color={COLORS.muted}>{props.info}</Text>
        </Show>
      </View>
      {/* The search row: OK opens the keyboard; Down goes to the list. */}
      <View ref={(el) => { searchNode = el; }} x={x + PAD} y={HEAD} width={ROW_W} height={ROW_H}
        onFocusChanged={(f: boolean) => setSearchLit(f)}
        onEnter={openKeyboard} onDown={() => { if (shownTotal() > 0) list?.setFocus(); return true; }}
        onUp={() => true} onLeft={() => true} onRight={() => true} onLongOk={() => true} onMenu={() => true}>
        <View width={ROW_W} height={ROW_H - 8} y={4} borderRadius={12} color={searchLit() ? COLORS.focus : COLORS.surface} />
        <Text x={20} y={(ROW_H - TYPE.body) / 2 - 2} width={ROW_W - 40} maxWidth={ROW_W - 40} contain="width" maxLines={1}
          fontSize={TYPE.body} color={searchLit() ? COLORS.onFocus : label().muted ? COLORS.muted : COLORS.text}>{label().text}</Text>
      </View>
      <Show when={searching() && found()?.rows.length === 0}>
        <Text x={x + PAD + 20} y={LIST_Y + 24} width={ROW_W - 40} maxWidth={ROW_W - 40} contain="width" maxLines={1}
          fontSize={TYPE.body} color={COLORS.muted}>{MULTIVIEW_COPY.noChannelsMatch}</Text>
      </Show>
      <Show when={kbOpen()}>
        <Keyboard ref={(el) => { kbNode = el; }} x={KB_X} y={KB_Y} label={MULTIVIEW_COPY.searchChannels}
          value={query()} onChange={onQuery} onDone={toResults} onEdgeRight={toResults} />
      </Show>
      <ChannelList ref={(el) => { list = el; props.ref(el); }} x={x + PAD} y={LIST_Y} width={ROW_W} height={LIST_H}
        total={shownTotal()} top={top()} focus={focus()} row={row} now={props.now} playingId={undefined}
        tag={(i) => { const r = rowAt(i); return r && props.onScreen(r.id) ? MULTIVIEW_COPY.onScreen : undefined; }}
        onMove={move} onPage={(d) => move(d * ROWS)} onLeft={() => true}
        onOk={() => pick(focus())} onOptions={() => true}
        onRowClick={(i) => { setFocus(i); pick(i); }} />
    </View>
  );
}
