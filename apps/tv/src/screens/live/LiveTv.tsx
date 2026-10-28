import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { batch, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { DropdownHeader, HeaderIconButton } from '../../components/DropdownHeader.tsx';
import { PAD_X as DROPDOWN_PAD_X, dropdownWidth } from '../../components/dropdownLogic.ts';
import { CHANNEL_W, EPG_GRID_X, EpgGrid, RULER_H } from '../../components/EpgGrid.tsx';
import { PointerBar } from '../../components/PointerBar.tsx';
import { moveFocus, pageFocus } from '../../components/virtualWindow.ts';
import { createDebounce } from '../../playback/debounce.ts';
import { devResume } from '../../playback/devResume.ts';
import { playback, previewHold } from '../../playback/playback.ts';
import { dwellSignal } from '../../shell/dwell.ts';
import { focusRailCollapsed, Rail } from '../../shell/Rail.tsx';
import type { RailId } from '../../shell/railLogic.ts';
import { useNotice } from '../../components/Notice.tsx';
import { SHELL_COPY } from '../../copy.ts';
import { goRail } from '../../shell/railNav.ts';
import { BOTTOM_ROW_H, BOTTOM_ROW_Y, SCREEN_ROW_X } from '../../shell/logic.ts';
import { router, type ScreenEntry } from '../../shell/router.ts';
import { COLORS, LAYOUT, SPACE, TYPE } from '../../shell/theme.ts';
import { visibleInterval } from '../../shell/visibleInterval.ts';
import { companionStatus, initState } from '../../state/appState.ts';
import { liveReturn } from '../../vod/liveReturn.ts';
import {
  MINUTE, NO_INFO, blockIndexAt, isOnAir, leftFromGrid, nowView, pageTime, stepLeft, stepRight, type HStep,
} from '../guideLogic.ts';
import { progressOf, resumeTarget, videoClickGroup, vodReturnTarget } from '../homeLogic.ts';
import { showPhoneBadge } from '../pairingLogic.ts';
import { InfoBlock } from '../../components/InfoBlock.tsx';
import {
  GRID_Y, INFO_W, INFO_X, LIVE_PREVIEW_RECT, infoTimeLine, liveChannelLine, liveEmptyText, liveKey, livePlaceOnOpen,
  liveProgramme, sameInfo, timeLeftLabel, type LiveKey, type LivePlace,
} from './liveLogic.ts';
import { createLiveActions } from './liveActions.ts';
import { createGroupPicker } from './liveGroupPicker.tsx';
import { createLiveGroups } from './liveGroups.ts';
import { listenLiveEvents } from './liveEvents.ts';
import { leaveWarm, memory } from './liveMemory.ts';
import { createLivePointer, useTypeToSearch } from './livePointer.ts';
import { createLivePreview } from './livePreview.ts';
import { GROUP_ALL, createLiveState } from './liveState.ts';
import { LiveVideo } from './LiveVideo.tsx';

/** A focus that rests this long on a channel asks the worker for its now/next. It never plays. */
const FOCUS_REST_MS = 700;
/** The folder search button right of the group dropdown, in the ruler's channel column. */
const GROUP_SEARCH_GAP = 8;
const GROUP_HEADER_MAX_W = CHANNEL_W - 4 - RULER_H - GROUP_SEARCH_GAP;

/** The first Live TV mount of this page has decided whether to resume init's last channel (see `resumeTarget`). */
let startupResumed = false;

/**
 * Live TV (UI revamp phase 2): one guide. A mini preview (top left) with the focused programme beside it, and a
 * full-width EPG grid below: 11 rows x 2 h, the group dropdown in the ruler's channel column. Rows come from
 * `getEpgRows` through one bounded `EpgCache` (the visible 2 h first, then the prefetch). Only OK plays: a channel
 * airing now previews in the mini window; OK again on it goes fullscreen. The state and the guide rows live in
 * `liveState.ts`, the groups in `liveGroups.ts` and `liveGroupPicker.tsx`, OK and the menu in `liveActions.ts`; this
 * component owns the focus, the keys, the lifecycle and the drawing.
 */
export function LiveTvScreen(props: { entry: ScreenEntry }) {
  useNotice(() => (showPhoneBadge(companionStatus()) ? { id: 'phone', kind: 'wait', text: SHELL_COPY.phone } : undefined));
  let alive = true;
  const s = createLiveState(props.entry, () => alive);
  const {
    params, target, fromVod, fromCatchup, hasTarget, cache, win, now, groups, groupId, row, viewStart, anchor,
    place, setPlace, ready, waiting, groupsFailed, viewRows, total, groupCount, channelAt, blocksAt, top, rowBlocks, focusIndex,
    focusBlock, focusChannel, focusedId, onGrid, noLive, setFocusRow,
  } = s;

  let railNode: ElementNode | undefined;
  let headerNode: ElementNode | undefined;
  let groupSearchNode: ElementNode | undefined;
  let gridNode: ElementNode | undefined;
  /** False while the screen shows a group only for a channel target (Search): that must not replace the remembered one. */
  let rememberGroup = target.rememberGroup;

  const preview = createLivePreview(() => alive);
  // Playback was stopped on purpose (sleep timer): no resume on mount.
  const held = previewHold.take();
  // The live channel a Movies or Series tab (or a title opened from Search) stopped: taken by every mount, resumed only
  // on Back from that tab (or on the return from Search) and only for the source it came from.
  const vodReturn = liveReturn.take(initState()?.activeSourceId);

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
  /** The focused programme block's values (the programme, its time line, on-air progress). */
  const liveProg = () => liveProgramme(shown()?.block, shown()?.channel);
  const onAir = () => { const p = liveProg(); return p !== undefined && isOnAir(p, now()); };
  const onAirProgress = () => (onAir() ? progressOf(liveProg(), now()) : undefined);

  // ---- focus ----

  const ctx = () => ({ row: row(), total: groupCount(), hasGroups: groups().length > 0 });
  /** `auto`: focus the screen moves by itself (no key), which keeps the rail collapsed. */
  const focusPlace = (p: LivePlace, auto = false) => {
    setPlace(p);
    if (p === 'rail' && auto) focusRailCollapsed(railNode);
    else (p === 'rail' ? railNode : p === 'groups' ? headerNode : p === 'groupSearch' ? groupSearchNode : gridNode)?.setFocus();
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
    return p === 'channels' ? livePlaceOnOpen({ hasTarget, fromCatchup }) : p;
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

  const applyStep = (st: HStep) => {
    if (st.kind !== 'move' && st.kind !== 'scroll') return;
    batch(() => {
      s.setViewStart(st.viewStart);
      s.setAnchor(st.anchor);
      s.setExpanded(false);
    });
  };
  const view = () => ({ viewStart: viewStart(), anchor: anchor() });
  const resetToNow = () => applyStep({ kind: 'move', index: 0, ...nowView(Date.now(), win()) });

  // ---- groups ----

  const liveGroups = createLiveGroups(s, () => alive);
  const { openGroup, reload } = liveGroups;
  /** A group picked in the Groups sheet: it opens at the playing channel, else row 0, and the grid takes the focus. */
  const chooseGroup = (id: string) => {
    if (id !== groupId()) {
      rememberGroup = true;
      openGroup(id, 0);
      const seq = liveGroups.seq();
      const playingId = playback.currentRowId();
      if (playingId !== undefined) {
        void api.indexOf(id, playingId).catch(() => -1).then((i) => {
          if (alive && seq === liveGroups.seq() && i >= 0) setFocusRow(i);
        });
      }
    }
    queueMicrotask(() => { if (alive) focusPlace(contentPlace(), true); });
  };
  const picker = createGroupPicker({ alive: () => alive, groups, groupId, focusPlace: (p) => { focusPlace(p); }, chooseGroup });

  // ---- OK, catch-up and the menu ----

  const actions = createLiveActions(s, { alive: () => alive, preview, focusPlace, contentPlace, reload });
  const { liveMenu, play, openMenu } = actions;

  const gridKeys = {
    onUp: () => go('up', () => setFocusRow(moveFocus(row(), -1, total()))),
    onDown: () => go('down', () => setFocusRow(moveFocus(row(), 1, total()))),
    onLeft: () => go('left', () => {
      const st = leftFromGrid(rowBlocks(), focusIndex(), view(), win(), Date.now());
      if (st.kind === 'channels') { resetToNow(); return focusPlace('channels'); }
      if (st.kind === 'edge') setPlace('channels');
      else applyStep(st);
      return true;
    }),
    onRight: () => go('right', () => {
      applyStep(stepRight(rowBlocks(), focusIndex(), view(), win()));
      return true;
    }),
    onPage: (dir: 1 | -1) => setFocusRow(pageFocus(row(), dir, viewRows(), total())),
    onOk: actions.ok,
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
    focusTime: (t) => batch(() => { s.setAnchor(t); s.setExpanded(false); }),
    stepTime: (dir) => {
      const st = dir > 0 ? stepRight(rowBlocks(), focusIndex(), view(), win()) : stepLeft(rowBlocks(), focusIndex(), view(), win());
      if (st.kind !== 'edge') applyStep(st);
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
  const layerOpen = () => picker.picking() || liveMenu.isOpen();
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
   * group the empty state parked focus above (`hadChannels` false) got channels: the channel column. Never under a layer.
   */
  const settleFocus = (hadChannels: boolean) => {
    if (!alive || !ready() || router.topOverlay() !== undefined || layerOpen()) return;
    if (noLive()) {
      if (place() !== 'rail') focusPlace('rail', true);
      return;
    }
    if (onGrid() && groupCount() === 0) focusPlace(contentPlace(), true);
    else if (!hadChannels && place() === 'groups' && groupCount() > 0) focusPlace('channels');
  };

  onMount(() => {
    playback.setRect(LIVE_PREVIEW_RECT);
    void actions.loadCatchupDays(); // in parallel with the groups: it only widens the window back in time
    // Back from Movies or Series: the channel they stopped counts as the playing one (focus and resume).
    const playingId = playback.currentRowId()
      ?? vodReturnTarget({ fromVod, fromSearch: vodReturn?.fromSearch, returnId: vodReturn?.id, held, gatePaused: devResume.paused() });
    startResume(playingId);

    // Aligned to the minute boundary, so the clock labels and the now line change on the minute.
    let stopMinute: (() => void) | undefined;
    const first = setTimeout(() => {
      s.setNow(Date.now());
      stopMinute = visibleInterval(() => s.setNow(Date.now()), MINUTE); // sleeps while the page is hidden
    }, MINUTE - (Date.now() % MINUTE));
    // 30 s tick: the cooldown countdown, and expired guide pages are fetched again.
    const stopTick = visibleInterval(() => {
      s.setNow(Date.now());
      s.setKick((k) => k + 1);
    }, 30_000);
    const offs = listenLiveEvents(s, { alive: () => alive, reload, settleFocus, liveMenu, picker, loadCatchupDays: actions.loadCatchupDays });
    onCleanup(() => {
      clearTimeout(first);
      stopMinute?.();
      stopTick();
      for (const off of offs) off();
    });

    void liveGroups.firstLoad(0, playingId, (attempt) => {
      if (alive && attempt === 0) {
        s.setReady(true);
        // The grid when it has channels, else the dropdown (an empty group), else the rail (no live channels).
        if (router.topOverlay() === undefined) focusPlace(openPlace(), true);
      } else if (alive && !groupsFailed()) {
        settleFocus(false);
      }
    });
  });

  onCleanup(() => {
    alive = false;
    leaveWarm(cache);
    liveGroups.dispose();
    focusRest.cancel();
    void api.focusChannel(undefined).catch(() => undefined); // no focused row once Live TV is gone
    playback.begin(); // drops any preview request still in flight
    picker.cleanup();
    liveMenu.cleanup();
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    return go('back');
  };

  /** The info block's place while the group has no channels: the first load, no live channels, or an empty group. */
  const emptyText = () => liveEmptyText({
    waiting: waiting(), failed: groupsFailed(), progressCount: s.progress()?.count, allCount: s.allCount(), groupId: groupId(),
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
        <InfoBlock x={INFO_X} y={LAYOUT.safeY} width={INFO_W} overline={liveChannelLine(shown()?.channel)}
          title={liveProg()?.title ?? NO_INFO}
          meta={liveProg() ? infoTimeLine(liveProg()!.start, liveProg()!.stop, now()) : undefined}
          progress={onAirProgress()} trailing={onAir() ? timeLeftLabel(liveProg()!.stop, now()) : undefined}
          description={liveProg()?.desc} descriptionLines={s.expanded() ? 3 : 1} />
      }>
        <Text x={INFO_X} y={LAYOUT.safeY + SPACE.l} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={3}
          fontSize={TYPE.body} color={COLORS.muted}>{emptyText()}</Text>
      </Show>

      <EpgGrid ref={(el) => { gridNode = el; }} x={EPG_GRID_X} y={GRID_Y} total={total()} top={top()} rows={viewRows()}
        focusRow={row()} focusStart={focusBlock()?.start} area={place() === 'channels' ? 'channels' : 'grid'}
        viewStart={viewStart()} now={now()} playingId={playback.currentRowId()}
        channel={channelAt} blocks={blocksAt} archiveMark={actions.archiveMark} {...gridKeys}
        onCellClick={pointer.onCellClick} onCellContextMenu={pointer.onCellMenu} onPointerWheel={pointer.onWheel}
        pointerEnabled={pointerOn()} />
      {/* In the ruler's channel column; after the grid, so it draws (and takes the pointer) on top of the ruler. */}
      <Show when={groups().length > 0}>
        <DropdownHeader ref={(el) => { headerNode = el; onCleanup(() => { if (headerNode === el) headerNode = undefined; }); }}
          x={EPG_GRID_X + DROPDOWN_PAD_X} y={GRID_Y} height={RULER_H} size={TYPE.meta} maxWidth={GROUP_HEADER_MAX_W}
          label={s.groupName()} onPress={() => picker.openPicker()} pointerEnabled={pointerOn()}
          onDown={() => go('down')} onLeft={() => go('left')} onRight={() => go('right')}
          onFocusChanged={(f) => { if (f) setPlace('groups'); }} />
        <HeaderIconButton ref={(el) => { groupSearchNode = el; onCleanup(() => { if (groupSearchNode === el) groupSearchNode = undefined; }); }}
          x={EPG_GRID_X + Math.min(dropdownWidth(s.groupName(), TYPE.meta), GROUP_HEADER_MAX_W) + GROUP_SEARCH_GAP} y={GRID_Y}
          size={RULER_H} icon="search" pointerEnabled={pointerOn()} onPress={() => picker.openPicker(true)}
          onDown={() => go('down')} onLeft={() => go('left')} onRight={() => go('right')} onUp={() => go('up')}
          onFocusChanged={(f) => { if (f) setPlace('groupSearch'); }} />
      </Show>


      {/* Pointer mode only: the bottom row, after the shell's Back; the grid shows `EPG_POINTER_ROWS` above it. */}
      <PointerBar x={SCREEN_ROW_X} y={BOTTOM_ROW_Y} height={BOTTOM_ROW_H} items={pointer.bar} enabled={pointerOn()} />

      <picker.View />
      <liveMenu.View />
    </View>
  );
}
