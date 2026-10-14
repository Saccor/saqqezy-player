import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { api } from '../api.ts';
import { ChannelList, ROW_H } from '../components/ChannelList.tsx';
import { KEYBOARD_W, Keyboard } from '../components/Keyboard.tsx';
import { moveFocus, pageFocus, scrollTopFor } from '../components/virtualWindow.ts';
import { playback } from '../playback/playback.ts';
import { router } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { SEARCH_LIMIT, createSearcher, resultsMessage, type SearchState } from './searchLogic.ts';

const GROUP_ALL = 'all';
const KB_X = LAYOUT.safeX;
const KB_Y = 150;
const LIST_X = KB_X + KEYBOARD_W + LAYOUT.gap * 2;
const LIST_W = LAYOUT.width - LAYOUT.safeX - LIST_X;
const LIST_ROWS = 9;
const LIST_H = LIST_ROWS * ROW_H;
const HINT_Y = LAYOUT.height - LAYOUT.safeY - 34;

/** Kept across visits (each push/pop re-creates the screen), so Back from the Player returns to the same results. */
const memory: { query: string; focus: number; returning: boolean } = { query: '', focus: 0, returning: false };

/** Search: inline on-screen keyboard (left) and up to 50 results with now/next (right). Ok plays the channel. */
export function SearchScreen() {
  const [query, setQuery] = createSignal(memory.query);
  const [state, setState] = createSignal<SearchState<ChannelRow>>({ query: '', results: [], busy: false, failed: false });
  const [focus, setFocus] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());

  let kbNode: ElementNode | undefined;
  let listNode: ElementNode | undefined;
  let alive = true;
  let lastTop = 0;

  const searcher = createSearcher<ChannelRow>((q) => api.search(q, SEARCH_LIMIT), (s) => {
    if (!alive) return;
    setState(s);
    // The first answer after returning from the Player restores the focused row and the list focus.
    const restore = memory.returning && s.results.length > 0;
    const f = restore ? Math.min(memory.focus, s.results.length - 1) : 0;
    setFocus(f);
    lastTop = Math.max(0, f - LIST_ROWS + 1);
    if (restore) { memory.returning = false; queueMicrotask(() => { if (alive) listNode?.setFocus(); }); }
  });

  const total = () => state().results.length;
  const rowAt = (i: number) => state().results[i];
  const top = createMemo(() => {
    lastTop = scrollTopFor(focus(), lastTop, LIST_ROWS, total());
    return lastTop;
  });

  const onChange = (v: string) => { memory.returning = false; memory.query = v; setQuery(v); searcher.setQuery(v); };

  const focusList = () => { if (total() > 0) listNode?.setFocus(); };
  const focusKeyboard = () => { kbNode?.setFocus(); return true; };

  /** Plays the channel and opens the Player; "All channels" is the zapping group. */
  const play = () => {
    const ch = rowAt(focus());
    if (!ch) return true;
    memory.focus = focus();
    memory.returning = true;
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
    kbNode?.setFocus();
    if (memory.query !== '') searcher.setQuery(memory.query);
    else memory.returning = false;
  });
  onCleanup(() => {
    alive = false;
    searcher.dispose();
  });

  const message = () => resultsMessage(state());
  const countLine = () => (total() > 0 ? `${total()} ${total() === 1 ? 'channel' : 'channels'}` : '');

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background}
      forwardFocus={focusKeyboard}>
      <Text x={KB_X} y={LAYOUT.safeY} fontSize={FONT.title} color={COLORS.text}>{'Search'}</Text>
      <Text x={LIST_X} y={LAYOUT.safeY + 14} width={LIST_W} maxWidth={LIST_W} contain="width" maxLines={1}
        fontSize={FONT.body} color={COLORS.muted}>{countLine()}</Text>

      <Keyboard ref={(el) => { kbNode = el; }} x={KB_X} y={KB_Y} label="Channel name or number" hint="Right: results · Back returns" value={query()}
        onChange={onChange} onDone={focusList} onEdgeRight={() => { focusList(); }} />

      <ChannelList ref={(el) => { listNode = el; }} x={LIST_X} y={KB_Y} width={LIST_W} height={LIST_H}
        total={total()} top={top()} focus={focus()} row={rowAt} now={now()} playingId={playback.current()?.id}
        showNext
        onMove={(d) => { setFocus(moveFocus(focus(), d, total())); return true; }}
        onPage={(dir) => { setFocus(pageFocus(focus(), dir, LIST_ROWS, total())); return true; }}
        onLeft={focusKeyboard} onOk={play} onOptions={() => true} />
      <Show when={message()}>{(m) => (
        <Text x={LIST_X + 24} y={KB_Y + 24} width={LIST_W - 48} maxWidth={LIST_W - 48} contain="width" maxLines={2}
          fontSize={FONT.body} color={COLORS.muted}>{m()}</Text>
      )}</Show>

      <Text x={KB_X} y={HINT_Y} width={LAYOUT.width - KB_X * 2} maxWidth={LAYOUT.width - KB_X * 2} contain="width"
        maxLines={1} fontSize={FONT.small} color={COLORS.muted}>
        {'Type with the keyboard or remote · Right: results · Ok watch · Left: keyboard · Back'}
      </Text>
    </View>
  );
}
