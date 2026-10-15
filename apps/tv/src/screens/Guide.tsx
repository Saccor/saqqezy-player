import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { ChannelRow, ProgrammeLite } from '@iptv/app-api';
import type { GroupInfo } from '@iptv/core';
import type { Rect } from '@iptv/player';
import { api, onEvent } from '../api.ts';
import { EPG_GRID_W, EPG_ROW_H, EPG_VIEW_ROWS, EpgGrid, RULER_H } from '../components/EpgGrid.tsx';
import { PointerBar } from '../components/PointerBar.tsx';
import { GroupList } from '../components/GroupList.tsx';
import { moveFocus, pageFocus, renderRange, scrollTopFor } from '../components/virtualWindow.ts';
import { pointerMode, usePointerBackdrop, usePointerTarget } from '../input/pointer.ts';
import type { GridHit } from '../input/pointerLogic.ts';
import { playback } from '../playback/playback.ts';
import { BOTTOM_ROW_H, BOTTOM_ROW_Y, SCREEN_ROW_X } from '../shell/logic.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { WORDMARK_BOTTOM, WORDMARK_RIGHT } from '../shell/Wordmark.tsx';
import { EpgCache } from './epgCache.ts';
import {
  GUIDE_POINTER_LABELS, HOUR, MINUTE, blockIndexAt, buildBlocks, dayLabel, guideClick, guideOpenTarget, guideWindow, isOnAir, pageTime,
  prefetchRange, relativeLabel, stepLeft, stepRight, type Block, type HStep,
} from './guideLogic.ts';
import { formatRange, pickGroup, previewMessage } from './homeLogic.ts';

const MINI: Rect = { x: LAYOUT.safeX, y: LAYOUT.safeY, w: 480, h: 270 };
const INFO_X = MINI.x + MINI.w + LAYOUT.gap * 2;
/** Leaves room for the shell clock in the top-right corner. */
const INFO_W = LAYOUT.width - LAYOUT.safeX - INFO_X - 160;
/**
 * The brand wordmark sits in the top centre of the info area. The short context and time lines go beside it
 * (`SIDE_X`, relative to the info block); the title and description use the full width below it, so the
 * expanded 4-line description still ends above the grid.
 */
const SIDE_X = WORDMARK_RIGHT - INFO_X;
const SIDE_W = INFO_W - SIDE_X;
const TITLE_TOP = WORDMARK_BOTTOM + 4 - MINI.y;
const GRID_Y = MINI.y + MINI.h + LAYOUT.gap;
const HINT_Y = LAYOUT.height - LAYOUT.safeY - 30;
const PICKER_ID = 'guideGroups';
const PICKER_W = 460;
const GROUP_ALL = 'all';
const ROW_BUFFER = 2;

/** The group the guide showed last (kept across visits). */
const memory: { groupId?: string } = {};

/**
 * TV guide: a mini video window (the shared `playback`, never restarted here), the focused programme's details,
 * and the EPG grid. Rows come from `getEpgRows` through a bounded, expiring `EpgCache` (pages of 20 channels x
 * 3-hour chunks, the visible 3 h first, then 3 h either side). Times are already shifted by the API.
 */
export function GuideScreen(props: { entry: ScreenEntry }) {
  const opened = Date.now();
  const win = guideWindow(opened);
  const target = guideOpenTarget(props.entry.params, opened, win);
  const wantedGroup = target.groupId;

  const [now, setNow] = createSignal(opened);
  const [groups, setGroups] = createSignal<GroupInfo[]>([]);
  const [groupId, setGroupId] = createSignal<string | undefined>(undefined);
  const [version, setVersion] = createSignal(0);
  const [row, setRow] = createSignal(0);
  const [viewStart, setViewStart] = createSignal(target.viewStart);
  const [anchor, setAnchor] = createSignal(target.anchor);
  const [area, setArea] = createSignal<'grid' | 'channels'>('grid');
  const [picking, setPicking] = createSignal<number | undefined>(undefined);
  const [expanded, setExpanded] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  let root: ElementNode | undefined;
  let gridNode: ElementNode | undefined;
  let pickerNode: ElementNode | undefined;
  let removePicker: (() => void) | undefined;
  let alive = true;
  let lastTop = 0;
  let groupSeq = 0;

  const cache = new EpgCache<ChannelRow, ProgrammeLite>(
    (g, o, c, f, t) => api.getEpgRows(g, o, c, f, t),
    { rowsPerPage: 20, chunkMs: 3 * HOUR, maxEntries: 24, maxAgeMs: 15 * MINUTE, onChange: () => setVersion((v) => v + 1) },
  );

  const total = () => { version(); return cache.total() ?? 0; };
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
    lastTop = scrollTopFor(row(), lastTop, EPG_VIEW_ROWS, t);
    return lastTop;
  });
  const rowBlocks = createMemo(() => blocksAt(row()));
  const focusIndex = createMemo(() => blockIndexAt(rowBlocks(), anchor()));
  const focusBlock = () => rowBlocks()[focusIndex()];
  const focusChannel = () => channelAt(row());

  // ---- loading: the visible 3 h first, then the prefetch either side ----

  createEffect(() => {
    const g = groupId();
    if (g === undefined) return;
    const r = renderRange(top(), EPG_VIEW_ROWS, Math.max(total(), 1), ROW_BUFFER);
    const vs = viewStart();
    const wide = prefetchRange(vs, win);
    const warn = (err: unknown) => console.warn('Guide rows failed', err instanceof Error ? err.name : 'Error');
    cache.ensure(r.from, Math.max(r.to, 1), vs, vs + 3 * HOUR)
      .then(() => (alive && cache.group() === g ? cache.ensure(r.from, Math.max(r.to, 1), wide.start, wide.end) : undefined))
      .catch(warn);
  });

  // ---- groups ----

  /** `remember`: a normal open or a user pick; the open at a Search target keeps the remembered group. */
  const openGroup = (g: string, index: number, remember = true) => {
    groupSeq++;
    if (remember) memory.groupId = g;
    // The group's count (from getGroups) is the total, so opening needs no extra request for page 0.
    cache.setGroup(g, groups().find((x) => x.id === g)?.count);
    lastTop = Math.max(0, index - 3);
    setRow(index);
    setGroupId(g);
  };

  /**
   * The playing channel's position, in Home's group, else the remembered one, else All channels. `superseded`
   * when the user picked another group meanwhile (the caller then leaves that choice alone).
   */
  const locatePlaying = async (gs: GroupInfo[]): Promise<{ g: string | undefined; index: number } | 'superseded'> => {
    const seq = groupSeq;
    const exists = (id: string | undefined) => id !== undefined && gs.some((x) => x.id === id);
    const g = pickGroup(gs, exists(wantedGroup) ? wantedGroup : memory.groupId);
    const id = target.channelId ?? playback.current()?.id;
    if (g === undefined || id === undefined) return { g, index: 0 };
    const index = await api.indexOf(g, id).catch(() => -1);
    if (seq !== groupSeq) return 'superseded';
    if (index >= 0 || g === GROUP_ALL || !gs.some((x) => x.id === GROUP_ALL)) {
      return { g, index: Math.max(0, index) };
    }
    const inAll = await api.indexOf(GROUP_ALL, id).catch(() => -1);
    if (seq !== groupSeq) return 'superseded';
    return inAll >= 0 ? { g: GROUP_ALL, index: inAll } : { g, index: 0 };
  };

  const openPicker = () => {
    const gs = groups();
    if (gs.length === 0) return true;
    setPicking(Math.max(0, gs.findIndex((x) => x.id === groupId())));
    removePicker = router.pushOverlay(PICKER_ID, closePicker);
    queueMicrotask(() => { if (alive) pickerNode?.setFocus(); });
    return true;
  };
  function closePicker() {
    removePicker = undefined;
    setPicking(undefined);
    queueMicrotask(() => { if (alive) gridNode?.setFocus(); });
  }
  const choosePicked = () => {
    const g = groups()[picking() ?? -1];
    removePicker?.();
    closePicker();
    if (g && g.id !== groupId()) {
      setArea('grid');
      openGroup(g.id, 0);
    }
    return true;
  };

  // ---- keys ----

  const setFocusRow = (i: number) => {
    setRow(i);
    setExpanded(false);
    return true;
  };
  const applyStep = (s: HStep) => {
    if (s.kind === 'move' || s.kind === 'scroll') {
      setViewStart(s.viewStart);
      setAnchor(s.anchor);
      setExpanded(false);
    }
  };

  /** Plays the channel and opens the Player (Back returns here). */
  const play = (ch: ChannelRow) => {
    const g = groupId() ?? GROUP_ALL;
    const token = playback.begin();
    void (async () => {
      try {
        const pc = await api.getPlayable(ch.id);
        if (!alive || !pc || !playback.isLatest(token)) return;
        // Same channel: the stream keeps running and only the rect changes (no reconnect).
        playback.playChannel(pc);
        await api.markWatched(ch.id, g).catch(() => undefined);
        // The Player sets the rect to fullscreen on mount, so no fullscreen flash in the mini window beforehand.
        if (alive && playback.isLatest(token)) router.push('player', { channelId: ch.id, groupId: g });
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
  };

  const keys = {
    onUp: () => setFocusRow(moveFocus(row(), -1, total())),
    onDown: () => setFocusRow(moveFocus(row(), 1, total())),
    onPage: (dir: 1 | -1) => setFocusRow(pageFocus(row(), dir, EPG_VIEW_ROWS, total())),
    onLeft: () => {
      if (area() === 'channels') return openPicker();
      const s = stepLeft(rowBlocks(), focusIndex(), { viewStart: viewStart(), anchor: anchor() }, win);
      if (s.kind === 'edge') setArea('channels');
      else applyStep(s);
      return true;
    },
    onRight: () => {
      if (area() === 'channels') { setArea('grid'); return true; }
      applyStep(stepRight(rowBlocks(), focusIndex(), { viewStart: viewStart(), anchor: anchor() }, win));
      return true;
    },
    onOk: () => {
      const ch = focusChannel();
      if (!ch) return true;
      const b = focusBlock();
      if (area() === 'channels' || !b || isOnAir(b, Date.now())) play(ch);
      else setExpanded((v) => !v); // future or past: details only (no catch-up in v1)
      return true;
    },
  };

  // ---- pointer (mouse, pointer remote) ----

  /** A click: an unfocused cell takes focus like moving there; the focused cell, or a channel name, acts like Ok. */
  const onCellClick = (hit: GridHit<Block>) => {
    gridNode?.setFocus();
    if (hit.area === 'channels') {
      setFocusRow(hit.row);
      setArea('channels');
      keys.onOk();
      return;
    }
    const kind = guideClick({ area: 'grid', row: hit.row, start: hit.block.start },
      { row: row(), area: area(), focusStart: focusBlock()?.start });
    if (kind === 'ok') {
      keys.onOk();
      return;
    }
    setFocusRow(hit.row);
    setArea('grid');
    setAnchor(Math.max(hit.block.start, viewStart()));
  };

  /** The wheel moves rows like Up/Down; the horizontal (or Shift) wheel steps time like Left/Right, never out of the grid. */
  const onGridWheel = (dy: number, dx: number) => {
    if (dy !== 0) setFocusRow(moveFocus(row(), dy, total()));
    if (dx === 0 || area() !== 'grid') return;
    const view = { viewStart: viewStart(), anchor: anchor() };
    const s = dx > 0 ? stepRight(rowBlocks(), focusIndex(), view, win) : stepLeft(rowBlocks(), focusIndex(), view, win);
    if (s.kind !== 'edge') applyStep(s);
  };

  /** `‹ Earlier` / `Later ›`: three hours at a time. */
  const pageBy = (dir: 1 | -1) => applyStep(pageTime({ viewStart: viewStart(), anchor: anchor() }, dir, win));

  // ---- lifecycle ----

  onMount(() => {
    playback.setRect(MINI);
    root?.setFocus();
    // Aligned to the minute boundary, so the clock-based labels and the now line change on the minute.
    let tick: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      setNow(Date.now());
      tick = setInterval(() => setNow(Date.now()), MINUTE);
    }, MINUTE - (Date.now() % MINUTE));
    const off = onEvent('refreshed', () => cache.invalidate());
    // A companion switched, added or deleted a source: re-read the groups and open the new source's list.
    const offSources = onEvent('sourcesChanged', (e) => {
      if ((e as { origin?: string }).origin !== 'remote') return;
      void (async () => {
        try {
          const gs = await api.getGroups();
          if (!alive) return;
          cache.invalidate();
          setGroups(gs);
          const located = await locatePlaying(gs);
          if (!alive || located === 'superseded') return;
          if (located.g !== undefined) openGroup(located.g, located.index, target.rememberGroup);
        } catch (err) {
          console.warn('Guide reload failed', err instanceof Error ? err.name : 'Error');
        }
      })();
    });
    onCleanup(() => { clearTimeout(first); if (tick !== undefined) clearInterval(tick); off(); offSources(); });

    void (async () => {
      try {
        const gs = await api.getGroups();
        if (!alive) return;
        setGroups(gs);
        const located = await locatePlaying(gs);
        if (!alive || located === 'superseded') return;
        if (located.g !== undefined) openGroup(located.g, located.index, target.rememberGroup);
      } catch (err) {
        console.warn('Guide load failed', err instanceof Error ? err.name : 'Error');
      } finally {
        if (alive) {
          setReady(true);
          gridNode?.setFocus();
        }
      }
    })();
  });

  onCleanup(() => {
    alive = false;
    removePicker?.();
    router.removeOverlay(PICKER_ID);
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    if (area() === 'channels') { setArea('grid'); return true; }
    return false; // back to the previous screen, which sets its own video rect
  };

  // ---- header ----

  const groupName = () => groups().find((g) => g.id === groupId())?.name ?? '';
  const miniMessage = () => {
    const playing = playback.current() !== undefined;
    return playing ? previewMessage(playback.status(), true) : 'Nothing playing';
  };
  const whenLine = () => {
    const b = focusBlock();
    if (!b) return '';
    return `${dayLabel(b.start, now())} ${formatRange(b.start, b.stop)} · ${relativeLabel(b, now())}`;
  };
  const descText = () => {
    const b = focusBlock();
    if (!b) return '';
    if (b.filler) return 'There is no guide information for this time.';
    return b.desc ?? '';
  };

  return (
    <View ref={root} width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}
      forwardFocus={() => { gridNode?.setFocus(); return true; }}>
      {/* Opaque everywhere except the mini window, a hole onto the video. */}
      <View width={LAYOUT.width} height={MINI.y} color={COLORS.background} />
      <View y={MINI.y + MINI.h} width={LAYOUT.width} height={LAYOUT.height - MINI.y - MINI.h} color={COLORS.background} />
      <View y={MINI.y} width={MINI.x} height={MINI.h} color={COLORS.background} />
      <View x={MINI.x + MINI.w} y={MINI.y} width={LAYOUT.width - MINI.x - MINI.w} height={MINI.h} color={COLORS.background} />
      <Show when={miniMessage()}>{(m) => (
        <View x={MINI.x} y={MINI.y} width={MINI.w} height={MINI.h} borderRadius={LAYOUT.radius}
          color={playback.current() ? COLORS.panel : COLORS.surface}>
          <Text x={24} y={MINI.h / 2 - FONT.body} width={MINI.w - 48} maxWidth={MINI.w - 48} contain="width" maxLines={2}
            textAlign="center" fontSize={FONT.body} color={COLORS.muted}>{m()}</Text>
        </View>
      )}</Show>

      {/* Focused programme: context and time beside the brand wordmark, title and description below it. */}
      <View x={INFO_X} y={MINI.y} width={INFO_W} height={MINI.h}>
        <Text x={SIDE_X} y={8} width={SIDE_W} maxWidth={SIDE_W} contain="width" maxLines={1} fontSize={FONT.small} color={COLORS.muted}>
          {`TV guide${groupName() ? ` · ${groupName()}` : ''}${focusChannel() ? ` · ${focusChannel()!.number} ${focusChannel()!.name}` : ''}`}
        </Text>
        <Text y={TITLE_TOP} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={1} fontSize={FONT.title} color={COLORS.text}>
          {focusBlock()?.title ?? (ready() && total() === 0 ? 'No channels here yet.' : '')}
        </Text>
        <Text x={SIDE_X} y={40} width={SIDE_W} maxWidth={SIDE_W} contain="width" maxLines={1} fontSize={FONT.body}
          color={focusBlock() && isOnAir(focusBlock()!, now()) ? COLORS.focus : COLORS.muted}>{whenLine()}</Text>
        <Text y={TITLE_TOP + 58} width={INFO_W} maxWidth={INFO_W} contain="width" maxLines={expanded() ? 4 : 2} fontSize={FONT.body}
          color={COLORS.text}>{descText()}</Text>
      </View>

      <EpgGrid ref={(el) => { gridNode = el; }} x={LAYOUT.safeX} y={GRID_Y} total={total()} top={top()} focusRow={row()}
        focusStart={focusBlock()?.start} area={area()} viewStart={viewStart()} now={now()}
        playingId={playback.current()?.id} dayLabel={dayLabel(viewStart(), now())}
        channel={channelAt} blocks={blocksAt} {...keys} onCellClick={onCellClick} onPointerWheel={onGridWheel} />

      {/* Pointer mode only: the bottom row, after the shell's Back. The ruler stays as the remote sees it. */}
      <PointerBar x={SCREEN_ROW_X} y={BOTTOM_ROW_Y} height={BOTTOM_ROW_H} items={[
        { id: 'groups', label: GUIDE_POINTER_LABELS.groups, onPress: () => { openPicker(); } },
        { id: 'earlier', label: GUIDE_POINTER_LABELS.earlier, onPress: () => pageBy(-1) },
        { id: 'later', label: GUIDE_POINTER_LABELS.later, onPress: () => pageBy(1) },
      ]} />

      {/* Pointer mode: the shell's Back button stands on this line instead. */}
      <Show when={!pointerMode()}>
        <Text x={LAYOUT.safeX} y={HINT_Y} width={EPG_GRID_W} maxWidth={EPG_GRID_W} contain="width" maxLines={1}
          fontSize={FONT.small} color={COLORS.muted}>
          {area() === 'channels'
            ? 'Ok watch · Left groups · Right back to the guide · Ch+/Ch− page'
            : 'Ok watch now / details · Left at the start: channels and groups · Ch+/Ch− page'}
        </Text>
      </Show>

      <Show when={picking() !== undefined}>{(_open) => {
        let backdrop: ElementNode | undefined;
        let panel: ElementNode | undefined;
        // Backdrop (outside the panel: Back), then the panel (swallows), then the list (created below) wins.
        usePointerBackdrop(() => backdrop);
        usePointerTarget({ node: () => panel, layer: 'overlay' });
        return (
          <View ref={(el) => { panel = el; }} x={LAYOUT.safeX} y={GRID_Y} width={PICKER_W} height={RULER_H + EPG_VIEW_ROWS * EPG_ROW_H}
            color={COLORS.surface} borderRadius={LAYOUT.radius} zIndex={20}>
            {/* The click-outside area: the whole screen. No colour: it draws nothing. */}
            <View ref={(el) => { backdrop = el; }} x={-LAYOUT.safeX} y={-GRID_Y} width={LAYOUT.width} height={LAYOUT.height} />
            <Text x={24} y={16} fontSize={FONT.heading} color={COLORS.text}>{'Groups'}</Text>
            <GroupList ref={(el) => { pickerNode = el; }} x={16} y={68} width={PICKER_W - 32}
              height={RULER_H + EPG_VIEW_ROWS * EPG_ROW_H - 84} groups={groups()} selected={picking() ?? 0}
              onSelect={(i) => setPicking(i)} onRight={choosePicked} pointerLayer="overlay"
              onRowClick={(i) => { setPicking(i); choosePicked(); }} />
          </View>
        );
      }}</Show>
    </View>
  );
}
