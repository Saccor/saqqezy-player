/**
 * What OK, a click and the menu do on Live TV's grid: preview, full screen, details, catch-up from the archive, the
 * menu (programme items, then the channel's) and the source's catch-up days that widen the guide back in time. Not
 * unit-tested: the pure rules live in liveLogic.ts and catchupLogic.ts.
 */
import { batch, createEffect, createMemo, onCleanup } from 'solid-js';
import type { ArchiveState, ChannelRow } from '@iptv/app-api';
import { archiveState as archiveStateOf, type GroupInfo } from '@iptv/core';
import { api } from '../../api.ts';
import { cooling } from '../../playback/cooldown.ts';
import { deviceWindowMax, playback } from '../../playback/playback.ts';
import { router } from '../../shell/router.ts';
import { initState, settings } from '../../state/appState.ts';
import { missingArchive } from '../../vod/catchupLogic.ts';
import { deviceCeiling, windowLimit } from '../multiview/windows.ts';
import { multiviewOffered } from '../playerLogic.ts';
import { VIEW_SPAN, clampViewStart, dayJumpTargets, dayJumpView, guideBackMs, guideWindow, isOnAir, type Block } from '../guideLogic.ts';
import { liveOkAction, type LivePlace } from './liveLogic.ts';
import { createCatchupOpener } from './liveCatchup.ts';
import { createLiveMenu } from './liveMenu.tsx';
import { memory } from './liveMemory.ts';
import type { createLivePreview } from './livePreview.ts';
import { GROUP_ALL, type LiveState } from './liveState.ts';

export function createLiveActions(s: LiveState, d: {
  alive: () => boolean;
  preview: ReturnType<typeof createLivePreview>;
  focusPlace: (p: LivePlace, auto?: boolean) => boolean;
  /** Where focus lands when it enters the content (`contentPlace` in LiveTv). */
  contentPlace: () => LivePlace;
  /** Re-reads the groups and the guide, keeping the focus on `keepId` while it is in the group. */
  reload: (keepId?: string) => Promise<GroupInfo[] | undefined>;
}) {
  const { alive, preview, focusPlace } = d;
  const { groups, groupId, place, focusBlock, focusChannel, now, win } = s;

  /** The archive state of a block, with the in-memory "not available" marks. */
  const stateOf = (ch: ChannelRow, b: Block): ArchiveState => {
    if (b.filler || missingArchive.has(ch.id, b.start, Date.now())) return 'none';
    return archiveStateOf(ch.archiveDays, b, now(), b.archive);
  };

  /** Right before the catch-up player opens: the return focuses the remembered row and time (see `fromCatchup`). */
  const openCatchup = createCatchupOpener(alive, () => { memory.fromCatchup = true; });

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
    else if (action === 'details') s.setExpanded((v) => !v);
    else if (action === 'catchup' && b) openCatchup(ch, b);
    return true;
  };

  // ---- catch-up ----

  /** The archive mark of a cell: `past` the archive can play, `onAir` can play from its start. */
  const archiveMark = (i: number, b: Block): 'past' | 'onAir' | undefined => {
    const ch = s.channelAt(i);
    const st = ch ? stateOf(ch, b) : 'none';
    return st === 'available' ? 'past' : st === 'onAir' ? 'onAir' : undefined;
  };

  /** The source's catch-up days arrived: the window reaches that far back; the view keeps its place inside it. */
  const applyCatchupDays = (days: number) => {
    memory.sourceId = initState()?.activeSourceId;
    memory.catchupDays = days;
    const w = guideWindow(s.opened, guideBackMs(days));
    batch(() => {
      s.setCatchupDays(days);
      if (w.start === win().start) return;
      s.setWin(w);
      const vs = clampViewStart(s.viewStart(), w);
      s.setViewStart(vs);
      s.setAnchor(Math.max(vs, Math.min(vs + VIEW_SPAN - 1, s.anchor())));
    });
  };
  const loadCatchupDays = () => api.catchupDays().catch(() => 0).then((days) => { if (alive()) applyCatchupDays(days); });

  // Focus resting 600 ms on a past time of a catch-up row: ask the source for that row's own archive listings (Xtream).
  // Keyed on the id: arriving pages rebuild the row object and must not restart the wait.
  const refineId = createMemo(() => {
    const ch = focusChannel();
    return ch && ch.archiveDays !== undefined && s.anchor() < now() ? ch.id : undefined;
  });
  createEffect(() => {
    const id = refineId();
    if (id === undefined) return;
    const timer = setTimeout(() => { api.refineArchive(id).catch(() => undefined); }, 600);
    onCleanup(() => clearTimeout(timer));
  });

  // ---- the menu (programme items, then the channel's) ----

  const liveMenu = createLiveMenu({
    alive,
    groups,
    groupId,
    stopPreview: preview.stopPreview,
    reload: async (id) => {
      const gs = await d.reload(id);
      // The change emptied the group (its last channel hidden or removed): focus moves to the dropdown.
      if (!alive() || !gs || liveMenu.isOpen() || !s.onGrid() || (gs.find((g) => g.id === groupId())?.count ?? 0) > 0) return;
      focusPlace(groups().length > 0 ? 'groups' : 'rail', true);
    },
    // No layer left: back to the grid or the channel cell; a group the change emptied hands focus on (`contentPlace`).
    refocus: () => { focusPlace(s.groupCount() > 0 && s.onGrid() ? place() : d.contentPlace(), true); },
    dayTargets: () => dayJumpTargets(Date.now(), win()),
    goToDay: (at) => {
      const v = dayJumpView(at, Date.now(), win());
      batch(() => {
        s.setViewStart(v.viewStart);
        s.setAnchor(v.anchor);
        s.setExpanded(false);
      });
      if (s.groupCount() > 0) focusPlace('grid');
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
    if (router.topOverlay() !== undefined || !s.onGrid()) return true;
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
    liveMenu.openMenu(ch, { watch, preview: toPreview, fromStart, goToDay: s.catchupDays() > 0 });
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

  return { liveMenu, play, archiveMark, openMenu, ok, loadCatchupDays };
}
