/**
 * Live TV's state: where the screen opens (a Search target, the Player's hint, a return from a VOD tab or from
 * catch-up, else the remembered place), the guide's time window, the open group, the focused row and time, and the
 * guide rows read through one bounded `EpgCache` (the visible 2 h first, then the prefetch). Create it inside the
 * screen component: its signals, memos and the row-loading effects belong to the screen. Not unit-tested: the pure
 * rules live in guideLogic.ts, homeLogic.ts and liveLogic.ts.
 */
import { batch, createEffect, createMemo, createSignal } from 'solid-js';
import type { AppEvent } from '@iptv/app-api';
import type { GroupInfo } from '@iptv/core';
import { EPG_POINTER_ROWS, EPG_VIEW_ROWS } from '../../components/EpgGrid.tsx';
import { renderRange, scrollTopFor } from '../../components/virtualWindow.ts';
import { pointerMode } from '../../input/pointer.ts';
import type { ScreenEntry } from '../../shell/router.ts';
import { initState, markStartup } from '../../state/appState.ts';
import {
  VIEW_SPAN, blockIndexAt, buildBlocks, clampViewStart, guideBackMs, guideOpenTarget, guideWindow, prefetchRange, type Block,
} from '../guideLogic.ts';
import { returnedToLive } from '../homeLogic.ts';
import { hasNoLive, livePlaceOnOpen, type LivePlace } from './liveLogic.ts';
import { GUIDE_ROWS_PER_PAGE, memory, warmCache } from './liveMemory.ts';
import { createRowSignals } from './rowSignals.ts';

export const GROUP_ALL = 'all';
const ROW_BUFFER = 2;

type Progress = Extract<AppEvent, { type: 'progress' }>;

export function createLiveState(entry: ScreenEntry, alive: () => boolean) {
  const params = entry.params as {
    lastGroupId?: string; lastChannelId?: string; focusChannelId?: string; fromVod?: true;
    channelId?: string; groupId?: string; at?: number;
  };
  const opened = Date.now();
  const sourceId = initState()?.activeSourceId;
  // The source's catch-up days as last seen (same source), so the window is wide from the first frame and a remembered
  // time days back (a return from catch-up) is kept; read again on mount.
  const knownDays = memory.sourceId === sourceId ? memory.catchupDays ?? 0 : 0;
  /** The guide's time window, widened by the source's catch-up days (`guideBackMs`). */
  const [win, setWin] = createSignal(guideWindow(opened, guideBackMs(knownDays)));
  const [catchupDays, setCatchupDays] = createSignal(knownDays);
  // A channel and time to open at (Search's "later" rows return here with them).
  const target = guideOpenTarget(params, opened, win());
  // One-shot hint from the Player (the channel it showed last).
  const focusHint = params.focusChannelId;
  // One-shot from Back (or Live TV on the rail) on Start, Movies or Series: the stopped channel resumes and focus lands
  // on it in the grid (you return to what you were watching).
  const fromVod = returnedToLive(params);
  // Back from the catch-up player: the live resume is async (VodPlay's resumeLive), so focus comes from memory, not
  // from what plays. Only a plain return counts (no VOD return, Player hint or requested channel); every mount clears it.
  const fromCatchup = memory.fromCatchup === true && !fromVod && focusHint === undefined && target.channelId === undefined;
  memory.fromCatchup = undefined;
  const hasTarget = target.channelId !== undefined && typeof params.at === 'number';
  delete params.focusChannelId;
  delete params.fromVod;
  delete params.channelId;
  delete params.groupId;
  delete params.at;

  // A plain return (Settings, Search, catch-up) keeps the remembered time; a return to the playing channel shows now.
  const keepTime = target.channelId === undefined && focusHint === undefined && !fromVod && memory.viewStart !== undefined;
  const startView = keepTime ? clampViewStart(memory.viewStart!, win()) : target.viewStart;
  const startAnchor = keepTime
    ? Math.max(startView, Math.min(startView + VIEW_SPAN - 1, memory.anchor ?? opened)) : target.anchor;

  const [now, setNow] = createSignal(opened);
  const [groups, setGroups] = createSignal<GroupInfo[]>([]);
  const [groupId, setGroupId] = createSignal<string | undefined>(undefined);
  /** Guide rows re-run per page as pages land (not all rows on any page), and all of them on a group change. */
  const rowSignals = createRowSignals(GUIDE_ROWS_PER_PAGE, (v) => {
    const [read, write] = createSignal(v);
    return [read, (n: number) => { write(n); }];
  });
  const [row, setRow] = createSignal(0);
  const [viewStart, setViewStart] = createSignal(startView);
  const [anchor, setAnchor] = createSignal(startAnchor);
  const [place, setPlace] = createSignal<LivePlace>(livePlaceOnOpen({ hasTarget, fromCatchup }));
  const [expanded, setExpanded] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  /** The first read of the groups failed and is retried (`firstLoad`); a successful re-read clears it. */
  const [groupsFailed, setGroupsFailed] = createSignal(false);
  const [progress, setProgress] = createSignal<Progress | undefined>(undefined);
  /** Bumped when rows should be fetched again (stale pages, the 30 s tick). */
  const [kick, setKick] = createSignal(0);

  // The last visit's rows (same source), so the grid draws them at once (`warmCache`).
  const cache = warmCache(sourceId, (change) => rowSignals.apply(change));

  let lastTop = 0;
  let startupMarked = false;
  const viewRows = () => (pointerMode() ? EPG_POINTER_ROWS : EPG_VIEW_ROWS);
  const total = () => { rowSignals.trackAll(); return cache.total() ?? 0; };
  /** Channels in the group: its count is known before the first rows arrive (and while a reload emptied the cache). */
  const groupCount = () => total() || (groups().find((g) => g.id === groupId())?.count ?? 0);
  const channelAt = (i: number) => { rowSignals.track(i); return cache.channel(i); };
  const blocksAt = (i: number): Block[] => {
    rowSignals.track(i);
    const w = win();
    const covered = cache.covered(i)
      .map((r) => ({ start: Math.max(r.start, w.start), end: Math.min(r.end, w.end) }))
      .filter((r) => r.end > r.start);
    return buildBlocks(cache.programmes(i), covered);
  };
  const top = createMemo(() => {
    const t = total();
    if (t === 0) return lastTop;
    lastTop = scrollTopFor(row(), lastTop, viewRows(), t);
    return lastTop;
  });
  const rowBlocks = createMemo(() => blocksAt(row()));
  const focusIndex = createMemo(() => blockIndexAt(rowBlocks(), anchor()));
  const focusBlock = () => rowBlocks()[focusIndex()];
  const focusChannel = () => channelAt(row());
  const focusedId = createMemo(() => focusChannel()?.id);
  const groupName = () => groups().find((g) => g.id === groupId())?.name ?? '';
  const onGrid = () => place() === 'grid' || place() === 'channels';
  const allCount = () => groups().find((x) => x.id === GROUP_ALL)?.count ?? 0;
  /** The source has no live channels and none are loading: the no-live text, and focus rests on the rail. */
  const noLive = () => hasNoLive({ waiting: waiting(), allCount: allCount(), failed: groupsFailed() });

  // ---- loading: the visible 2 h first, then the prefetch either side ----

  createEffect(() => {
    const g = groupId();
    if (g === undefined) return;
    kick();
    const r = renderRange(top(), viewRows(), Math.max(total(), 1), ROW_BUFFER);
    const vs = viewStart();
    const wide = prefetchRange(vs, win());
    const warn = (err: unknown) => console.warn('Guide rows failed', err instanceof Error ? err.name : 'Error');
    cache.ensure(r.from, Math.max(r.to, 1), vs, vs + VIEW_SPAN)
      .then(() => (alive() && cache.group() === g ? cache.ensure(r.from, Math.max(r.to, 1), wide.start, wide.end) : undefined))
      .catch(warn);
  });

  // Startup metric: the first rendered channel row (not the programme blocks). Not deferred to requestAnimationFrame,
  // which background or throttled tabs delay by seconds.
  createEffect(() => {
    if (startupMarked || !channelAt(top())) return;
    startupMarked = true;
    markStartup();
  });

  return {
    params, opened, sourceId, target, focusHint, fromVod, fromCatchup, hasTarget, cache,
    win, setWin, catchupDays, setCatchupDays, now, setNow, groups, setGroups, groupId, setGroupId, row, setRow,
    viewStart, setViewStart, anchor, setAnchor, place, setPlace, expanded, setExpanded, ready, setReady, waiting, setWaiting,
    groupsFailed, setGroupsFailed, progress, setProgress, kick, setKick,
    viewRows, total, groupCount, channelAt, blocksAt, top, rowBlocks, focusIndex, focusBlock, focusChannel, focusedId,
    groupName, onGrid, allCount, noLive,
    /** Focus on row `i` (its details folded). */
    setFocusRow: (i: number) => {
      batch(() => {
        setRow(i);
        setExpanded(false);
      });
      return true;
    },
    /** A group opens at `index`: the scroll starts a few rows above it. */
    scrollNear: (index: number) => { lastTop = Math.max(0, index - 3); },
  };
}

export type LiveState = ReturnType<typeof createLiveState>;
