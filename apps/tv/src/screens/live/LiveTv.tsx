import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { AppEvent, ArchiveState, ChannelRow, ProgrammeLite } from '@iptv/app-api';
import type { GroupInfo } from '@iptv/core';
import { api, onEvent } from '../../api.ts';
import { DropdownHeader } from '../../components/DropdownHeader.tsx';
import { PAD_X as DROPDOWN_PAD_X } from '../../components/dropdownLogic.ts';
import { CHANNEL_W, EPG_GRID_X, EPG_POINTER_ROWS, EPG_VIEW_ROWS, EpgGrid, RULER_H } from '../../components/EpgGrid.tsx';
import { ListPicker } from '../../components/ListPicker.tsx';
import { moveFocus, pageFocus, renderRange, scrollTopFor } from '../../components/virtualWindow.ts';
import { pointerMode } from '../../input/pointer.ts';
import { cooling } from '../../playback/cooldown.ts';
import { createDebounce } from '../../playback/debounce.ts';
import { devResume } from '../../playback/devResume.ts';
import { playback, previewHold } from '../../playback/playback.ts';
import { dwellSignal } from '../../shell/dwell.ts';
import { Rail } from '../../shell/Rail.tsx';
import type { RailId } from '../../shell/railLogic.ts';
import { goRail } from '../../shell/railNav.ts';
import { router, type ScreenEntry } from '../../shell/router.ts';
import { COLORS, LAYOUT, TYPE } from '../../shell/theme.ts';
import { visibleInterval } from '../../shell/visibleInterval.ts';
import { companionStatus, initState, markStartup } from '../../state/appState.ts';
import { archiveStateOf, missingArchive } from '../../vod/catchupLogic.ts';
import { liveReturn } from '../../vod/liveReturn.ts';
import { EpgCache } from '../epgCache.ts';
import {
  HOUR, MINUTE, VIEW_SPAN, blockIndexAt, buildBlocks, clampViewStart, guideOpenTarget, guideWindow, isOnAir, prefetchRange,
  stepLeft, stepRight, type Block, type HStep,
} from '../guideLogic.ts';
import { pickGroup, resolveFocus, restoreIndex, resumeTarget, returnedToLive, vodReturnTarget, waitsForChannels } from '../homeLogic.ts';
import { emptyGroupText, type PickerRow } from '../homeMenuLogic.ts';
import { showPhoneBadge } from '../pairingLogic.ts';
import { LiveInfo } from './LiveInfo.tsx';
import { GRID_Y, INFO_W, INFO_X, LIVE_PREVIEW_RECT, PHONE_BADGE_POS, liveKey, liveOkAction, type LiveKey, type LivePlace } from './liveLogic.ts';
import { createLivePreview } from './livePreview.ts';
import { LiveVideo } from './LiveVideo.tsx';

/** A focus that rests this long on a channel asks the worker for its now/next. It never plays. */
const FOCUS_REST_MS = 700;
const PICKER_ID = 'liveGroups';
const GROUP_ALL = 'all';
const ROW_BUFFER = 2;
const NO_LIVE_TEXT = 'This source has no live channels. Movies and series are in the menu on the left.';

type Progress = Extract<AppEvent, { type: 'progress' }>;
type LayoutChanged = Extract<AppEvent, { type: 'layoutChanged' }>;
type SourcesChanged = Extract<AppEvent, { type: 'sourcesChanged' }>;

/**
 * Position across Live TV visits (the Player, catch-up, Search and the VOD screens re-create the screen): the group,
 * the focused channel and row, and the focused time.
 */
const memory: { groupId?: string; channelId?: string; row?: number; anchor?: number; viewStart?: number } = {};

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
  /** The guide's time window. Task 4 widens it by the source's catch-up days (`guideBackMs`). */
  const win = guideWindow(opened);
  // A channel and time to open at (Search's "later" rows, once the guide route is gone).
  const target = guideOpenTarget(params, opened, win);
  // One-shot hint from the Player (the channel it showed last).
  const focusHint = params.focusChannelId;
  // One-shot from Back (or Live TV on the rail) on Start, Movies or Series: the stopped channel resumes and focus lands
  // on it in the grid (you return to what you were watching).
  const fromVod = returnedToLive(params);
  delete params.focusChannelId;
  delete params.fromVod;
  delete params.channelId;
  delete params.groupId;
  delete params.at;

  // A plain return (Settings, Search, catch-up) keeps the remembered time; a return to the playing channel shows now.
  const keepTime = target.channelId === undefined && focusHint === undefined && !fromVod && memory.viewStart !== undefined;
  const startView = keepTime ? clampViewStart(memory.viewStart!, win) : target.viewStart;
  const startAnchor = keepTime
    ? Math.max(startView, Math.min(startView + VIEW_SPAN - 1, memory.anchor ?? opened)) : target.anchor;

  const [now, setNow] = createSignal(opened);
  const [groups, setGroups] = createSignal<GroupInfo[]>([]);
  const [groupId, setGroupId] = createSignal<string | undefined>(undefined);
  const [version, setVersion] = createSignal(0);
  const [row, setRow] = createSignal(0);
  const [viewStart, setViewStart] = createSignal(startView);
  const [anchor, setAnchor] = createSignal(startAnchor);
  const [place, setPlace] = createSignal<LivePlace>('grid');
  const [picking, setPicking] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
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

  const cache = new EpgCache<ChannelRow, ProgrammeLite>(
    (g, o, c, f, t) => api.getEpgRows(g, o, c, f, t),
    { rowsPerPage: 20, chunkMs: 3 * HOUR, maxEntries: 24, maxAgeMs: 15 * MINUTE, onChange: () => setVersion((v) => v + 1) },
  );

  const viewRows = () => (pointerMode() ? EPG_POINTER_ROWS : EPG_VIEW_ROWS);
  const total = () => { version(); return cache.total() ?? 0; };
  /** Channels in the group: its count is known before the first rows arrive (and while a reload emptied the cache). */
  const groupCount = () => total() || (groups().find((g) => g.id === groupId())?.count ?? 0);
  const channelAt = (i: number) => { version(); return cache.channel(i); };
  const blocksAt = (i: number): Block[] => {
    version();
    const covered = cache.covered(i)
      .map((r) => ({ start: Math.max(r.start, win.start), end: Math.min(r.end, win.end) }))
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

  // ---- loading: the visible 2 h first, then the prefetch either side ----

  createEffect(() => {
    const g = groupId();
    if (g === undefined) return;
    kick();
    const r = renderRange(top(), viewRows(), Math.max(total(), 1), ROW_BUFFER);
    const vs = viewStart();
    const wide = prefetchRange(vs, win);
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
  const shown = dwellSignal(() => {
    const channel = focusChannel();
    return channel ? { channel, block: place() === 'channels' ? undefined : focusBlock() } : undefined;
  });

  // ---- focus ----

  const ctx = () => ({ row: row(), total: groupCount(), hasGroups: groups().length > 0 });
  const focusPlace = (p: LivePlace) => {
    setPlace(p);
    (p === 'rail' ? railNode : p === 'groups' ? headerNode : gridNode)?.setFocus();
    return true;
  };
  /** Where focus lands when it enters the content: the grid with channels, else the dropdown, else the rail. */
  const contentPlace = (): LivePlace => {
    const r = liveKey('rail', 'right', ctx());
    return r === 'move' || r === 'exit' ? 'grid' : r;
  };
  /** Routes a key through `liveKey`: `move` runs the place's own handler; `exit` lets Back bubble to the shell. */
  const go = (key: LiveKey, move: () => boolean = () => true): boolean => {
    const r = liveKey(place(), key, ctx());
    if (r === 'move') return move();
    if (r === 'exit') return false;
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
   * The group and row to open: `prefer` (else All, else the first group) at the first of `ids` it holds, else the
   * remembered row. A wanted channel outside a narrower group switches to All (number entry, Search). `superseded`
   * when another group was opened meanwhile.
   */
  const locate = async (gs: GroupInfo[], prefer: string | undefined, ids: readonly (string | undefined)[]):
    Promise<{ g: string | undefined; index: number } | 'superseded'> => {
    const seq = groupSeq;
    let g = pickGroup(gs, prefer);
    if (g === undefined) return { g, index: 0 };
    const indexIn = (grp: string) => (id: string) => api.indexOf(grp, id).catch(() => -1);
    const wanted = ids.find((id) => id !== undefined);
    if (wanted !== undefined && g !== GROUP_ALL && gs.some((x) => x.id === GROUP_ALL) && await indexIn(g)(wanted) < 0) g = GROUP_ALL;
    const hit = await resolveFocus(ids, indexIn(g));
    if (seq !== groupSeq) return 'superseded';
    const count = gs.find((x) => x.id === g)?.count ?? 0;
    return { g, index: restoreIndex(hit.index, g === memory.groupId ? memory.row : undefined, count) };
  };

  /** Re-reads the groups and the guide (refresh, a remote change), keeping focus on the same channel. */
  let reloadSeq = 0;
  const reload = async (): Promise<GroupInfo[] | undefined> => {
    const seq = ++reloadSeq;
    const keepId = focusedId() ?? memory.channelId;
    const before = groupId();
    const gs = await api.getGroups();
    if (!alive || seq !== reloadSeq) return undefined;
    setGroups(gs);
    cache.invalidate();
    if (before !== undefined && gs.some((x) => x.id === before)) {
      // Same group: the channel's new row; one that left the group (hidden, removed) hands its row to the neighbour.
      const gSeq = groupSeq;
      const index = keepId === undefined ? -1 : await api.indexOf(before, keepId).catch(() => -1);
      if (!alive || seq !== reloadSeq || gSeq !== groupSeq) return gs;
      const count = gs.find((x) => x.id === before)?.count ?? 0;
      setFocusRow(index >= 0 ? index : Math.max(0, Math.min(row(), count - 1)));
      return gs;
    }
    // The group disappeared: All channels (or the first group), at the same channel when it is there.
    const located = await locate(gs, undefined, [keepId]);
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
      const playingId = playback.current()?.id;
      if (playingId !== undefined) {
        void api.indexOf(r.id, playingId).catch(() => -1).then((i) => {
          if (alive && seq === groupSeq && i >= 0) setFocusRow(i);
        });
      }
    }
    queueMicrotask(() => { if (alive) focusPlace(contentPlace()); });
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
  const ok = () => {
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
      playingId: playback.current()?.id,
      requestedId: preview.requested(),
    });
    memory.channelId = ch.id;
    if (action === 'preview') preview.playHere(ch.id, g);
    else if (action === 'fullscreen') preview.openFullscreen(ch.id, g);
    else if (action === 'details') setExpanded((v) => !v);
    // 'catchup': Task 4 opens the catch-up player here (Guide's openCatchup).
    return true;
  };

  /** Menu / long OK: the merged programme + channel menu arrives in Task 4. Until then Menu does nothing here. */
  const openMenu = () => true;

  const gridKeys = {
    onUp: () => go('up', () => setFocusRow(moveFocus(row(), -1, total()))),
    onDown: () => go('down', () => setFocusRow(moveFocus(row(), 1, total()))),
    onLeft: () => go('left', () => {
      const s = stepLeft(rowBlocks(), focusIndex(), view(), win);
      if (s.kind === 'edge') setPlace('channels');
      else applyStep(s);
      return true;
    }),
    onRight: () => go('right', () => {
      applyStep(stepRight(rowBlocks(), focusIndex(), view(), win));
      return true;
    }),
    onPage: (dir: 1 | -1) => setFocusRow(pageFocus(row(), dir, viewRows(), total())),
    onOk: ok,
    onMenu: openMenu,
    onLongOk: openMenu,
  };

  // A focus that rests for FOCUS_REST_MS tells the worker, which may look up that channel's now/next (short EPG, only
  // for channels without a stored guide). It never plays anything.
  let restReported = false;
  const focusRest = createDebounce<string>(FOCUS_REST_MS, (id) => {
    if (!alive || focusedId() !== id || !onGrid()) return;
    restReported = true;
    void api.focusChannel(id).catch(() => undefined);
  });
  createEffect(on([focusedId, onGrid, ready, picking], ([id, grid, isReady, isPicking]) => {
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

  onMount(() => {
    playback.setRect(LIVE_PREVIEW_RECT);
    // Back from Movies or Series: the channel they stopped counts as the playing one (focus and resume).
    const playingId = playback.current()?.id
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
    const allCount = (gs: readonly GroupInfo[]) => gs.find((x) => x.id === GROUP_ALL)?.count ?? 0;
    const offs = [
      onEvent('progress', (p) => setProgress(p as Progress)),
      onEvent('refreshed', () => {
        setWaiting(false);
        void reload().catch(() => undefined);
      }),
      // A companion changed the layout: re-read, keeping focus by id. Changes made on this screen re-read on their own.
      onEvent('layoutChanged', (e) => {
        if ((e as LayoutChanged).origin !== 'remote') return;
        void reload().catch(() => undefined);
      }),
      // A companion switched, added or deleted a source: drop the picker of the old source and re-read.
      onEvent('sourcesChanged', (e) => {
        if ((e as SourcesChanged).origin !== 'remote') return;
        dismissPicker();
        void reload().then((gs) => { if (alive && gs) setWaiting(allCount(gs) === 0); }).catch(() => undefined);
      }),
      onEvent('refreshFailed', () => setWaiting(false)),
      // Background short-EPG answers (the focused or playing channel): re-read the pages of those rows on screen.
      onEvent('nowNextUpdated', (e) => {
        const ids = new Set((e as { channelIds: string[] }).channelIds);
        const r = renderRange(top(), viewRows(), total(), ROW_BUFFER);
        let stale = false;
        for (let i = r.from; i < r.to; i++) {
          const id = cache.channel(i)?.id;
          if (id !== undefined && ids.has(id)) {
            cache.stalePage(i);
            stale = true;
          }
        }
        if (stale) setKick((k) => k + 1);
      }),
    ];
    onCleanup(() => {
      clearTimeout(first);
      stopMinute?.();
      stopTick();
      for (const off of offs) off();
    });

    void (async () => {
      try {
        const gs = await api.getGroups();
        if (!alive) return;
        setGroups(gs);
        // An empty cache on first start: the channels arrive with a later `refreshed` event.
        if (waitsForChannels(allCount(gs), initState()?.hasVod)) setWaiting(true);
        // Focus order: a requested channel, the Player's last channel, the playing one, the remembered one, init's last.
        const located = await locate(gs, target.groupId ?? memory.groupId ?? params.lastGroupId,
          [target.channelId, focusHint, playingId, memory.channelId, params.lastChannelId]);
        if (!alive || located === 'superseded') return;
        if (located.g !== undefined) openGroup(located.g, located.index);
      } catch (err) {
        console.warn('Live TV load failed', err instanceof Error ? err.name : 'Error');
      } finally {
        if (alive) {
          setReady(true);
          // The grid when it has channels, else the dropdown, else the rail (a source without live channels).
          if (router.topOverlay() === undefined) focusPlace(contentPlace());
        }
      }
    })();
  });

  onCleanup(() => {
    alive = false;
    focusRest.cancel();
    void api.focusChannel(undefined).catch(() => undefined); // no focused row once Live TV is gone
    playback.begin(); // drops any preview request still in flight
    removePicker?.();
    router.removeOverlay(PICKER_ID);
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    return go('back');
  };

  /** The info block's place while the group has no channels (Task 5 refines the empty states and their focus). */
  const emptyText = () => {
    if (waiting()) {
      const p = progress();
      return p ? `Loading channels… ${p.count}` : 'Loading channels…';
    }
    const g = groupId();
    return g === undefined || g === GROUP_ALL ? NO_LIVE_TEXT : emptyGroupText(g);
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}
      forwardFocus={() => { focusPlace(place()); return true; }}
      onYellow={() => { router.push('search'); return true; }}
      onBlue={() => { router.push('settings'); return true; }}>
      <LiveVideo now={now()} pausedNote={preview.pausedNote()}
        onRetry={() => { void preview.retryHere(playback.current() ? undefined : focusedId()); }} />
      <Rail ref={(el) => { railNode = el; }} active="live" onSelect={railSelect}
        onRight={() => go('right')} onFocusChanged={(f) => { if (f) setPlace('rail'); }} />

      <Show when={ready() && groupCount() === 0} fallback={
        <LiveInfo block={shown()?.block} channel={shown()?.channel} now={now()} expanded={expanded()} />
      }>
        <Text x={INFO_X} y={LAYOUT.safeY + 36} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={3}
          fontSize={TYPE.body} color={COLORS.muted}>{emptyText()}</Text>
      </Show>

      <EpgGrid ref={(el) => { gridNode = el; }} x={EPG_GRID_X} y={GRID_Y} total={total()} top={top()} rows={viewRows()}
        focusRow={row()} focusStart={focusBlock()?.start} area={place() === 'channels' ? 'channels' : 'grid'}
        viewStart={viewStart()} now={now()} playingId={playback.current()?.id} dayLabel=""
        channel={channelAt} blocks={blocksAt} {...gridKeys} />
      {/* In the ruler's channel column; after the grid, so it draws (and takes the pointer) on top of the ruler. */}
      <Show when={groups().length > 0}>
        <DropdownHeader ref={(el) => { headerNode = el; onCleanup(() => { if (headerNode === el) headerNode = undefined; }); }}
          x={EPG_GRID_X + DROPDOWN_PAD_X} y={GRID_Y} height={RULER_H} size={TYPE.meta} maxWidth={CHANNEL_W - 4}
          label={groupName()} onPress={openPicker}
          onDown={() => go('down')} onLeft={() => go('left')} onRight={() => go('right')}
          onFocusChanged={(f) => { if (f) setPlace('groups'); }} />
      </Show>

      <Show when={showPhoneBadge(companionStatus())}><PhoneBadge /></Show>

      <Show when={picking()}>
        <ListPicker ref={(el) => { pickerNode = el; }} title="Groups" rows={pickerRows()} onPick={pick}
          hint="Ok picks · Back closes" />
      </Show>
    </View>
  );
}
