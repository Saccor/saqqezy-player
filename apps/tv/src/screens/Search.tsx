import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { AppEvent } from '@iptv/app-api';
import { api, onEvent } from '../api.ts';
import { ROW_H } from '../components/ChannelList.tsx';
import { KEYBOARD_W, Keyboard } from '../components/Keyboard.tsx';
import { SearchResultList } from '../components/SearchResultList.tsx';
import { firstSelectable, stepSelectable } from '../components/virtualWindow.ts';
import { playback } from '../playback/playback.ts';
import { router } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { WORDMARK_BOTTOM, WORDMARK_RIGHT } from '../shell/Wordmark.tsx';
import { PREVIEW_RECT } from './Home.tsx';
import { SEARCH_LIMIT, countText, createSearchMemory, createSearcher, flattenResults, isSelectable, listRows, listTop, nextFocus, rerunsSearch, resultsMessage, type SearchRow, type SearchState } from './searchLogic.ts';

const GROUP_ALL = 'all';
const KB_X = LAYOUT.safeX;
/** Below the brand wordmark: the keyboard's top-right corner is under "MULTIMEDIA". */
const KB_Y = WORDMARK_BOTTOM + 10;
const LIST_X = KB_X + KEYBOARD_W + LAYOUT.gap * 2;
const LIST_W = LAYOUT.width - LAYOUT.safeX - LIST_X;
const LIST_ROWS = 9;
/** Result count: right-aligned above the list, beside the brand wordmark (top centre) rather than under it. */
const COUNT_Y = KB_Y - 42;
const COUNT_X = WORDMARK_RIGHT;
const COUNT_W = LIST_X + LIST_W - COUNT_X;
const LIST_H = LIST_ROWS * ROW_H;
const HINT_Y = LAYOUT.height - LAYOUT.safeY - 34;

/** Kept across visits (each push/pop re-creates the screen), so Back from the Player returns to the same results. */
const memory = createSearchMemory();

/** Search: inline on-screen keyboard (left) and up to 50 results with now/next (right). Ok plays the channel. */
export function SearchScreen() {
  const [query, setQuery] = createSignal(memory.query);
  const [state, setState] = createSignal<SearchState<SearchRow>>({ query: '', results: [], busy: false, failed: false });
  const [focus, setFocus] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());

  let kbNode: ElementNode | undefined;
  let listNode: ElementNode | undefined;
  let alive = true;
  let lastTop = 0;
  /** The query of the last settled answer. */
  let settledQuery = '';

  const searcher = createSearcher<SearchRow>(async (q) => flattenResults(await api.search(q, SEARCH_LIMIT)), (s) => {
    if (!alive) return;
    setState(s);
    // While a query runs the previous results stay on screen untouched (focus included).
    if (s.busy) return;
    // Returning from the Player or Guide restores the focused row once the full answer (not a guide-pending one)
    // is in; a re-run of the same query keeps the focused row; a new query starts at the top.
    const d = nextFocus({
      rows: s.results, returning: memory.returning, memoryFocus: memory.focus, prevFocus: focus(),
      query: s.query, settledQuery, viewRows: LIST_ROWS,
    });
    settledQuery = s.query;
    setFocus(d.focus);
    if (d.top !== undefined) lastTop = d.top;
    if (d.consumeReturning) memory.returning = false;
    if (d.focusList) queueMicrotask(() => { if (alive) listNode?.setFocus(); });
  });

  const total = () => state().results.length;
  const rowAt = (i: number) => state().results[i];
  /** Drawn rows: none while nothing is selectable (the message area then explains why). */
  const shownRows = createMemo(() => listRows(state().results));
  const top = createMemo(() => {
    lastTop = listTop(shownRows(), focus(), lastTop, LIST_ROWS);
    return lastTop;
  });

  const onChange = (v: string) => { memory.returning = false; memory.query = v; setQuery(v); searcher.setQuery(v); };

  const focusList = () => { if (state().results.some((r) => isSelectable(r))) listNode?.setFocus(); };
  const focusKeyboard = () => { kbNode?.setFocus(); return true; };

  /** Channel and on-now rows play the channel; a coming-up row opens the Guide at that channel and time. */
  const open = () => {
    const r = rowAt(focus());
    if (!r || !isSelectable(r)) return true;
    if (r.kind === 'later') {
      memory.leaveTo(focus());
      router.push('guide', { channelId: r.hit.channel.id, at: r.hit.start });
      return true;
    }
    const ch = r.kind === 'channel' ? r.channel : r.kind === 'onNow' ? r.hit.channel : undefined;
    if (!ch) return true;
    memory.leaveTo(focus());
    const token = playback.begin();
    void (async () => {
      try {
        const pc = await api.getPlayable(ch.id);
        if (!alive || !pc || !playback.isLatest(token)) return;
        playback.playChannel(pc);
        playback.setRect('fullscreen');
        await api.markWatched(ch.id, GROUP_ALL).catch(() => undefined);
        if (alive && playback.isLatest(token)) router.push('player', { channelId: ch.id, groupId: GROUP_ALL });
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
    return true;
  };

  onMount(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(tick));
    // The guide's title index became ready, or a guide import finished (the first one may finish while Search is
    // open): re-run the open query so programme results appear. A same-query re-run keeps the focused row.
    const rerun = (e: unknown) => { if (rerunsSearch(e as AppEvent) && query().trim() !== '') searcher.setQuery(query()); };
    onCleanup(onEvent('searchReady', rerun));
    onCleanup(onEvent('refreshed', rerun));
    // Back from the Player leaves the video fullscreen behind this opaque screen; park it where Home shows it, so
    // the shell's wordmark (hidden while the video is fullscreen) returns and Home needs no visible move.
    if (playback.rectIsFullscreen()) playback.setRect(PREVIEW_RECT);
    kbNode?.setFocus();
    if (memory.query !== '') searcher.setQuery(memory.query);
    else memory.returning = false;
  });
  onCleanup(() => {
    alive = false;
    searcher.dispose();
  });

  const message = () => resultsMessage(state());
  const countLine = () => countText(state());

  /** Back that reaches the screen (no overlay open) leaves Search: forget the query. The shell then pops. */
  const onBack = () => {
    if (router.topOverlay() === undefined) memory.leaveBack();
    return false;
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background}
      forwardFocus={focusKeyboard} onBack={onBack}>
      <Text x={KB_X} y={LAYOUT.safeY} fontSize={FONT.title} color={COLORS.text}>{'Search'}</Text>
      <Text x={COUNT_X} y={COUNT_Y} width={COUNT_W} maxWidth={COUNT_W} contain="width" maxLines={1} textAlign="right"
        fontSize={FONT.body} color={COLORS.muted}>{countLine()}</Text>

      <Keyboard ref={(el) => { kbNode = el; }} x={KB_X} y={KB_Y} label="Channel or programme" hint="Right: results · Back returns" value={query()}
        onChange={onChange} onDone={focusList} onEdgeRight={() => { focusList(); }} />

      <SearchResultList ref={(el) => { listNode = el; }} x={LIST_X} y={KB_Y} width={LIST_W} height={LIST_H}
        rows={shownRows()} top={top()} focus={focus()} now={now()} playingId={playback.current()?.id}
        onMove={(d) => { memory.userNavigated(); setFocus(stepSelectable(focus(), d, total(), (i) => isSelectable(rowAt(i)))); return true; }}
        onPage={(dir) => {
          memory.userNavigated();
          const target = Math.max(0, Math.min(total() - 1, focus() + dir * LIST_ROWS));
          setFocus(firstSelectable(target, total(), (i) => isSelectable(rowAt(i))));
          return true;
        }}
        onLeft={() => { memory.userNavigated(); return focusKeyboard(); }}
        onOk={() => { memory.userNavigated(); return open(); }}
        onRowClick={(i, double) => {
          // The first click already opened it (the Player or the Guide): a double click adds nothing.
          if (double || !isSelectable(rowAt(i))) return;
          memory.userNavigated();
          setFocus(i);
          listNode?.setFocus();
          open();
        }} />
      <Show when={message()}>{(m) => (
        <Text x={LIST_X + 24} y={KB_Y + 24} width={LIST_W - 48} maxWidth={LIST_W - 48} contain="width" maxLines={2}
          fontSize={FONT.body} color={COLORS.muted}>{m()}</Text>
      )}</Show>

      <Text x={KB_X} y={HINT_Y} width={LAYOUT.width - KB_X * 2} maxWidth={LAYOUT.width - KB_X * 2} contain="width"
        maxLines={1} fontSize={FONT.small} color={COLORS.muted}>
        {'Type with the keyboard or remote · Right: results · Ok watch or open in guide · Left: keyboard · Back'}
      </Text>
    </View>
  );
}
