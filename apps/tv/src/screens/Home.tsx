import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { AppEvent, ChannelRow, ListSummary } from '@iptv/app-api';
import type { GroupInfo, LayoutOp } from '@iptv/core';
import type { Rect } from '@iptv/player';
import { api, onEvent } from '../api.ts';
import { ChannelList, ROW_H } from '../components/ChannelList.tsx';
import { PointerBar, type PointerBarItem } from '../components/PointerBar.tsx';
import { ContextMenu } from '../components/ContextMenu.tsx';
import { GroupList } from '../components/GroupList.tsx';
import { Keyboard, KEYBOARD_H, KEYBOARD_W } from '../components/Keyboard.tsx';
import { COMPACT_LAYOUT } from '../components/keyboardLogic.ts';
import { ListPicker } from '../components/ListPicker.tsx';
import { PREVIEW_H, PREVIEW_W, PreviewPanel } from '../components/PreviewPanel.tsx';
import { SearchBar } from '../components/SearchBar.tsx';
import { SearchResultList } from '../components/SearchResultList.tsx';
import { TAB_BAR_X, TabBar } from '../components/TabBar.tsx';
import { firstSelectable, moveFocus, pageFocus, renderRange, scrollTopFor, stepSelectable } from '../components/virtualWindow.ts';
import { captureTextInput } from '../input/keys.ts';
import { PointerFocusContext, pointerMode, shellBack, usePointerTarget } from '../input/pointer.ts';
import { createDebounce } from '../playback/debounce.ts';
import { cooling, retrySource } from '../playback/cooldown.ts';
import { playback, previewHold } from '../playback/playback.ts';
import { TOAST_OVERLAY_ID } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { visibleInterval } from '../shell/visibleInterval.ts';
import { WORDMARK_BOTTOM } from '../shell/Wordmark.tsx';
import { companionStatus, cooldown, initState, markStartup } from '../state/appState.ts';
import { cooldownCopy, freshNow } from '../state/cooldownLogic.ts';
import { TABS_W, tabNavigation, tabParams, type TabId } from '../vod/tabLogic.ts';
import { panelChannel, pickGroup, playingInfoStale, resolveFocus, restoreIndex, resumeTarget, videoClickGroup, vodReturnTarget, waitsForChannels } from './homeLogic.ts';
import {
  buildChannelMenu, emptyGroupText, focusAfterRefresh, limitTyping, listIdOfGroup, newListId, pickerRows,
  renameOutcome, validateListName, type ChannelMenuAction, type ListLite, type MenuItem, type PickerRow,
} from './homeMenuLogic.ts';
import {
  BROWSE, BROWSE_HINT, HOME_GROUP_W, HOME_POINTER_LABELS, SEARCH_HINT, applyQuery, capQuery, exitFocusTarget, exitSearch, groupChoice, groupColumn,
  leaveTo, okAction, restoreOnMount, resultsFocusLost, routeKey, rowChannelId, rowPointerAction, typedQuery,
  typingKey, userNavigated, type BrowsePosition, type HomeSearchState, type NavKey, type NavResult, type OkAction, type Place,
} from './homeSearchLogic.ts';
import { showPhoneBadge } from './pairingLogic.ts';
import {
  SEARCH_LIMIT, countText, createSearcher, flattenResults, isSelectable, listRows, listTop, nextFocus, rerunsSearch,
  resultsMessage, selectableCount, type SearchRow, type SearchState,
} from './searchLogic.ts';
import { SliceCache } from './sliceCache.ts';
import { devResume, PAUSED_NOTE } from '../playback/devResume.ts';
import { liveReturn } from '../vod/liveReturn.ts';

// Layout A: groups 22 % | channel list | preview 34 % of the safe width.
const SAFE_W = LAYOUT.width - LAYOUT.safeX * 2;
const GROUP_X = LAYOUT.safeX;
/** 22 % of the safe width (380 px): the compact search keyboard covers exactly this column. */
const GROUP_W = HOME_GROUP_W;
const PREVIEW_X = LAYOUT.width - LAYOUT.safeX - PREVIEW_W;
const LIST_X = GROUP_X + GROUP_W + LAYOUT.gap;
const LIST_W = PREVIEW_X - LAYOUT.gap - LIST_X;
/** The list header crosses the centre, so it starts below the brand wordmark, with a clear gap under it. */
const HEAD_Y = WORDMARK_BOTTOM + 12;
/** The search bar (`SEARCH_BAR_H`) ends 4 px above the list. */
const BODY_Y = WORDMARK_BOTTOM + 50;
const LIST_ROWS = 9;
const LIST_H = LIST_ROWS * ROW_H;
const HINT_Y = LAYOUT.height - LAYOUT.safeY - 34;
/** Home's preview box; also where opaque screens park a fullscreen video they cover (see Search). */
export const PREVIEW_RECT: Rect = { x: PREVIEW_X, y: BODY_Y, w: PREVIEW_W, h: PREVIEW_H };
/** A browse focus resting this long asks the worker for that channel's now/next. It never plays. */
const FOCUS_REST_MS = 700;
const MENU_ID = 'contextMenu';
const PICKER_ID = 'listPicker';
const KEYBOARD_ID = 'keyboard';
const SEARCH_KB_ID = 'searchKeyboard';
const NO_LIVE_TEXT = 'This source has no live channels. Movies and series are in the tabs above.';
const GROUP_ALL = 'all';
const FAV_LIST_ID = 'fav';

type Progress = Extract<AppEvent, { type: 'progress' }>;
type LayoutChanged = Extract<AppEvent, { type: 'layoutChanged' }>;
type SourcesChanged = Extract<AppEvent, { type: 'sourcesChanged' }>;

/** The channel menu, opened on a row; `inListId` is set while the user browses that list. */
interface MenuState { row: ChannelRow; items: MenuItem[]; inListId?: string; isFavourite: boolean }
/** "Add to list…": every list and the ids of those holding the channel. */
interface PickerState { row: ChannelRow; lists: ListSummary[]; member: Set<string> }
/** The on-screen keyboard for "New list…" (from the picker) or "Rename…" (from the menu). */
interface EditState { kind: 'newList' | 'rename'; row: ChannelRow; value: string; error?: string }

/**
 * In-memory position across Home visits (each push/pop re-creates the screen): the open group, the focused
 * channel and the last focused row per group.
 */
const memory: { groupId?: string; channelId?: string; rows: Map<string, number> } = { rows: new Map() };

/** Search mode across Home visits: the query, the focused result and the browse position to return to. */
let searchMemory: HomeSearchState = BROWSE;

/** The first Home mount of this page has decided whether to resume init's last channel (see `resumeTarget`). */
let startupResumed = false;

const PHONE_BADGE_W = 144;
const PHONE_BADGE_H = 48;
/** Right of the tab bar, so it never overlaps the three tabs; the wordmark, offline badge and clock sit further right. */
const PHONE_BADGE_X = TAB_BAR_X + TABS_W + LAYOUT.gap;

/** "Phone": shown on Home while a companion is connected (Settings → Manage on phone or computer). */
function PhoneBadge() {
  return (
    <View x={PHONE_BADGE_X} y={LAYOUT.safeY - 4} width={PHONE_BADGE_W} height={PHONE_BADGE_H} color={COLORS.surface}
      borderRadius={PHONE_BADGE_H / 2} border={{ width: 2, color: COLORS.focus }}>
      <Text y={(PHONE_BADGE_H - FONT.small) / 2 - 3} width={PHONE_BADGE_W} maxWidth={PHONE_BADGE_W} contain="width"
        textAlign="center" fontSize={FONT.small} color={COLORS.text}>{'Phone'}</Text>
    </View>
  );
}

/** Home: groups, a virtualised channel list with now/next, the live preview and the channel options menu. */
export function HomeScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { lastGroupId?: string; lastChannelId?: string; focusChannelId?: string; focusTabs?: true };
  // One-shot hint from the Player (last watched channel after a sleep-timer stop): consumed here.
  const focusHint = params.focusChannelId;
  delete params.focusChannelId;
  // One-shot from Back on the Movies tab: the tab bar takes focus.
  const focusTabsHint = params.focusTabs === true;
  delete params.focusTabs;

  const [groups, setGroups] = createSignal<GroupInfo[]>([]);
  const [groupId, setGroupId] = createSignal<string | undefined>(undefined);
  const [focus, setFocus] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  // Where key focus is. `list` is the channel list while browsing and the results while searching.
  const [area, setArea] = createSignal<Place>('list');
  const [ready, setReady] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  const [progress, setProgress] = createSignal<Progress | undefined>(undefined);
  const [menu, setMenu] = createSignal<MenuState | undefined>(undefined);
  const [picker, setPicker] = createSignal<PickerState | undefined>(undefined);
  const [edit, setEdit] = createSignal<EditState | undefined>(undefined);
  // A layout refresh has emptied the cache: hide the empty-group text until the group is re-read.
  const [reloading, setReloading] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  // The channel an Ok (or the startup resume) is fetching right now: its getPlayable has not answered yet.
  const [requested, setRequested] = createSignal<string | undefined>(undefined);
  // Dev builds only: the last channel was not resumed after a page load (devResume.ts); the preview box says so.
  const [pausedNote, setPausedNote] = createSignal(devResume.paused());
  // Fresh now/next for the playing channel when it is not the focused row (refreshed on the 30 s tick).
  const [playingInfo, setPlayingInfo] = createSignal<{ row: ChannelRow; at: number } | undefined>(undefined);

  let groupNode: ElementNode | undefined;
  let listNode: ElementNode | undefined;
  let menuNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let keyboardNode: ElementNode | undefined;
  let removeMenu: (() => void) | undefined;
  let removePicker: (() => void) | undefined;
  let removeKeyboard: (() => void) | undefined;
  let alive = true;
  let startupMarked = false;
  // Playback was stopped on purpose (sleep timer): no resume on mount.
  const held = previewHold.take();
  // The live channel a Movies or Series tab (or a title opened from Search) stopped: taken by every Home mount,
  // resumed only on Back from that tab (or on the return from Search) and only for the source it came from.
  const vodReturn = liveReturn.take(initState()?.activeSourceId);
  let lastTop = 0;
  // Only the latest openGroup call may write the selection and memory.
  let groupSeq = 0;

  // Bounded (6 pages around the latest window, current + previous group) and expiring (see sliceCache.ts).
  const cache = new SliceCache<ChannelRow>((g, o, c) => api.getChannelSlice(g, o, c), 40, () => setVersion((v) => v + 1),
    { maxPages: 6, now: () => Date.now() });

  const total = () => { version(); const g = groupId(); return g === undefined ? 0 : cache.total(g) ?? 0; };
  const rowAt = (i: number) => { version(); const g = groupId(); return g === undefined ? undefined : cache.row(g, i); };
  const top = createMemo(() => {
    const t = total();
    // While a reload has emptied the cache the total is unknown: keep the scroll position.
    if (t === 0) return lastTop;
    lastTop = scrollTopFor(focus(), lastTop, LIST_ROWS, t);
    return lastTop;
  });
  const focusedRow = () => rowAt(focus());
  // Keyed on the id only: a page (re)load that replaces the row object does not restart the preview timer.
  const focusedId = createMemo(() => focusedRow()?.id);
  const groupIndex = () => Math.max(0, groups().findIndex((g) => g.id === groupId()));

  // ---- search mode: the bar above the list filters it in place (homeSearchLogic.ts) ----

  // Back from the Player or the Guide keeps the search, but only on the same source.
  searchMemory = restoreOnMount(searchMemory, initState()?.activeSourceId);
  const [query, setQueryText] = createSignal(searchMemory.query);
  const [sState, setSState] = createSignal<SearchState<SearchRow>>({ query: '', results: [], busy: false, failed: false });
  const [sFocus, setSFocus] = createSignal(0);
  // The compact on-screen keyboard over the groups column (a Back layer).
  const [kbOpen, setKbOpen] = createSignal(false);
  const searching = () => query() !== '';

  let barNode: ElementNode | undefined;
  let tabsNode: ElementNode | undefined;
  let resultsNode: ElementNode | undefined;
  let searchKbNode: ElementNode | undefined;
  let removeSearchKb: (() => void) | undefined;
  let sLastTop = 0;
  /** The query of the last settled answer (see `nextFocus`). */
  let settledQuery = '';
  /** Counts search exits: init must not override a browse position an exit restored while it was loading. */
  let searchExits = 0;

  // Same debounce, worker search and stale-answer guard as the Search screen.
  const searcher = createSearcher<SearchRow>(async (q) => flattenResults(await api.search(q, SEARCH_LIMIT)), (s) => {
    if (!alive) return;
    // While a query runs the previous results stay on screen untouched (focus included).
    if (s.busy) { setSState(s); return; }
    const d = nextFocus({
      rows: s.results, returning: searchMemory.returning, memoryFocus: searchMemory.focus, prevFocus: sFocus(),
      query: s.query, settledQuery, viewRows: LIST_ROWS,
    });
    settledQuery = s.query;
    // One update: new results never render with the old focus (which may sit on a header row there).
    batch(() => {
      if (d.top !== undefined) sLastTop = d.top;
      setSState(s);
      setSFocus(d.focus);
    });
    if (d.consumeReturning) searchMemory = { ...searchMemory, returning: false };
    if (d.focusList) queueMicrotask(() => { if (alive && searching()) focusArea('list'); });
  });

  const sTotal = () => sState().results.length;
  const sRowAt = (i: number) => sState().results[i];
  /** Drawn rows: none while nothing is selectable (the message explains why). */
  const shownRows = createMemo(() => listRows(sState().results));
  const sTop = createMemo(() => {
    sLastTop = listTop(shownRows(), sFocus(), sLastTop, LIST_ROWS);
    return sLastTop;
  });
  // Never true with an empty bar: `routeKey`'s keyboard branch does not check `searching` itself.
  const hasResults = () => searching() && selectableCount(sState().results) > 0;
  const firstResult = () => firstSelectable(0, sTotal(), (i) => isSelectable(sRowAt(i)));
  /** The groups column: a `Search results` entry on top while searching. */
  const column = createMemo(() => groupColumn(groups(), searching(), selectableCount(sState().results), groupIndex()));

  const visibleRange = () => renderRange(top(), LIST_ROWS, Math.max(total(), 1));
  const load = () => {
    const g = groupId();
    if (g === undefined) return;
    const r = visibleRange();
    // Cached pages scrolled into view may hold rolled-over now/next: mark them so `ensure` refetches them now.
    cache.invalidateStale(g, r.from, r.to);
    cache.ensure(g, r.from, Math.max(r.to, 1)).catch((err: unknown) => {
      console.warn('Channel slice failed', err instanceof Error ? err.name : 'Error');
    });
  };
  createEffect(load);

  // Startup metric: the first render of cached channel rows (effects run once their nodes exist). Not
  // deferred to requestAnimationFrame, which background or throttled tabs delay by seconds.
  createEffect(() => {
    if (startupMarked || !rowAt(top())) return;
    startupMarked = true;
    markStartup();
  });

  // ---- preview: only Ok (or a click) plays; moving the focus never does ----

  /** The user started a channel: in dev builds, auto-resume after a reload works again for this page. */
  const userPlayed = () => {
    devResume.release();
    setPausedNote(false);
  };

  /** Plays `id` in the preview unless a newer request (Ok elsewhere, watch, stop) has superseded this one. */
  const playById = async (id: string) => {
    userPlayed();
    const token = playback.begin();
    setRequested(id);
    try {
      const ch = await api.getPlayable(id);
      if (alive && ch && playback.isLatest(token)) playback.playChannel(ch);
    } catch (err) {
      console.warn('Preview failed', err instanceof Error ? err.name : 'Error');
    } finally {
      if (requested() === id) setRequested(undefined);
    }
  };

  /** Ok (or a click) on a channel that is not playing: it plays in the small video, and counts as watched in `g`. */
  const playHere = (id: string, g: string) => {
    void playById(id).then(() => {
      if (alive && playback.current()?.id === id) void api.markWatched(id, g).catch(() => undefined);
    });
  };

  /**
   * Startup: resumes the last channel in the preview. In dev builds a remote source is not resumed after a page load
   * (devResume.ts): the preview box asks for Ok instead.
   */
  const resumeLast = async (id: string) => {
    const token = playback.begin();
    setRequested(id);
    try {
      const ch = await api.getPlayable(id);
      if (!alive || !ch || !playback.isLatest(token)) return;
      if (devResume.allows(ch.url)) playback.playChannel(ch);
      else setPausedNote(true);
    } catch (err) {
      console.warn('Preview failed', err instanceof Error ? err.name : 'Error');
    } finally {
      if (requested() === id) setRequested(undefined);
    }
  };

  /** Cancels any preview request in flight. */
  const stopPreview = () => {
    playback.begin();
    setRequested(undefined);
  };

  /** Moves the list focus and remembers it. Moving never changes the channel: only Ok plays. */
  const selectRow = (i: number) => {
    setFocus(i);
    const g = groupId();
    if (g !== undefined) memory.rows.set(g, i);
    memory.groupId = g;
    const r = rowAt(i);
    if (r) memory.channelId = r.id;
  };
  // No Ok works on the list while the channel menu, the list picker or the keyboard is open.
  const modalOpen = () => menu() !== undefined || picker() !== undefined || edit() !== undefined;

  // A browse focus that rests for FOCUS_REST_MS tells the worker, which may look up that channel's now/next (short
  // EPG, only for channels without a stored guide). It never plays anything. Search results do not count: while
  // searching, the preview panel describes the playing channel.
  // A rest was reported and not cleared yet: the worker still holds that focused id.
  let restReported = false;
  const focusRest = createDebounce<string>(FOCUS_REST_MS, (id) => {
    if (!alive || focusedId() !== id || area() !== 'list' || searching()) return;
    restReported = true;
    void api.focusChannel(id).catch(() => undefined);
  });
  createEffect(on([focusedId, area, ready, modalOpen, searching], ([id, a, isReady, modal, isSearching]) => {
    if (id === undefined || a !== 'list' || !isReady || modal || isSearching) {
      focusRest.cancel();
      // The list lost the focus (or search started): the worker drops the stale focused id.
      if (restReported) {
        restReported = false;
        void api.focusChannel(undefined).catch(() => undefined);
      }
      return;
    }
    memory.channelId = id;
    focusRest.schedule(id);
  }));

  // Preview panel: the playing channel's info, or the focused one while its preview is starting.
  createEffect(on(() => playback.current(), (c) => setPlayingInfo(c ? { row: c, at: Date.now() } : undefined)));
  const playingRow = (): ChannelRow | undefined => {
    const c = playback.current();
    if (!c) return undefined;
    const f = focusedRow();
    if (f?.id === c.id) return f; // the cached row is kept fresh by the slice cache
    const info = playingInfo();
    return info?.row.id === c.id ? info.row : c;
  };
  // While searching the panel keeps describing what is playing, never the focused result.
  const panel = () => (searching() ? { channel: playingRow(), starting: false }
    : panelChannel(focusedRow(), playingRow(), requested() !== undefined && requested() === focusedId()));

  /** Re-reads the playing channel's now/next once its programme has ended since it was last read. */
  const refreshPlayingInfo = () => {
    const info = playingInfo();
    const stop = info?.row.now?.stop;
    const t = Date.now();
    if (!info || stop === undefined || stop > t || stop <= info.at) return;
    const id = info.row.id;
    if (focusedRow()?.id === id) return; // shown from the slice cache, which refreshes itself
    rereadPlayingInfo(id);
  };
  const rereadPlayingInfo = (id: string) => {
    const t = Date.now();
    api.getPlayable(id).then((ch) => {
      if (alive && ch && playback.current()?.id === id) setPlayingInfo({ row: ch, at: t });
    }).catch(() => undefined);
  };

  /** 30 s tick: progress bars, rolled-over visible pages and the playing channel's info. */
  const onTick = () => {
    setNow(Date.now());
    load(); // refetches visible pages whose programmes rolled over
    refreshPlayingInfo();
  };

  // ---- groups ----

  /**
   * Opens group `g` and focuses the first of `keepIds` that is in it (else the remembered row, else the first
   * row). Resolves with the id it focused, or undefined. Only the latest call writes the selection.
   */
  const openGroup = async (g: string, keepIds: readonly (string | undefined)[] = [], keepScroll = false,
    fallbackIndex?: number): Promise<string | undefined> => {
    const seq = ++groupSeq;
    if (!keepScroll) lastTop = 0;
    setGroupId(g);
    await cache.ensure(g, 0, 1).catch(() => undefined);
    if (!alive || seq !== groupSeq) return undefined;
    const t = cache.total(g) ?? 0;
    const hit = await resolveFocus(keepIds, (id) => api.indexOf(g, id).catch(() => -1));
    if (!alive || seq !== groupSeq) return undefined;
    // After a layout change a channel that left the group hands its row to the neighbour that took its place.
    selectRow(fallbackIndex !== undefined ? focusAfterRefresh(hit.index, fallbackIndex, t)
      : restoreIndex(hit.index, memory.rows.get(g), t));
    return hit.id;
  };

  /**
   * Re-reads groups and the visible slice, keeping focus on the same channel id (`keepId`, else the focused
   * one) when it is still in the group. If it left (hidden, removed from the list), the neighbour that took
   * its row is focused. A group that disappeared falls back to All channels.
   */
  let reloadSeq = 0;
  const reload = async (keepId?: string) => {
    const seq = ++reloadSeq;
    const id = keepId ?? focusedRow()?.id ?? memory.channelId;
    const before = groupId();
    const oldIndex = focus();
    setReloading(true);
    try {
      const gs = await api.getGroups();
      if (!alive) return;
      setGroups(gs);
      cache.invalidate();
      const g = pickGroup(gs, before);
      if (g !== undefined) await openGroup(g, [id], g === before, g === before ? oldIndex : undefined);
    } finally {
      if (seq === reloadSeq) setReloading(false);
    }
    // The list emptied under the focus (e.g. its last channel was removed): move to the groups.
    if (alive && seq === reloadSeq && !modalOpen() && !searching() && area() === 'list' && total() === 0) focusArea('groups');
  };

  // ---- actions ----

  /**
   * Channels in the open group. The group's count is known before its first slice arrives (and while a reload
   * has emptied the cache), so a quick Right or a closing overlay is not sent to the groups by mistake.
   */
  const listCount = () => total() || (groups().find((g) => g.id === groupId())?.count ?? 0);

  /** Moves key focus. While searching, `list` is the results, which take focus only when a row is selectable. */
  const focusArea = (a: Place) => {
    if (a === 'list' && (searching() ? !hasResults() : listCount() === 0)) return true;
    setArea(a);
    const node = a === 'tabs' ? tabsNode : a === 'groups' ? groupNode : a === 'bar' ? barNode : a === 'keyboard' ? searchKbNode
      : searching() ? resultsNode : listNode;
    node?.setFocus();
    return true;
  };

  const navResult = (place: Place, key: NavKey, atEdge = false): NavResult => routeKey(place, key, {
    searching: searching(), keyboardOpen: kbOpen(), hasResults: hasResults(), hasChannels: listCount() > 0, atEdge,
  });
  /** Applies a focus decision; false lets the key run its usual handler. */
  const applyNav = (r: NavResult): boolean => {
    if (r.kind === 'focus') return focusArea(r.place);
    if (r.kind === 'exit') { endSearch(r.focus); return true; }
    return r.kind === 'stay';
  };
  const nav = (place: Place, key: NavKey, atEdge = false) => applyNav(navResult(place, key, atEdge));

  // The results lost their last selectable row while focused (narrowed query, empty re-run): focus never stays on
  // an empty list. It goes to the keyboard when open, else to the bar.
  createEffect(on(hasResults, (has) => {
    const to = resultsFocusLost({ area: area(), searching: searching(), hasResults: has, keyboardOpen: kbOpen() });
    if (to !== undefined) focusArea(to);
  }, { defer: true }));

  /** The browse position search mode returns to. */
  const browseNow = (): BrowsePosition | undefined => {
    const g = groupId();
    return g === undefined ? undefined : { groupId: g, channelId: focusedRow()?.id ?? memory.channelId, top: top() };
  };

  /**
   * New bar text (hardware keys, remote digits or the compact keyboard). The first non-blank text enters search
   * mode, with no new stream. Blank text leaves it, and focus stays where the user is typing.
   */
  const setBarText = (raw: string) => {
    const text = capQuery(raw); // one cap for every input path
    if (text === query()) return; // typing at the cap does not re-run the same search
    const ch = applyQuery(searchMemory, text, browseNow(), initState()?.activeSourceId);
    if (ch.kind === 'none') return;
    if (ch.kind === 'exit') { finishExit(ch.restore, kbOpen() ? 'keyboard' : 'bar'); return; }
    if (ch.kind === 'enter') stopPreview(); // a pending preview never fires after typing starts
    searchMemory = ch.state;
    setQueryText(text);
    searcher.setQuery(text);
  };

  /** Back (bar or results) ends search mode: the saved group, row and scroll come back. */
  const endSearch = (focusTo: Place) => {
    const ex = exitSearch(searchMemory);
    finishExit(ex.restore, focusTo);
  };

  const finishExit = (restore: BrowsePosition | undefined, focusTo: Place) => {
    if (restore) searchExits++; // only an exit that restored a position stands in for init's group
    searchMemory = BROWSE;
    settledQuery = '';
    sLastTop = 0;
    setSFocus(0);
    setQueryText('');
    searcher.setQuery('');
    if (restore) {
      lastTop = restore.top;
      void openGroup(restore.groupId, [restore.channelId], true);
    }
    // The channel list mounts again in this update; focus it once its node exists. An empty group cannot take
    // focus, so the groups do (focus must never stay on the unmounted results).
    queueMicrotask(() => { if (alive) focusArea(exitFocusTarget(focusTo, listCount())); });
  };

  /** Fullscreen on channel `id`: the playing channel keeps its stream (only the rect changes), then the Player opens. */
  const openFullscreen = (id: string, g: string, beforePush?: () => void) => {
    userPlayed();
    const token = playback.begin();
    setRequested(undefined);
    void (async () => {
      try {
        const ch = await api.getPlayable(id);
        if (!alive || !ch || !playback.isLatest(token)) return;
        // Same channel: the stream keeps running and only the rect changes (no reconnect).
        playback.playChannel(ch);
        playback.setRect('fullscreen');
        await api.markWatched(id, g).catch(() => undefined);
        if (alive && playback.isLatest(token)) {
          beforePush?.();
          router.push('player', { channelId: id, groupId: g });
        }
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
  };

  /**
   * Manual Retry while the source cools down: one probe, then `id` (or the held channel) previews here. The user
   * stays on Home, where the result shows.
   */
  const retryHere = async (id?: string) => {
    userPlayed();
    const token = playback.begin();
    setRequested(undefined);
    const ch = id === undefined ? undefined : await api.getPlayable(id).catch(() => undefined);
    if (!alive || !playback.isLatest(token)) return;
    await retrySource(ch);
  };

  /**
   * Ok on a channel: one that is not playing plays in the small video, and Home stays. The playing one, or one whose
   * request is still being fetched, goes fullscreen. While the source cools down, Ok is Retry (the preview box says so).
   */
  const watch = () => {
    const r = focusedRow();
    const g = groupId();
    if (!r || g === undefined || modalOpen()) return true;
    if (cooling()) {
      void retryHere(r.id);
      return true;
    }
    memory.channelId = r.id;
    if (okAction({ kind: 'channel', channel: r }, playback.current()?.id, requested()) === 'fullscreen') openFullscreen(r.id, g);
    else playHere(r.id, g);
    return true;
  };

  /**
   * Ok on a result. A channel that is not playing plays in the small video, and Home and the results stay. The
   * playing channel goes fullscreen. A coming-up row opens the Guide at that time. The Player zaps in All channels.
   */
  const openResult = () => {
    const r = sRowAt(sFocus());
    // A second Ok while this row's preview is still being fetched goes fullscreen too.
    return runResult(r, okAction(r, playback.current()?.id, requested()));
  };

  /** Runs `action` on result row `r` (the focused one): Ok and pointer clicks share it. */
  const runResult = (r: SearchRow | undefined, action: OkAction) => {
    if (action === 'guide' && r?.kind === 'later') {
      searchMemory = leaveTo(searchMemory, sFocus());
      router.push('guide', { channelId: r.hit.channel.id, at: r.hit.start });
      return true;
    }
    const id = rowChannelId(r);
    if (id === undefined) return true;
    if (action === 'preview') {
      playHere(id, GROUP_ALL);
      return true;
    }
    if (action === 'fullscreen') {
      // Set right before the push: a key pressed while the channel loads must not clear the restore.
      const at = sFocus();
      openFullscreen(id, GROUP_ALL, () => { searchMemory = leaveTo(searchMemory, at); });
    }
    return true;
  };

  // ---- channel menu, list picker, keyboard (Back closes them top first: keyboard, picker, menu) ----

  /**
   * Focuses the topmost open layer (nodes of a layer just opened exist only after this tick). With none left,
   * the list keeps focus, also while a reload has emptied the cache; only a really empty group sends it to
   * the groups.
   */
  const focusTop = () => queueMicrotask(() => {
    if (!alive) return;
    if (edit()) keyboardNode?.setFocus();
    else if (picker()) pickerNode?.setFocus();
    else if (menu()) menuNode?.setFocus();
    else focusArea(listCount() > 0 ? 'list' : 'groups');
  });

  // `close*` are the overlays' onClose (Back): the router has already dropped the layer.
  const closeKeyboard = () => { removeKeyboard = undefined; setEdit(undefined); focusTop(); };
  const closePicker = () => { removePicker = undefined; setPicker(undefined); focusTop(); };
  const closeMenu = () => { removeMenu = undefined; setMenu(undefined); focusTop(); };
  // `dismiss*` close a layer from code.
  const dismissKeyboard = () => { if (edit()) { removeKeyboard?.(); closeKeyboard(); } };
  const dismissPicker = () => { if (picker()) { removePicker?.(); closePicker(); } };
  const dismissMenu = () => { if (menu()) { removeMenu?.(); closeMenu(); } };
  const dismissAll = () => { dismissKeyboard(); dismissPicker(); dismissMenu(); };

  // ---- compact search keyboard (over the groups column; a Back layer like the other keyboards) ----

  /** Closes the keyboard (as Back: the router already dropped the layer). Focus goes to `to`, else to the bar unless it is on the results. */
  const closeSearchKeyboard = (to?: Place) => {
    removeSearchKb = undefined;
    setKbOpen(false);
    const target = to ?? (area() === 'list' ? undefined : 'bar');
    if (target !== undefined) queueMicrotask(() => { if (alive) focusArea(target); });
  };
  const dismissSearchKeyboard = (to?: Place) => { if (kbOpen()) { removeSearchKb?.(); closeSearchKeyboard(to); } };
  /** Ok on the bar: opens the keyboard for remote typing. */
  const openSearchKeyboard = () => {
    if (kbOpen() || modalOpen()) return true;
    setKbOpen(true);
    removeSearchKb = router.pushOverlay(SEARCH_KB_ID, () => closeSearchKeyboard());
    queueMicrotask(() => { if (alive && kbOpen()) focusArea('keyboard'); });
    return true;
  };
  /** Right edge, Up from the top row, and Done. The results are entered at their first selectable row. */
  const fromKeyboard = (key: NavKey, atEdge: boolean, close: boolean) => {
    const r = navResult('keyboard', key, atEdge);
    if (r.kind === 'focus' && r.place === 'list') {
      searchMemory = userNavigated(searchMemory);
      setSFocus(firstResult());
    }
    if (close) dismissSearchKeyboard(r.kind === 'focus' ? r.place : 'bar');
    else applyNav(r);
  };

  // Hardware typing while no Home layer is open. A letter starts a search from anywhere and moves focus to the bar.
  // In the bar every printable key types and Backspace deletes. Digits outside the bar stay remote keys. The rename
  // and search keyboards capture typing themselves while they are open.
  createEffect(() => {
    if (modalOpen() || kbOpen()) return;
    const release = captureTextInput((e) => {
      const k = typingKey(e, {
        overlayOpen: router.overlays().some((id) => id !== TOAST_OVERLAY_ID),
        barFocused: area() === 'bar',
        query: query(),
      });
      if (!k) return false;
      if (area() !== 'bar') focusArea('bar');
      setBarText(typedQuery(query(), k));
      return true;
    });
    onCleanup(release);
  });

  /** User lists as shown in the group column (names and order), for the menu's "Remove from" label. */
  const listsFromGroups = (): ListLite[] => groups().flatMap((g) => {
    const id = listIdOfGroup(g.id);
    return id === undefined ? [] : [{ id, name: g.name }];
  });

  const openMenu = () => {
    const r = focusedRow();
    if (!r || modalOpen()) return true;
    stopPreview();
    const inListId = listIdOfGroup(groupId());
    // Home never shows hidden channels (they are hidden everywhere), so the menu always offers Hide.
    setMenu({ row: r, inListId, isFavourite: r.favourite, items: buildChannelMenu({
      inListId, isHidden: false, isFavourite: r.favourite, lists: listsFromGroups(),
    }) });
    removeMenu = router.pushOverlay(MENU_ID, closeMenu);
    focusTop();
    return true;
  };

  /**
   * Rebuilds the open menu's items from the current layout (after a remote change): the Favourites item
   * follows the channel's membership, and "Remove from" disappears when its list was deleted.
   */
  const rebuildMenu = async () => {
    const m = menu();
    if (!m) return;
    const ids = await api.channelLists(m.row.id);
    const cur = menu();
    if (!alive || cur?.row.id !== m.row.id) return;
    const isFavourite = ids.includes(FAV_LIST_ID);
    setMenu({ ...cur, isFavourite, items: buildChannelMenu({
      inListId: cur.inListId, isHidden: false, isFavourite, lists: listsFromGroups(),
    }) });
  };

  /** Applies layout ops; resolves false (after a toast) when the worker refused any of them. */
  const applyOps = async (ops: LayoutOp[]): Promise<boolean> => {
    try {
      const res = await api.applyLayoutOps(ops);
      if (res.rejected.length === 0) return true;
      console.warn('Layout change refused', res.rejected.map((x) => x.reason).join(', '));
    } catch (err) {
      console.warn('Layout change failed', err instanceof Error ? err.name : 'Error');
    }
    if (alive) showToast("Couldn't change this channel.");
    return false;
  };

  /** Re-reads the picker's lists and checks (after a toggle, a new list or a remote change). */
  const rereadPicker = async (row: ChannelRow) => {
    const [lists, ids] = await Promise.all([api.listLists(), api.channelLists(row.id)]);
    if (alive && picker()?.row.id === row.id) setPicker({ row, lists, member: new Set(ids) });
  };

  const openPicker = async (row: ChannelRow) => {
    try {
      const [lists, ids] = await Promise.all([api.listLists(), api.channelLists(row.id)]);
      if (!alive || menu()?.row.id !== row.id || picker()) return;
      setPicker({ row, lists, member: new Set(ids) });
      removePicker = router.pushOverlay(PICKER_ID, closePicker);
      focusTop();
    } catch (err) {
      console.warn('Load lists failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't load your lists.");
    }
  };

  const openKeyboard = (kind: EditState['kind'], row: ChannelRow, value: string) => {
    // Prefilled in full: a playlist name longer than NAME_MAX is validated on Done, not cut.
    setEdit({ kind, row, value });
    removeKeyboard = router.pushOverlay(KEYBOARD_ID, closeKeyboard);
    focusTop();
  };

  const choose = async (action: ChannelMenuAction) => {
    const m = menu();
    if (!m) return;
    const r = m.row;
    if (action === 'cancel') { dismissMenu(); return; }
    if (action === 'addToList') { await openPicker(r); return; }
    if (action === 'rename') { openKeyboard('rename', r, r.name); return; }
    dismissMenu();
    let ok = false;
    if (action === 'toggleFavourite') {
      const isFav = m.isFavourite;
      ok = await applyOps([{ op: isFav ? 'removeFromList' : 'addToList', listId: FAV_LIST_ID, channelIds: [r.id] }]);
      if (ok) showToast(isFav ? 'Removed from Favourites' : 'Added to Favourites');
    } else if (action === 'removeFromList' && m.inListId !== undefined) {
      ok = await applyOps([{ op: 'removeFromList', listId: m.inListId, channelIds: [r.id] }]);
      const name = listsFromGroups().find((l) => l.id === m.inListId)?.name;
      if (ok) showToast(name ? `Removed from "${name}"` : 'Removed from the list');
    } else if (action === 'hide' || action === 'unhide') {
      ok = await applyOps([{ op: action === 'hide' ? 'hideChannels' : 'unhideChannels', ids: [r.id] }]);
      if (ok) showToast(action === 'hide' ? 'Channel hidden' : 'Channel shown');
    }
    if (ok && alive) await reload(r.id).catch(() => undefined);
  };

  /** Picker Ok: toggles the channel in a list, or opens the keyboard for a new one. The picker stays open. */
  const pick = async (p: PickerRow) => {
    const s = picker();
    if (!s || edit()) return;
    if (p.kind === 'new') { openKeyboard('newList', s.row, 'New list'); return; }
    const op: LayoutOp = p.checked
      ? { op: 'removeFromList', listId: p.id, channelIds: [s.row.id] }
      : { op: 'addToList', listId: p.id, channelIds: [s.row.id] };
    if (!(await applyOps([op])) || !alive) return;
    await Promise.all([rereadPicker(s.row), reload(s.row.id)]).catch(() => undefined);
  };

  /** Keyboard Done: creates the list (with the channel in it) or renames the channel. */
  const submitEdit = async () => {
    const e = edit();
    if (!e) return;
    if (e.kind === 'newList') {
      const v = validateListName(e.value);
      // Shown in the keyboard (not a toast, which would be a Back layer above it).
      if (!v.ok) { setEdit({ ...e, error: v.message }); return; }
      const id = newListId(new Set(picker()?.lists.map((l) => l.id) ?? []));
      dismissKeyboard(); // back to the picker, which shows the new list checked
      const ops: LayoutOp[] = [{ op: 'createList', id, name: v.name }, { op: 'addToList', listId: id, channelIds: [e.row.id] }];
      if (!(await applyOps(ops)) || !alive) return;
      await Promise.all([rereadPicker(e.row), reload(e.row.id)]).catch(() => undefined);
      return;
    }
    const r = renameOutcome(e.value, e.row.name);
    if (r.kind === 'error') { setEdit({ ...e, error: r.message }); return; }
    dismissAll();
    if (r.kind === 'unchanged') return; // Done on the current name: nothing to store
    if (!(await applyOps([{ op: 'renameChannel', id: e.row.id, name: r.name }])) || !alive) return;
    showToast(r.name === null ? 'Original name restored' : 'Channel renamed');
    await reload(e.row.id).catch(() => undefined);
  };

  const listKeys = {
    onMove: (d: number) => {
      if (d < 0 && focus() === 0) return nav('list', 'up', true); // Up from the first row: the search bar
      selectRow(moveFocus(focus(), d, total()));
      return true;
    },
    onPage: (dir: 1 | -1) => { selectRow(pageFocus(focus(), dir, LIST_ROWS, total())); return true; },
    onLeft: () => nav('list', 'left') || focusArea('groups'), // the open keyboard first: it hides the groups
    onOk: watch,
    onOptions: openMenu,
  };

  const onGroupSelect = (i: number) => {
    if (kbOpen()) return; // the compact keyboard covers the groups column
    const gi = groupChoice(i, searching());
    const g = gi === undefined ? undefined : groups()[gi];
    if (!g) return;
    stopPreview();
    if (searching()) {
      // Choosing a group ends search mode and opens that group.
      finishExit({ groupId: g.id, top: 0 }, 'groups');
      return;
    }
    void openGroup(g.id);
  };

  // ---- pointer (mouse, pointer remote); hover never reaches Home, so it never previews ----

  /**
   * The rename / new-list keyboard is a screen-layer target: while it is open, Home's other targets (list, groups, bar,
   * video, bottom buttons, and the menu or picker under it) are off, and a click on its scrim is Back (cancel).
   */
  const pointerOn = () => edit() === undefined;

  /** Green and the bottom row's Guide button. */
  const openGuide = () => {
    router.push('guide', groupId() !== undefined ? { groupId: groupId() } : undefined);
  };

  /** Movies and Series open over Home and stop the preview there; Back to Live TV resumes the channel that was playing (`vodReturnTarget`). */
  const goTab = (t: TabId) => {
    if (modalOpen() || kbOpen()) return;
    const nav = tabNavigation('live', t);
    if (nav.action === 'push') router.push(nav.to.screen, tabParams(nav.to));
  };

  /** A click focuses the row like the D-pad, then the same rule as Ok: play in the small video, or fullscreen. */
  const clickChannel = (i: number, double: boolean) => {
    const r = rowAt(i);
    const g = groupId();
    if (!r || g === undefined || modalOpen()) return;
    const action = rowPointerAction(double ? 'doubleClick' : 'click', { kind: 'channel', channel: r }, playback.current()?.id, requested());
    batch(() => {
      selectRow(i);
      focusArea('list');
    });
    if (action === 'fullscreen') {
      memory.channelId = r.id;
      openFullscreen(r.id, g);
    } else if (action === 'preview') {
      playHere(r.id, g);
    }
  };

  /** Right click or `⋯`: the channel options menu on that row (the same as Menu or Hold-OK). */
  const channelOptions = (i: number) => {
    if (modalOpen() || !rowAt(i)) return;
    batch(() => {
      selectRow(i);
      focusArea('list');
    });
    openMenu();
  };

  /** A click on a result: focus it, then the same rule as Ok (a double click goes fullscreen). */
  const clickResult = (i: number, double: boolean) => {
    const r = sRowAt(i);
    if (!isSelectable(r) || modalOpen()) return;
    const action = rowPointerAction(double ? 'doubleClick' : 'click', r, playback.current()?.id, requested());
    searchMemory = userNavigated(searchMemory);
    setSFocus(i);
    focusArea('list');
    runResult(r, action);
  };

  /** Clicking a group opens it, the same as focusing it and pressing Ok (the selected one just focuses the list). */
  const clickGroup = (i: number) => {
    if (kbOpen() || modalOpen()) return;
    focusArea('groups');
    if (i !== column().selected) onGroupSelect(i);
    queueMicrotask(() => { if (alive) focusArea('list'); });
  };

  /** A click on the video: fullscreen on the loading preview, else on the playing channel. */
  const clickVideo = () => {
    const id = requested() ?? playback.current()?.id;
    if (id === undefined || modalOpen()) return;
    if (searching()) {
      const at = sFocus();
      openFullscreen(id, GROUP_ALL, () => { searchMemory = leaveTo(searchMemory, at); });
      return;
    }
    const target = videoClickGroup(id, focusedRow()?.id, groupId());
    if (target.remember) memory.channelId = id;
    openFullscreen(id, target.groupId);
  };

  /** A click that focuses one of Home's nodes goes through Home's own focus areas (the compact keyboard's keys). */
  const focusFromPointer = (node: ElementNode) => {
    const place: Place | undefined = node === tabsNode ? 'tabs' : node === groupNode ? 'groups' : node === barNode ? 'bar'
      : node === searchKbNode ? 'keyboard'
      : node === listNode || node === resultsNode ? 'list' : undefined;
    if (place) focusArea(place);
    else node.setFocus();
  };

  /** Pointer mode: the bottom hint line becomes these buttons. */
  const homeBar: PointerBarItem[] = [
    { id: 'search', label: HOME_POINTER_LABELS.search, onPress: () => { focusArea('bar'); } },
    { id: 'guide', label: HOME_POINTER_LABELS.guide, onPress: openGuide },
    { id: 'settings', label: HOME_POINTER_LABELS.settings, onPress: () => router.push('settings') },
  ];

  // ---- lifecycle ----

  onMount(() => {
    playback.setRect(PREVIEW_RECT);
    // The guide's title index became ready, or a guide import finished: re-run the open query (as on Search).
    // A source without live channels ends with focus on the tab bar (after a refresh, or when that refresh failed).
    const tabsIfNoLive = () => { if (alive && area() === 'groups' && !searching() && !modalOpen() && !kbOpen() && (groups().find((x) => x.id === GROUP_ALL)?.count ?? 0) === 0) focusArea('tabs'); };
    const rerun = (e: unknown) => { if (rerunsSearch(e as AppEvent) && searching()) searcher.setQuery(query()); };
    const offs = [
      onEvent('progress', (p) => setProgress(p as Progress)),
      onEvent('refreshed', (e) => {
        setWaiting(false);
        void reload().then(() => {
          tabsIfNoLive();
        }).catch(() => undefined);
        rerun(e);
      }),
      onEvent('searchReady', rerun),
      // A companion changed the layout (the shell shows "Updated from your phone"): re-read, keeping focus by
      // id. Changes made on this screen re-read on their own.
      onEvent('layoutChanged', (e) => {
        if ((e as LayoutChanged).origin !== 'remote') return;
        // An open channel menu is rebuilt from the fresh state once the groups are re-read.
        void reload().then(rebuildMenu).catch(() => undefined);
        const p = picker();
        if (p) void rereadPicker(p.row).catch(() => undefined);
      }),
      // A companion switched, added or deleted a source (the shell shows "Updated from your phone"): drop menus of
      // the old source and re-read the groups and list of the new one. Changes from this screen's own app re-read themselves.
      onEvent('sourcesChanged', (e) => {
        if ((e as SourcesChanged).origin !== 'remote') return;
        dismissAll();
        dismissSearchKeyboard();
        // Results belong to the old source: leave search mode first, then re-read as before.
        const wasSearching = searching();
        if (wasSearching) finishExit(undefined, 'bar');
        void reload().then(() => {
          if (!alive) return;
          setWaiting((groups().find((x) => x.id === GROUP_ALL)?.count ?? 0) === 0);
          if (wasSearching) focusArea(total() > 0 ? 'list' : 'groups');
        }).catch(() => undefined);
      }),
      onEvent('refreshFailed', () => { setWaiting(false); tabsIfNoLive(); }),
      // Background short-EPG answers: refetch the cached pages holding those channels (visible ones right away).
      // The playing channel's info outside the list rows (preview panel) is re-read too.
      onEvent('nowNextUpdated', (e) => {
        const ids = (e as { channelIds: string[] }).channelIds;
        if (cache.invalidateRows(ids) > 0) load();
        const playingId = playback.current()?.id;
        if (playingId !== undefined && playingInfoStale(ids, playingId, focusedRow()?.id)) rereadPlayingInfo(playingId);
      }),
    ];
    const stopTick = visibleInterval(onTick, 30_000); // sleeps while the page is hidden
    onCleanup(() => { for (const off of offs) off(); stopTick(); });
    // Back from the Player or the Guide while searching: the bar takes focus and the remembered query runs again.
    // `nextFocus` then restores the focused result.
    if (searching()) {
      focusArea('bar');
      searcher.setQuery(query());
    }

    const exitsAtStart = searchExits;
    void (async () => {
      try {
        const gs = await api.getGroups();
        if (!alive) return;
        setGroups(gs);
        // Focus order: the playing channel (it may have zapped away in the Player), the remembered channel, the
        // last channel from init, then the remembered row / the first row.
        // Back from Movies or Series: the channel they stopped counts as the playing one (focus and resume), so it
        // plays again through the same path as Ok (the refusal cooldown holds it; the dev resume gate applies).
        const playingId = playback.current()?.id
          ?? vodReturnTarget({
            fromVod: focusTabsHint, fromSearch: vodReturn?.fromSearch, returnId: vodReturn?.id, held, gatePaused: devResume.paused(),
          });
        let g = pickGroup(gs, memory.groupId ?? params.lastGroupId);
        // An empty cache on first start: the list arrives with a later `refreshed` event. A source with only movies
        // and series has no channels to wait for: it shows the no-live text and focuses the tab bar instead.
        const allCount = gs.find((x) => x.id === GROUP_ALL)?.count ?? 0;
        if (waitsForChannels(allCount, initState()?.hasVod)) setWaiting(true);
        const vodOnly = allCount === 0 && initState()?.hasVod === true;
        // A channel reached by number entry may be outside the remembered group: show it in "All".
        if (playingId !== undefined && g !== undefined && g !== GROUP_ALL && gs.some((x) => x.id === GROUP_ALL)
          && await api.indexOf(g, playingId).catch(() => -1) < 0) g = GROUP_ALL;
        if (!alive) return;
        // Search mode was left while this loaded: that exit already restored the saved group, row and focus.
        const exited = () => searchExits !== exitsAtStart;
        const found = g === undefined || exited() ? undefined
          : await openGroup(g, [playingId, focusHint, memory.channelId, params.lastChannelId]);
        if (!alive) return;
        // `found` only places the focus. The preview re-plays the playing channel (no reconnect), or on the first
        // mount of the page resumes init's last channel; never a row that was only browsed to. A last channel that is
        // gone or hidden is not resumed: nothing plays until Ok. Search mode never starts playback without Ok.
        const resume = resumeTarget({ playingId, lastChannelId: params.lastChannelId, found, startupDone: startupResumed, held });
        startupResumed = true;
        if (resume && !searching()) void (playingId !== undefined ? playById(resume) : resumeLast(resume));
        setReady(true);
        if (!searching() && !exited()) {
          const toTabs = focusTabsHint || (vodOnly && total() === 0 && router.topOverlay() === undefined);
          focusArea(toTabs ? 'tabs' : total() > 0 ? 'list' : 'groups');
        }
      } catch (err) {
        console.warn('Home load failed', err instanceof Error ? err.name : 'Error');
        setReady(true);
      }
    })();
  });

  onCleanup(() => {
    alive = false;
    focusRest.cancel();
    void api.focusChannel(undefined).catch(() => undefined); // no focused row once Home is gone
    playback.begin(); // drops any preview request still in flight
    removeKeyboard?.();
    removePicker?.();
    removeMenu?.();
    removeSearchKb?.();
    router.removeOverlay(SEARCH_KB_ID);
    searcher.dispose();
    router.removeOverlay(KEYBOARD_ID);
    router.removeOverlay(PICKER_ID);
    router.removeOverlay(MENU_ID);
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    if (searching()) return nav(area(), 'back');
    if (area() === 'groups' && total() > 0) return focusArea('list');
    return false;
  };

  const emptyText = () => {
    if (!ready()) return '';
    if (waiting()) {
      const p = progress();
      return p ? `Loading channels… ${p.count}` : 'Loading channels…';
    }
    return groupId() === GROUP_ALL ? NO_LIVE_TEXT : emptyGroupText(groupId());
  };

  return (
    <PointerFocusContext.Provider value={focusFromPointer}>
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}
      forwardFocus={() => { focusArea(area()); return true; }}
      onYellow={() => { router.push('search'); return true; }}
      onGreen={() => { openGuide(); return true; }}
      onBlue={() => { router.push('settings'); return true; }}>
      {/* Opaque background everywhere except the preview box, which stays a hole onto the video. */}
      <View width={LAYOUT.width} height={PREVIEW_RECT.y} color={COLORS.background} />
      <View y={PREVIEW_RECT.y + PREVIEW_RECT.h} width={LAYOUT.width} height={LAYOUT.height - PREVIEW_RECT.y - PREVIEW_RECT.h}
        color={COLORS.background} />
      <View y={PREVIEW_RECT.y} width={PREVIEW_RECT.x} height={PREVIEW_RECT.h} color={COLORS.background} />
      <View x={PREVIEW_RECT.x + PREVIEW_RECT.w} y={PREVIEW_RECT.y} width={LAYOUT.width - PREVIEW_RECT.x - PREVIEW_RECT.w}
        height={PREVIEW_RECT.h} color={COLORS.background} />

      <TabBar ref={(el) => { tabsNode = el; }} active="live" onSelect={goTab}
        onDown={() => nav('tabs', 'down')} onFocusChanged={(f) => { if (f) setArea('tabs'); }} pointerEnabled={pointerOn()} />
      <Show when={showPhoneBadge(companionStatus())}><PhoneBadge /></Show>
      <SearchBar ref={(el) => { barNode = el; }} x={LIST_X} y={HEAD_Y} width={LIST_W} value={query()}
        count={searching() ? countText(sState()) : ''} editing={kbOpen()}
        onFocusChanged={(f) => { if (f) setArea('bar'); }}
        onOpenKeyboard={openSearchKeyboard} onDown={() => nav('bar', 'down')} onUp={() => nav('bar', 'up')} onLeft={() => nav('bar', 'left')}
        onBack={onBack} onType={(t) => setBarText(query() + t)}
        onClick={() => { focusArea('bar'); }}
        onKeyboardButton={() => { focusArea('bar'); openSearchKeyboard(); }} pointerEnabled={pointerOn()} />

      {/* Hidden (not unmounted) under the compact keyboard: `groupNode` stays valid for focus after it closes. */}
      <View width={LAYOUT.width} height={LAYOUT.height} alpha={kbOpen() ? 0 : 1}>
        <GroupList ref={(el) => { groupNode = el; }} x={GROUP_X} y={BODY_Y} width={GROUP_W} height={LIST_H}
          groups={column().rows} selected={column().selected} onSelect={onGroupSelect} onRight={() => focusArea('list')}
          onEdgeUp={() => nav('groups', 'up', true)} onRowClick={clickGroup} pointerEnabled={pointerOn()} />
      </View>

      <Show when={!searching()}>
        <ChannelList ref={(el) => { listNode = el; }} x={LIST_X} y={BODY_Y} width={LIST_W} height={LIST_H}
          total={total()} top={top()} focus={focus()} row={rowAt} now={now()} playingId={playback.current()?.id}
          onFocusChanged={(f) => { if (f) setArea('list'); }} {...listKeys}
          onRowClick={clickChannel} onRowOptions={channelOptions} pointerEnabled={pointerOn()}
          onWheelStep={(d) => { if (d > 0 || focus() > 0) listKeys.onMove(d); }} />
      </Show>
      <Show when={!searching() && ready() && !reloading() && total() === 0}>
        <Text x={LIST_X + 24} y={BODY_Y + 24} width={LIST_W - 48} maxWidth={LIST_W - 48} contain="width"
          fontSize={FONT.body} color={COLORS.muted}>{emptyText()}</Text>
      </Show>
      <Show when={searching()}>
        <SearchResultList ref={(el) => { resultsNode = el; }} x={LIST_X} y={BODY_Y} width={LIST_W} height={LIST_H}
          rows={shownRows()} top={sTop()} focus={sFocus()} now={now()} playingId={playback.current()?.id}
          onMove={(d) => {
            searchMemory = userNavigated(searchMemory);
            const next = stepSelectable(sFocus(), d, sTotal(), (i) => isSelectable(sRowAt(i)));
            if (d < 0 && next === sFocus()) return nav('list', 'up', true); // Up from the first result: the bar
            setSFocus(next);
            return true;
          }}
          onPage={(dir) => {
            searchMemory = userNavigated(searchMemory);
            const target = Math.max(0, Math.min(sTotal() - 1, sFocus() + dir * LIST_ROWS));
            setSFocus(firstSelectable(target, sTotal(), (i) => isSelectable(sRowAt(i))));
            return true;
          }}
          onLeft={() => nav('list', 'left')}
          onOk={() => { searchMemory = userNavigated(searchMemory); return openResult(); }}
          onRowClick={clickResult}
          onWheelStep={(d) => {
            // The wheel stays in the results: it never moves on to the bar.
            const next = stepSelectable(sFocus(), d, sTotal(), (i) => isSelectable(sRowAt(i)));
            if (next === sFocus()) return;
            searchMemory = userNavigated(searchMemory);
            setSFocus(next);
          }} />
        <Show when={resultsMessage(sState())}>{(m) => (
          <Text x={LIST_X + 24} y={BODY_Y + 24} width={LIST_W - 48} maxWidth={LIST_W - 48} contain="width" maxLines={2}
            fontSize={FONT.body} color={COLORS.muted}>{m()}</Text>
        )}</Show>
      </Show>

      <PreviewPanel x={PREVIEW_X} y={BODY_Y} channel={panel().channel} starting={panel().starting} idle={pausedNote() ? PAUSED_NOTE : undefined}
        status={playback.status()} playing={playback.current() !== undefined} now={now()}
        onVideoClick={pointerOn() ? clickVideo : undefined}
        cooldown={cooldownCopy(cooldown(), freshNow(now()), pointerMode())}
        onRetry={() => { void retryHere(playback.current() ? undefined : focusedRow()?.id); }} />

      <Show when={!pointerMode()}
        fallback={<PointerBar x={GROUP_X} y={HINT_Y - 14} height={48} items={homeBar} enabled={pointerOn()} />}>
        <Text x={GROUP_X} y={HINT_Y} width={SAFE_W} maxWidth={SAFE_W} contain="width" maxLines={1} fontSize={FONT.small}
          color={COLORS.muted}>
          {searching() ? SEARCH_HINT : BROWSE_HINT}
        </Text>
      </Show>

      <Show when={menu()}>{(m) => (
        <ContextMenu ref={(el) => { menuNode = el; }} title={m().row.name} items={m().items} cancel="cancel"
          onChoose={(a) => void choose(a)} pointerEnabled={pointerOn()} />
      )}</Show>
      <Show when={picker()}>{(p) => (
        <ListPicker ref={(el) => { pickerNode = el; }} title={`Add "${p().row.name}" to`}
          rows={pickerRows(p().lists, p().member)} onPick={(r) => void pick(r)} pointerEnabled={pointerOn()} />
      )}</Show>
      <Show when={edit()}>{(e) => {
        let scrim: ElementNode | undefined;
        // A click outside the keyboard is Back (cancel), as in Settings' Channels page. The keyboard is a screen-layer
        // target, so this backdrop is one too (an overlay backdrop would be modal and block the keys): registered
        // before the keyboard, it loses to the keys.
        usePointerTarget({
          node: () => scrim, onClick: () => shellBack(), onContextMenu: () => shellBack(), onWheel: () => true,
        });
        return (
          <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={70}>
            <Keyboard ref={(el) => { keyboardNode = el; }} x={(LAYOUT.width - KEYBOARD_W) / 2}
              y={(LAYOUT.height - KEYBOARD_H) / 2}
              label={e().kind === 'newList' ? 'New list name' : 'Channel name (empty restores the original)'}
              value={e().value} onChange={(v) => { const cur = edit(); if (cur) setEdit({ kind: cur.kind, row: cur.row, value: limitTyping(cur.value, v) }); }}
              onDone={() => void submitEdit()} hint="Done saves · Back cancels" error={e().error} />
          </View>
        );
      }}</Show>
      <Show when={kbOpen()}>
        <Keyboard ref={(el) => { searchKbNode = el; }} layout={COMPACT_LAYOUT} x={GROUP_X} y={HEAD_Y}
          label="Channel or programme" value={query()} onChange={setBarText}
          onDone={() => fromKeyboard('done', false, true)}
          onEdgeRight={() => fromKeyboard('right', true, false)} onEdgeUp={() => fromKeyboard('up', true, false)} />
      </Show>
    </View>
    </PointerFocusContext.Provider>
  );
}
