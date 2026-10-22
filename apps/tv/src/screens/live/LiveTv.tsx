import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { AppEvent, ArchiveState, ChannelRow, ProgrammeLite } from '@iptv/app-api';
import type { GroupInfo } from '@iptv/core';
import { api, onEvent } from '../../api.ts';
import { DropdownHeader } from '../../components/DropdownHeader.tsx';
import { PAD_X as DROPDOWN_PAD_X } from '../../components/dropdownLogic.ts';
import { CHANNEL_W, EPG_GRID_X, EPG_POINTER_ROWS, EPG_VIEW_ROWS, EpgGrid, RULER_H } from '../../components/EpgGrid.tsx';
import { ListPicker } from '../../components/ListPicker.tsx';
import { PointerBar } from '../../components/PointerBar.tsx';
import { moveFocus, pageFocus, renderRange, scrollTopFor } from '../../components/virtualWindow.ts';
import { pointerMode } from '../../input/pointer.ts';
import { cooling } from '../../playback/cooldown.ts';
import { createDebounce } from '../../playback/debounce.ts';
import { devResume } from '../../playback/devResume.ts';
import { deviceWindowMax, playback, pool, previewHold } from '../../playback/playback.ts';
import { multiviewOffered } from '../playerLogic.ts';
import { deviceCeiling, windowLimit } from '../multiview/windows.ts';
import { dwellSignal } from '../../shell/dwell.ts';
import { focusRailCollapsed, Rail } from '../../shell/Rail.tsx';
import type { RailId } from '../../shell/railLogic.ts';
import { goRail } from '../../shell/railNav.ts';
import { BOTTOM_ROW_H, BOTTOM_ROW_Y, SCREEN_ROW_X } from '../../shell/logic.ts';
import { router, type ScreenEntry } from '../../shell/router.ts';
import { COLORS, LAYOUT, TYPE } from '../../shell/theme.ts';
import { visibleInterval } from '../../shell/visibleInterval.ts';
import { companionStatus, initState, markStartup, settings } from '../../state/appState.ts';
import { externalLayoutChange } from '../../state/events.ts';
import { archiveStateOf, missingArchive } from '../../vod/catchupLogic.ts';
import { liveReturn } from '../../vod/liveReturn.ts';
import { EpgCache } from '../epgCache.ts';
import {
  HOUR, MINUTE, VIEW_SPAN, blockIndexAt, buildBlocks, clampViewStart, dayJumpTargets, dayJumpView, guideBackMs, guideOpenTarget,
  guideWindow, isOnAir, leftFromGrid, nowView, pageTime, prefetchRange, stepLeft, stepRight, type Block, type HStep,
} from '../guideLogic.ts';
import { resumeTarget, returnedToLive, videoClickGroup, vodReturnTarget, waitsForChannels } from '../homeLogic.ts';
import { focusAfterRefresh, type PickerRow } from '../homeMenuLogic.ts';
import { showPhoneBadge } from '../pairingLogic.ts';
import { LiveInfo } from './LiveInfo.tsx';
import {
  GRID_Y, INFO_W, INFO_X, LIVE_PREVIEW_RECT, PHONE_BADGE_POS, groupsRetryMs, hasNoLive, liveEmptyText, liveKey, liveOkAction, livePlaceOnOpen, locateFocus,
  sameInfo, type LiveKey, type LivePlace,
} from './liveLogic.ts';
import { createCatchupOpener } from './liveCatchup.ts';
import { createLiveMenu } from './liveMenu.tsx';
import { createLivePointer, useTypeToSearch } from './livePointer.ts';
import { createLivePreview } from './livePreview.ts';
import { LiveVideo } from './LiveVideo.tsx';

/** A focus that rests this long on a channel asks the worker for its now/next. It never plays. */
const FOCUS_REST_MS = 700;
const PICKER_ID = 'liveGroups';
const GROUP_ALL = 'all';
const ROW_BUFFER = 2;

type Progress = Extract<AppEvent, { type: 'progress' }>;
type LayoutChanged = Extract<AppEvent, { type: 'layoutChanged' }>;
type SourcesChanged = Extract<AppEvent, { type: 'sourcesChanged' }>;

/**
 * Position across Live TV visits (the Player, catch-up, Search and the VOD screens re-create the screen): the group,
 * the focused channel and row, and the focused time. `catchupDays` is the source's (`sourceId`) largest archive, so a
 * remount opens the wide window at once; `fromCatchup` marks a return from the catch-up player.
 */
const memory: {
  groupId?: string; channelId?: string; row?: number; anchor?: number; viewStart?: number;
  sourceId?: string; catchupDays?: number; fromCatchup?: boolean;
} = {};

/**
 * The guide's row cache, kept across Live TV visits (per source), so Back from Movies, Start or the Player draws the
 * rows it had at once instead of reading every page again (the screen itself is re-created). The mounted screen
 * listens through `warmListener`. While no Live TV is mounted, a refresh, a layout change or a source switch drops it,
 * and a short-EPG update marks its channels stale; pages older than 15 min are read again anyway (`maxAgeMs`).
 */
let warm: { sourceId: string | undefined; cache: EpgCache<ChannelRow, ProgrammeLite> } | undefined;
let warmListener: () => void = () => undefined;
let awayOffs: Array<() => void> = [];

function warmCache(sourceId: string | undefined, onChange: () => void): EpgCache<ChannelRow, ProgrammeLite> {
  for (const off of awayOffs) off();
  awayOffs = [];
  warmListener = onChange;
  if (warm?.sourceId !== sourceId || !warm) {
    warm = {
      sourceId,
      cache: new EpgCache<ChannelRow, ProgrammeLite>(
        (g, o, c, f, t) => api.getEpgRows(g, o, c, f, t),
        { rowsPerPage: 20, chunkMs: 3 * HOUR, maxEntries: 24, maxAgeMs: 15 * MINUTE, onChange: () => warmListener() },
      ),
    };
  }
  return warm.cache;
}

/** Live TV unmounted: its rows are kept, and dropped if the data changes before the next visit. */
function leaveWarm(cache: EpgCache<ChannelRow, ProgrammeLite>): void {
  warmListener = () => undefined;
  if (warm?.cache !== cache) return;
  const drop = () => { if (warm?.cache === cache) warm = undefined; };
  awayOffs = [
    onEvent('refreshed', drop),
    onEvent('layoutChanged', drop),
    onEvent('sourcesChanged', drop),
    onEvent('nowNextUpdated', (e) => { cache.staleChannels((e as { channelIds: string[] }).channelIds, (c) => c.id); }),
  ];
}

/** The first Live TV mount of this page has decided whether to resume init's last channel (see `resumeTarget`). */
let startupResumed = false;

const PHONE_BADGE_W = 144;
const PHONE_BADGE_H = 48;

/** "Phone": shown while a companion is connected (Settings → Manage on phone or computer). */
function PhoneBadge() {
  return (
    <View x={PHONE_BADGE_POS.x} y={PHONE_BADGE_POS.y} width={PHONE_BADGE_W} height={PHONE_BADGE_H} color={COLORS.surface}
      borderRadius={PHONE_BADGE_H / 2} border={{ width: 2, color: COLORS.subtle }}>
      <Text y={(PHONE_BADGE_H - TYPE.meta) / 2 - 3} width={PHONE_BADGE_W} maxWidth={PHONE_BADGE_W} contain="width"
        textAlign="center" fontSize={TYPE.meta} color={COLORS.text}>{'Phone'}</Text>
    </View>
  );
}

/**
 * Live TV (UI revamp phase 2): one guide. A mini preview (top left) with the focused programme beside it, and a
 * full-width EPG grid below: 11 rows x 2 h, the group dropdown in the ruler's channel column. Rows come from
 * `getEpgRows` through one bounded `EpgCache` (the visible 2 h first, then the prefetch). Only OK plays: a channel
 * airing now previews in the mini window; OK again on it goes fullscreen.
 */
export function LiveTvScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as {
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
  const [version, setVersion] = createSignal(0);
  const [row, setRow] = createSignal(0);
  const [viewStart, setViewStart] = createSignal(startView);
  const [anchor, setAnchor] = createSignal(startAnchor);
  const [place, setPlace] = createSignal<LivePlace>(livePlaceOnOpen({ hasTarget, fromCatchup }));
  const [picking, setPicking] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  /** The first read of the groups failed and is retried (`firstLoad`); a successful re-read clears it. */
  const [groupsFailed, setGroupsFailed] = createSignal(false);
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const [progress, setProgress] = createSignal<Progress | undefined>(undefined);
  /** Bumped when rows should be fetched again (stale pages, the 30 s tick). */
  const [kick, setKick] = createSignal(0);

  let railNode: ElementNode | undefined;
  let headerNode: ElementNode | undefined;
  let gridNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let removePicker: (() => void) | undefined;
  let alive = true;
  let lastTop = 0;
  let groupSeq = 0;
  let startupMarked = false;
  /** False while the screen shows a group only for a channel target (Search): that must not replace the remembered one. */
  let rememberGroup = target.rememberGroup;

  const preview = createLivePreview(() => alive);
  // Playback was stopped on purpose (sleep timer): no resume on mount.
  const held = previewHold.take();
  // The live channel a Movies or Series tab (or a title opened from Search) stopped: taken by every mount, resumed only
  // on Back from that tab (or on the return from Search) and only for the source it came from.
  const vodReturn = liveReturn.take(initState()?.activeSourceId);

  // The last visit's rows (same source), so the grid draws them at once (`warmCache`).
  const cache = warmCache(sourceId, () => setVersion((v) => v + 1));
  /** The source the cached rows belong to (a remote source switch invalidates them). */
  let cacheSourceId = sourceId;

  const viewRows = () => (pointerMode() ? EPG_POINTER_ROWS : EPG_VIEW_ROWS);
  const total = () => { version(); return cache.total() ?? 0; };
  /** Channels in the group: its count is known before the first rows arrive (and while a reload emptied the cache). */
  const groupCount = () => total() || (groups().find((g) => g.id === groupId())?.count ?? 0);
  const channelAt = (i: number) => { version(); return cache.channel(i); };
  const blocksAt = (i: number): Block[] => {
    version();
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
      .then(() => (alive && cache.group() === g ? cache.ensure(r.from, Math.max(r.to, 1), wide.start, wide.end) : undefined))
      .catch(warn);
  });

  // Startup metric: the first rendered channel row (not the programme blocks). Not deferred to requestAnimationFrame,
  // which background or throttled tabs delay by seconds.
  createEffect(() => {
    if (startupMarked || !channelAt(top())) return;
    startupMarked = true;
    markStartup();
  });

  // The position to come back to.
  createEffect(() => {
    if (!ready()) return;
    if (rememberGroup) {
      memory.groupId = groupId();
      memory.row = row();
    }
    memory.anchor = anchor();
    memory.viewStart = viewStart();
    const id = focusedId();
    if (id !== undefined) memory.channelId = id;
  });

  // The info block follows the focus once it rests.
  // Equal while it shows the same thing: arriving prefetch pages rebuild the objects but must not restart the dwell.
  // On the channel cell it shows the row's programme on air now.
  const infoSource = createMemo(() => {
    const channel = focusChannel();
    if (!channel) return undefined;
    if (place() !== 'channels') return { channel, block: focusBlock() };
    const onNow = rowBlocks()[blockIndexAt(rowBlocks(), now())]; // the nearest block when none airs now
    return { channel, block: onNow && isOnAir(onNow, now()) ? onNow : undefined };
  }, undefined, { equals: sameInfo });
  const shown = dwellSignal(infoSource);

  // ---- focus ----

  const ctx = () => ({ row: row(), total: groupCount(), hasGroups: groups().length > 0 });
  /** `auto`: focus the screen moves by itself (no key), which keeps the rail collapsed. */
  const focusPlace = (p: LivePlace, auto = false) => {
    setPlace(p);
    if (p === 'rail' && auto) focusRailCollapsed(railNode);
    else (p === 'rail' ? railNode : p === 'groups' ? headerNode : gridNode)?.setFocus();
    return true;
  };
  /**
   * Where focus lands when it enters the content: the grid with channels, else the dropdown (an empty group), else the
   * rail (no groups, or a source without live channels).
   */
  const contentPlace = (): LivePlace => {
    if (noLive()) return 'rail';
    const r = liveKey('rail', 'right', ctx());
    return r === 'move' || r === 'exit' ? 'grid' : r;
  };
  /** Where focus lands on open: `contentPlace`, but a return to a programme (Search target, catch-up) lands on the timeline. */
  const openPlace = (): LivePlace => {
    const p = contentPlace();
    return p === 'channels' && livePlaceOnOpen({ hasTarget, fromCatchup }) === 'grid' ? 'grid' : p;
  };
  /** Routes a key through `liveKey`: `move` runs the place's own handler; `exit` lets Back bubble to the shell. */
  const go = (key: LiveKey, move: () => boolean = () => true): boolean => {
    const r = liveKey(place(), key, ctx());
    if (r === 'move') return move();
    if (r === 'exit') return false;
    // The timeline is entered at now and left to the channels with the view back at now (spec 2026-10-22, A).
    if ((place() === 'grid' && r === 'channels') || (place() === 'channels' && r === 'grid')) resetToNow();
    return focusPlace(r);
  };

  const setFocusRow = (i: number) => {
    batch(() => {
      setRow(i);
      setExpanded(false);
    });
    return true;
  };
  const applyStep = (s: HStep) => {
    if (s.kind !== 'move' && s.kind !== 'scroll') return;
    batch(() => {
      setViewStart(s.viewStart);
      setAnchor(s.anchor);
      setExpanded(false);
    });
  };
  const view = () => ({ viewStart: viewStart(), anchor: anchor() });
  const resetToNow = () => applyStep({ kind: 'move', index: 0, ...nowView(Date.now(), win()) });

  // ---- groups ----

  const openGroup = (g: string, index: number) => {
    groupSeq++;
    // The group's count (from getGroups) is the total, so opening needs no extra request for page 0.
    cache.setGroup(g, groups().find((x) => x.id === g)?.count);
    lastTop = Math.max(0, index - 3);
    batch(() => {
      setRow(index);
      setExpanded(false);
      setGroupId(g);
    });
  };

  /**
   * The group and row to open (`locateFocus`): `pinned` channels may switch to All, `others` never change the group.
   * `superseded` when another group was opened meanwhile.
   */
  const locate = async (gs: GroupInfo[], prefer: string | undefined, pinned: readonly (string | undefined)[],
    others: readonly (string | undefined)[], fallbackRow?: number): Promise<{ g: string | undefined; index: number } | 'superseded'> => {
    const seq = groupSeq;
    const found = await locateFocus({
      groups: gs, prefer, pinned, others, fallbackRow, indexOf: (g, id) => api.indexOf(g, id).catch(() => -1),
    });
    return seq !== groupSeq ? 'superseded' : found;
  };

  /**
   * Re-reads the groups and the guide (refresh, a remote change, a menu change), keeping focus on `keepId` (else the
   * focused channel) while it is still in the group; one that left (hidden, removed) hands its row to the next one.
   */
  let reloadSeq = 0;
  const reload = async (keepId0?: string): Promise<GroupInfo[] | undefined> => {
    const seq = ++reloadSeq;
    const keepId = keepId0 ?? focusedId() ?? memory.channelId;
    const before = groupId();
    const gs = await api.getGroups();
    if (!alive || seq !== reloadSeq) return undefined;
    setGroups(gs);
    setGroupsFailed(false); // a failed first read is answered (its retry stops)
    if (before !== undefined && gs.some((x) => x.id === before)) {
      // Same group: the rows stay on screen and are refetched (`setGroup` to the same group is a no-op, so no blank grid).
      cache.staleAll();
      setKick((k) => k + 1);
      // The channel's new row; one that left the group (hidden, removed) hands its row to the neighbour.
      const gSeq = groupSeq;
      const index = keepId === undefined ? -1 : await api.indexOf(before, keepId).catch(() => -1);
      if (!alive || seq !== reloadSeq || gSeq !== groupSeq) return gs;
      const count = gs.find((x) => x.id === before)?.count ?? 0;
      setFocusRow(focusAfterRefresh(index, row(), count));
      return gs;
    }
    // The group disappeared: All channels (or the first group; `openGroup` swaps the cache), at the same channel when it is there.
    const located = await locate(gs, undefined, [], [keepId]);
    if (!alive || seq !== reloadSeq || located === 'superseded' || located.g === undefined) return gs;
    openGroup(located.g, located.index);
    return gs;
  };

  const pickerRows = (): PickerRow[] => groups().map((g) => ({
    kind: 'list', id: g.id, label: `${g.name} · ${g.count}`, checked: g.id === groupId(),
  }));
  const openPicker = () => {
    if (picking() || groups().length === 0 || router.topOverlay() !== undefined) return;
    setPicking(true);
    removePicker = router.pushOverlay(PICKER_ID, closePicker);
    queueMicrotask(() => { if (alive) pickerNode?.setFocus(); });
  };
  /** Back on the picker: focus returns to the dropdown. */
  function closePicker() {
    removePicker = undefined;
    setPicking(false);
    queueMicrotask(() => { if (alive) focusPlace('groups'); });
  }
  const dismissPicker = () => { if (picking()) { removePicker?.(); closePicker(); } };
  /** A pick opens the group and focuses the grid at the playing channel, else row 0. */
  const pick = (r: PickerRow) => {
    removePicker?.();
    removePicker = undefined;
    setPicking(false);
    if (r.kind === 'list' && r.id !== groupId()) {
      rememberGroup = true;
      openGroup(r.id, 0);
      const seq = groupSeq;
      const playingId = playback.currentRowId();
      if (playingId !== undefined) {
        void api.indexOf(r.id, playingId).catch(() => -1).then((i) => {
          if (alive && seq === groupSeq && i >= 0) setFocusRow(i);
        });
      }
    }
    queueMicrotask(() => { if (alive) focusPlace(contentPlace(), true); });
  };

  // ---- OK ----

  /** The archive state of a block, with the in-memory "not available" marks. */
  const stateOf = (ch: ChannelRow, b: Block): ArchiveState => {
    if (b.filler || missingArchive.has(ch.id, b.start, Date.now())) return 'none';
    return archiveStateOf(ch.archiveDays, b, now(), b.archive);
  };

  /**
   * OK on a programme or the channel cell. Airing now (or the channel cell): the first OK previews in the mini window,
   * a second on the playing or requested channel goes fullscreen. Anything else toggles the details. While the source
   * cools down, OK is Retry (the preview box says so).
   */
  /** A pointer click on a cell: plays at once (preview, then full screen), as OK did before it opened the menu. */
  const play = () => {
    if (router.topOverlay() !== undefined) return true;
    const ch = focusChannel();
    const g = groupId();
    if (!ch || g === undefined) return true;
    if (cooling()) {
      void preview.retryHere(ch.id);
      return true;
    }
    const b = place() === 'channels' ? undefined : focusBlock();
    const action = liveOkAction({
      channelId: ch.id,
      onAir: b === undefined || isOnAir(b, Date.now()),
      archive: b === undefined ? 'none' : stateOf(ch, b),
      playingId: playback.currentRowId(),
      requestedId: preview.requested(),
    });
    memory.channelId = ch.id;
    if (action === 'preview') preview.playHere(ch.id, g);
    else if (action === 'fullscreen') preview.openFullscreen(ch.id, g);
    else if (action === 'details') setExpanded((v) => !v);
    else if (action === 'catchup' && b) openCatchup(ch, b);
    return true;
  };

  // ---- catch-up ----

  /** The archive mark of a cell: `past` the archive can play, `onAir` can play from its start. */
  const archiveMark = (i: number, b: Block): 'past' | 'onAir' | undefined => {
    const ch = channelAt(i);
    const s = ch ? stateOf(ch, b) : 'none';
    return s === 'available' ? 'past' : s === 'onAir' ? 'onAir' : undefined;
  };

  /** Right before the catch-up player opens: the return focuses the remembered row and time (see `fromCatchup`). */
  const openCatchup = createCatchupOpener(() => alive, () => { memory.fromCatchup = true; });

  /** The source's catch-up days arrived: the window reaches that far back; the view keeps its place inside it. */
  const applyCatchupDays = (days: number) => {
    memory.sourceId = initState()?.activeSourceId;
    memory.catchupDays = days;
    const w = guideWindow(opened, guideBackMs(days));
    batch(() => {
      setCatchupDays(days);
      if (w.start === win().start) return;
      setWin(w);
      const vs = clampViewStart(viewStart(), w);
      setViewStart(vs);
      setAnchor(Math.max(vs, Math.min(vs + VIEW_SPAN - 1, anchor())));
    });
  };
  const loadCatchupDays = () => api.catchupDays().catch(() => 0).then((d) => { if (alive) applyCatchupDays(d); });

  // Focus resting 600 ms on a past time of a catch-up row: ask the source for that row's own archive listings (Xtream).
  // Keyed on the id: arriving pages rebuild the row object and must not restart the wait.
  const refineId = createMemo(() => {
    const ch = focusChannel();
    return ch && ch.archiveDays !== undefined && anchor() < now() ? ch.id : undefined;
  });
  createEffect(() => {
    const id = refineId();
    if (id === undefined) return;
    const timer = setTimeout(() => { api.refineArchive(id).catch(() => undefined); }, 600);
    onCleanup(() => clearTimeout(timer));
  });

  // ---- the menu (programme items, then the channel's) ----

  const liveMenu = createLiveMenu({
    alive: () => alive,
    groups,
    groupId,
    stopPreview: preview.stopPreview,
    reload: async (id) => {
      const gs = await reload(id);
      // The change emptied the group (its last channel hidden or removed): focus moves to the dropdown.
      if (!alive || !gs || liveMenu.isOpen() || !onGrid() || (gs.find((g) => g.id === groupId())?.count ?? 0) > 0) return;
      focusPlace(groups().length > 0 ? 'groups' : 'rail', true);
    },
    // No layer left: back to the grid or the channel cell; a group the change emptied hands focus on (`contentPlace`).
    refocus: () => { focusPlace(groupCount() > 0 && onGrid() ? place() : contentPlace(), true); },
    dayTargets: () => dayJumpTargets(Date.now(), win()),
    goToDay: (at) => {
      const v = dayJumpView(at, Date.now(), win());
      batch(() => {
        setViewStart(v.viewStart);
        setAnchor(v.anchor);
        setExpanded(false);
      });
      if (groupCount() > 0) focusPlace('grid');
    },
    playSource: (rowId, sourceId) => {
      memory.channelId = rowId;
      void preview.playSource(rowId, sourceId, groupId());
    },
    // The playing channel (or this one) opens full screen as window 1; multiview then adds this row as window 2.
    multiview: {
      offered: () => multiviewOffered(windowLimit(deviceCeiling(deviceWindowMax()), settings()?.maxWindows ?? 'auto')),
      add: (rowId) => {
        const base = playback.currentRowId() ?? rowId;
        // Right after the Player is pushed (this screen is gone by then): multiview opens over it.
        preview.openFullscreen(base, groupId() ?? GROUP_ALL, () => {
          queueMicrotask(() => router.push('multiview', rowId === base ? {} : { channelId: rowId }));
        });
      },
    },
  });

  /**
   * Menu / long OK on the grid or the channel cell: one menu. "From the start" for an on-air programme whose channel
   * keeps an archive (not on the channel cell), "Go to day" when the source keeps catch-up days, then the channel items.
   */
  const openMenu = () => {
    if (router.topOverlay() !== undefined || !onGrid()) return true;
    const ch = focusChannel();
    if (!ch) return true;
    const b = place() === 'grid' ? focusBlock() : undefined;
    // The same rule as the cell's archive mark (`stateOf`): on air on a channel that keeps an archive.
    const fromStart = b !== undefined && stateOf(ch, b) === 'onAir' ? () => openCatchup(ch, b) : undefined;
    const g = groupId() ?? GROUP_ALL;
    const action = liveOkAction({
      channelId: ch.id,
      onAir: b === undefined || isOnAir(b, Date.now()),
      archive: b === undefined ? 'none' : stateOf(ch, b),
      playingId: playback.currentRowId(),
      requestedId: preview.requested(),
    });
    // "Watch" plays the programme's archive for a past one that has it, else the channel live in full screen.
    const watch = () => {
      memory.channelId = ch.id;
      if (action === 'catchup' && b) openCatchup(ch, b);
      else preview.openFullscreen(ch.id, g);
    };
    const toPreview = action === 'preview' ? () => { memory.channelId = ch.id; preview.playHere(ch.id, g); } : undefined;
    liveMenu.openMenu(ch, { watch, preview: toPreview, fromStart, goToDay: catchupDays() > 0 });
    return true;
  };

  /** OK opens the menu (owner 2026-10-22); a cooling channel's OK still retries it here. */
  const ok = () => {
    if (router.topOverlay() !== undefined) return true;
    const ch = focusChannel();
    if (ch && cooling()) {
      void preview.retryHere(ch.id);
      return true;
    }
    return openMenu();
  };

  const gridKeys = {
    onUp: () => go('up', () => setFocusRow(moveFocus(row(), -1, total()))),
    onDown: () => go('down', () => setFocusRow(moveFocus(row(), 1, total()))),
    onLeft: () => go('left', () => {
      const s = leftFromGrid(rowBlocks(), focusIndex(), view(), win(), Date.now());
      if (s.kind === 'channels') { resetToNow(); return focusPlace('channels'); }
      if (s.kind === 'edge') setPlace('channels');
      else applyStep(s);
      return true;
    }),
    onRight: () => go('right', () => {
      applyStep(stepRight(rowBlocks(), focusIndex(), view(), win()));
      return true;
    }),
    onPage: (dir: 1 | -1) => setFocusRow(pageFocus(row(), dir, viewRows(), total())),
    onOk: ok,
    onMenu: openMenu,
    onLongOk: openMenu,
  };

  // ---- pointer and typing ----

  /** The rename / new-list keyboard is modal for the pointer: while it is open no other target of the screen takes it. */
  const pointerOn = () => !liveMenu.editing();
  const pointer = createLivePointer({
    row, place, total, viewStart,
    focusStart: () => focusBlock()?.start,
    focusPlace: (p) => { focusPlace(p); },
    setFocusRow: (i) => { setFocusRow(i); },
    focusTime: (t) => batch(() => { setAnchor(t); setExpanded(false); }),
    stepTime: (dir) => {
      const s = dir > 0 ? stepRight(rowBlocks(), focusIndex(), view(), win()) : stepLeft(rowBlocks(), focusIndex(), view(), win());
      if (s.kind !== 'edge') applyStep(s);
    },
    pageTime: (dir) => applyStep(pageTime(view(), dir, win())),
    ok: play,
    openMenu,
    videoChannel: () => preview.requested() ?? playback.currentRowId(),
    // The open group when the video shows the focused channel, else All (as on Home).
    openVideo: (id) => {
      const t = videoClickGroup(id, focusedId(), groupId());
      if (t.remember) memory.channelId = id;
      preview.openFullscreen(id, t.groupId);
    },
  });

  // A focus that rests for FOCUS_REST_MS tells the worker, which may look up that channel's now/next (short EPG, only
  // for channels without a stored guide). The answer fills that row's guide (`getEpgRows` merges the cached short EPG;
  // `nowNextUpdated` refetches the row). It never plays anything.
  let restReported = false;
  const focusRest = createDebounce<string>(FOCUS_REST_MS, (id) => {
    if (!alive || focusedId() !== id || !onGrid()) return;
    restReported = true;
    void api.focusChannel(id).catch(() => undefined);
  });
  /** A layer of this screen is open: the group picker, or the menu's (menu, list picker, keyboard, day choice). */
  const layerOpen = () => picking() || liveMenu.isOpen();
  // A letter or digit typed on the grid or the channel cell opens Search seeded with it.
  useTypeToSearch(() => alive && !layerOpen() && onGrid());
  createEffect(on([focusedId, onGrid, ready, layerOpen], ([id, grid, isReady, isPicking]) => {
    if (id === undefined || !grid || !isReady || isPicking) {
      focusRest.cancel();
      // The grid lost the focus: the worker drops the stale focused id.
      if (restReported) {
        restReported = false;
        void api.focusChannel(undefined).catch(() => undefined);
      }
      return;
    }
    focusRest.schedule(id);
  }));

  /** A rail choice. Start, Movies and Series open over Live TV; Live TV here is a no-op (it is the stack root). */
  const railSelect = (t: RailId) => {
    if (router.topOverlay() !== undefined) return;
    goRail('live', t, () => undefined);
  };

  // ---- lifecycle ----

  /**
   * Resume, in parallel with the guide load: the playing channel again (back from the Player; no reconnect), the
   * channel a VOD screen stopped, or on the page's first mount init's last channel when it is still listed.
   */
  const startResume = (playingId: string | undefined) => {
    const startupDone = startupResumed;
    startupResumed = true;
    const last = params.lastChannelId;
    if (playingId !== undefined) {
      const r = resumeTarget({ playingId, lastChannelId: last, found: undefined, startupDone, held });
      if (r !== undefined) void preview.playById(r);
      return;
    }
    if (held || startupDone || last === undefined) return;
    void api.indexOf(GROUP_ALL, last).catch(() => -1).then((i) => {
      if (!alive) return;
      const r = resumeTarget({ playingId: undefined, lastChannelId: last, found: i >= 0 ? last : undefined, startupDone, held });
      if (r !== undefined) void preview.resumeLast(r);
    });
  };

  /**
   * After a refresh or a source change: no live channels: the rail; the open group became empty: the dropdown; the
   * group the empty state parked focus above (`hadChannels` false) got channels: the grid. Never under a layer.
   */
  const settleFocus = (hadChannels: boolean) => {
    if (!alive || !ready() || router.topOverlay() !== undefined || layerOpen()) return;
    if (noLive()) {
      if (place() !== 'rail') focusPlace('rail', true);
      return;
    }
    if (onGrid() && groupCount() === 0) focusPlace(contentPlace(), true);
    else if (!hadChannels && place() === 'groups' && groupCount() > 0) focusPlace('grid');
  };

  onMount(() => {
    playback.setRect(LIVE_PREVIEW_RECT);
    void loadCatchupDays(); // in parallel with the groups: it only widens the window back in time
    // Back from Movies or Series: the channel they stopped counts as the playing one (focus and resume).
    const playingId = playback.currentRowId()
      ?? vodReturnTarget({ fromVod, fromSearch: vodReturn?.fromSearch, returnId: vodReturn?.id, held, gatePaused: devResume.paused() });
    startResume(playingId);

    // Aligned to the minute boundary, so the clock labels and the now line change on the minute.
    let stopMinute: (() => void) | undefined;
    const first = setTimeout(() => {
      setNow(Date.now());
      stopMinute = visibleInterval(() => setNow(Date.now()), MINUTE); // sleeps while the page is hidden
    }, MINUTE - (Date.now() % MINUTE));
    // 30 s tick: the cooldown countdown, and expired guide pages are fetched again.
    const stopTick = visibleInterval(() => {
      setNow(Date.now());
      setKick((k) => k + 1);
    }, 30_000);
    const allIn = (gs: readonly GroupInfo[]) => gs.find((x) => x.id === GROUP_ALL)?.count ?? 0;
    const offs = [
      onEvent('progress', (p) => setProgress(p as Progress)),
      onEvent('refreshed', () => {
        const had = groupCount() > 0;
        setWaiting(false);
        void reload().then(() => settleFocus(had)).catch(() => undefined);
      }),
      // A companion changed the layout, or a backup was restored: re-read, keeping focus by id. Changes made on this
      // screen re-read on their own.
      onEvent('layoutChanged', (e) => {
        if (!externalLayoutChange(e as LayoutChanged)) return;
        // An open menu is rebuilt from the fresh state once the groups are re-read; an open list picker re-reads too.
        void reload().then(() => liveMenu.rebuildMenu()).catch(() => undefined);
        liveMenu.rereadOpenPicker();
      }),
      // A companion switched, added or deleted a source: drop the picker of the old source and re-read.
      onEvent('sourcesChanged', (e) => {
        const ev = e as SourcesChanged;
        if (ev.origin !== 'remote') return;
        // Another source's rows are never valid, not even under the same group id: drop them (answers in flight too).
        if (ev.activeSourceId !== cacheSourceId) {
          cacheSourceId = ev.activeSourceId;
          cache.invalidate();
          if (warm?.cache === cache) warm.sourceId = ev.activeSourceId;
        }
        dismissPicker();
        liveMenu.dismissAll();
        void loadCatchupDays();
        const had = groupCount() > 0;
        void reload().then((gs) => {
          if (!alive || !gs) return;
          setWaiting(allIn(gs) === 0);
          settleFocus(had);
        }).catch(() => undefined);
      }),
      onEvent('refreshFailed', () => {
        setWaiting(false);
        settleFocus(true);
      }),
      // The source's own archive listings for the focused row arrived: fetch that row again (no flicker).
      onEvent('archiveRefined', (e) => {
        if (focusedId() !== (e as { channelId?: string }).channelId) return;
        cache.stalePage(row());
        setKick((k) => k + 1);
      }),
      // Background short-EPG answers (the focused or playing channel): every cached page holding them is fetched again.
      onEvent('nowNextUpdated', (e) => {
        if (cache.staleChannels((e as { channelIds: string[] }).channelIds, (c) => c.id) > 0) setKick((k) => k + 1);
      }),
    ];
    onCleanup(() => {
      clearTimeout(first);
      stopMinute?.();
      stopTick();
      for (const off of offs) off();
    });

    /**
     * Reads the groups and opens the focus group. A failed read (the worker) is not "no live channels": the info block
     * says so and the read runs again (`groupsRetryMs`) until it, or a `refreshed` re-read, succeeds. A retry that
     * succeeds leaves the focus where the user put it meanwhile (`settleFocus`).
     */
    const firstLoad = async (attempt: number) => {
      try {
        const gs = await api.getGroups();
        if (!alive) return;
        setGroups(gs);
        setGroupsFailed(false);
        // An empty cache on first start: the channels arrive with a later `refreshed` event.
        if (waitsForChannels(allIn(gs), initState()?.hasVod)) setWaiting(true);
        // Focus order: a requested channel, the Player's last channel, the playing one (these may switch to All), then
        // the remembered one and init's last (these keep the group). One lookup when the first is in the group.
        // Back from catch-up the remembered channel comes first: the live channel resumes later (async).
        // The remembered row is the fallback in the remembered group (its channel was hidden or removed meanwhile).
        const prefer = target.groupId ?? memory.groupId ?? params.lastGroupId;
        const located = await locate(gs, prefer,
          fromCatchup ? [target.channelId] : [target.channelId, focusHint, playingId],
          fromCatchup ? [memory.channelId, playingId, params.lastChannelId] : [memory.channelId, params.lastChannelId],
          prefer !== undefined && prefer === memory.groupId ? memory.row : undefined);
        if (!alive || located === 'superseded') return;
        if (located.g !== undefined) openGroup(located.g, located.index);
      } catch (err) {
        console.warn('Live TV load failed', err instanceof Error ? err.name : 'Error');
        if (alive && groups().length === 0) {
          setGroupsFailed(true);
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (alive && groupsFailed()) void firstLoad(attempt + 1);
          }, groupsRetryMs(attempt));
        }
      } finally {
        if (alive && attempt === 0) {
          setReady(true);
          // The grid when it has channels, else the dropdown (an empty group), else the rail (no live channels).
          if (router.topOverlay() === undefined) focusPlace(openPlace(), true);
        } else if (alive && !groupsFailed()) {
          settleFocus(false);
        }
      }
    };
    void firstLoad(0);
  });

  onCleanup(() => {
    alive = false;
    leaveWarm(cache);
    clearTimeout(retryTimer);
    focusRest.cancel();
    void api.focusChannel(undefined).catch(() => undefined); // no focused row once Live TV is gone
    playback.begin(); // drops any preview request still in flight
    removePicker?.();
    router.removeOverlay(PICKER_ID);
    liveMenu.cleanup();
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    return go('back');
  };

  /** The info block's place while the group has no channels: the first load, no live channels, or an empty group. */
  const emptyText = () => liveEmptyText({
    waiting: waiting(), failed: groupsFailed(), progressCount: progress()?.count, allCount: allCount(), groupId: groupId(),
  });

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}
      forwardFocus={() => { focusPlace(place()); return true; }}
      onYellow={() => { if (router.topOverlay() === undefined) router.push('search'); return true; }}
      onBlue={() => { if (router.topOverlay() === undefined) router.push('settings'); return true; }}>
      <LiveVideo now={now()} pausedNote={preview.pausedNote()}
        onRetry={() => { void preview.retryHere(playback.current() ? undefined : focusedId()); }}
        onVideoClick={pointerOn() ? pointer.onVideoClick : undefined} />
      <Rail ref={(el) => { railNode = el; }} active="live" onSelect={railSelect} pointerEnabled={pointerOn()}
        onRight={() => go('right')} onFocusChanged={(f) => { if (f) setPlace('rail'); }} />

      <Show when={ready() && groupCount() === 0} fallback={
        <LiveInfo block={shown()?.block} channel={shown()?.channel} now={now()} expanded={expanded()} />
      }>
        <Text x={INFO_X} y={LAYOUT.safeY + 36} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={3}
          fontSize={TYPE.body} color={COLORS.muted}>{emptyText()}</Text>
      </Show>

      <EpgGrid ref={(el) => { gridNode = el; }} x={EPG_GRID_X} y={GRID_Y} total={total()} top={top()} rows={viewRows()}
        focusRow={row()} focusStart={focusBlock()?.start} area={place() === 'channels' ? 'channels' : 'grid'}
        viewStart={viewStart()} now={now()} playingId={playback.currentRowId()}
        channel={channelAt} blocks={blocksAt} archiveMark={archiveMark} {...gridKeys}
        onCellClick={pointer.onCellClick} onCellContextMenu={pointer.onCellMenu} onPointerWheel={pointer.onWheel}
        pointerEnabled={pointerOn()} />
      {/* In the ruler's channel column; after the grid, so it draws (and takes the pointer) on top of the ruler. */}
      <Show when={groups().length > 0}>
        <DropdownHeader ref={(el) => { headerNode = el; onCleanup(() => { if (headerNode === el) headerNode = undefined; }); }}
          x={EPG_GRID_X + DROPDOWN_PAD_X} y={GRID_Y} height={RULER_H} size={TYPE.meta} maxWidth={CHANNEL_W - 4}
          label={groupName()} onPress={openPicker} pointerEnabled={pointerOn()}
          onDown={() => go('down')} onLeft={() => go('left')} onRight={() => go('right')}
          onFocusChanged={(f) => { if (f) setPlace('groups'); }} />
      </Show>

      <Show when={showPhoneBadge(companionStatus())}><PhoneBadge /></Show>

      {/* Pointer mode only: the bottom row, after the shell's Back; the grid shows `EPG_POINTER_ROWS` above it. */}
      <PointerBar x={SCREEN_ROW_X} y={BOTTOM_ROW_Y} height={BOTTOM_ROW_H} items={pointer.bar} enabled={pointerOn()} />

      <Show when={picking()}>
        <ListPicker ref={(el) => { pickerNode = el; }} title="Groups" rows={pickerRows()} onPick={pick}
          hint="Ok picks · Back closes" />
      </Show>
      <liveMenu.View />
    </View>
  );
}
