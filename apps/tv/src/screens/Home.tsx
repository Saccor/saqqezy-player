import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { AppEvent, ChannelRow } from '@iptv/app-api';
import type { GroupInfo } from '@iptv/core';
import type { Rect } from '@iptv/player';
import { api, onEvent } from '../api.ts';
import { ChannelList, ROW_H } from '../components/ChannelList.tsx';
import { ContextMenu, type ContextAction } from '../components/ContextMenu.tsx';
import { GroupList } from '../components/GroupList.tsx';
import { PREVIEW_H, PREVIEW_W, PreviewPanel } from '../components/PreviewPanel.tsx';
import { moveFocus, pageFocus, renderRange, scrollTopFor } from '../components/virtualWindow.ts';
import { createDebounce } from '../playback/debounce.ts';
import { playback, previewHold } from '../playback/playback.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { showToast } from '../shell/Toast.tsx';
import { markStartup } from '../state/appState.ts';
import { pickGroup, restoreIndex } from './homeLogic.ts';
import { SliceCache } from './sliceCache.ts';

// Layout A: groups 22 % | channel list | preview 34 % of the safe width.
const SAFE_W = LAYOUT.width - LAYOUT.safeX * 2;
const GROUP_X = LAYOUT.safeX;
const GROUP_W = Math.round(SAFE_W * 0.22);
const PREVIEW_X = LAYOUT.width - LAYOUT.safeX - PREVIEW_W;
const LIST_X = GROUP_X + GROUP_W + LAYOUT.gap;
const LIST_W = PREVIEW_X - LAYOUT.gap - LIST_X;
const HEAD_Y = 110;
const BODY_Y = 170;
const LIST_ROWS = 9;
const LIST_H = LIST_ROWS * ROW_H;
const HINT_Y = LAYOUT.height - LAYOUT.safeY - 34;
const PREVIEW_RECT: Rect = { x: PREVIEW_X, y: BODY_Y, w: PREVIEW_W, h: PREVIEW_H };
const PREVIEW_DELAY_MS = 700;
const MENU_ID = 'contextMenu';
const GROUP_ALL = 'all';

type Progress = Extract<AppEvent, { type: 'progress' }>;

/**
 * In-memory position across Home visits (each push/pop re-creates the screen): the open group, the focused
 * channel and the last focused row per group.
 */
const memory: { groupId?: string; channelId?: string; rows: Map<string, number> } = { rows: new Map() };

/** Home: groups, a virtualised channel list with now/next, the live preview and the channel options menu. */
export function HomeScreen(props: { entry: ScreenEntry }) {
  const params = props.entry.params as { lastGroupId?: string; lastChannelId?: string };

  const [groups, setGroups] = createSignal<GroupInfo[]>([]);
  const [groupId, setGroupId] = createSignal<string | undefined>(undefined);
  const [focus, setFocus] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [area, setArea] = createSignal<'groups' | 'list'>('list');
  const [ready, setReady] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  const [progress, setProgress] = createSignal<Progress | undefined>(undefined);
  const [menu, setMenu] = createSignal<ChannelRow | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());

  let groupNode: ElementNode | undefined;
  let listNode: ElementNode | undefined;
  let menuNode: ElementNode | undefined;
  let removeMenu: (() => void) | undefined;
  let alive = true;
  let startupMarked = false;
  // Playback was stopped on purpose (sleep timer): no resume and no auto-preview until the user moves.
  let held = previewHold.take();
  let lastTop = 0;

  const cache = new SliceCache<ChannelRow>((g, o, c) => api.getChannelSlice(g, o, c), 40, () => setVersion((v) => v + 1));

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
  const groupIndex = () => Math.max(0, groups().findIndex((g) => g.id === groupId()));

  const load = () => {
    const g = groupId();
    if (g === undefined) return;
    const r = renderRange(top(), LIST_ROWS, Math.max(total(), 1));
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

  // ---- preview ----

  const playById = async (id: string) => {
    try {
      const ch = await api.getPlayable(id);
      if (alive && ch) playback.playChannel(ch);
    } catch (err) {
      console.warn('Preview failed', err instanceof Error ? err.name : 'Error');
    }
  };
  const preview = createDebounce<string>(PREVIEW_DELAY_MS, (id) => {
    if (alive && focusedRow()?.id === id && area() === 'list') void playById(id);
  });

  /** Moves the list focus and remembers it; a resting focus starts the preview after 700 ms. */
  const selectRow = (i: number) => {
    setFocus(i);
    const g = groupId();
    if (g !== undefined) memory.rows.set(g, i);
    memory.groupId = g;
    const r = rowAt(i);
    if (r) memory.channelId = r.id;
  };
  // Schedules the preview whenever the focused row (or its data) changes while the list has focus.
  createEffect(() => {
    const r = focusedRow();
    if (!r || area() !== 'list' || !ready()) return;
    memory.channelId = r.id;
    if (held) return;
    if (playback.current()?.id !== r.id) preview.schedule(r.id);
    else preview.cancel();
  });

  // ---- groups ----

  /** Opens group `g`, focusing `keepId` when it is in the group. Resolves true when it was found. */
  const openGroup = async (g: string, keepId?: string, keepScroll = false): Promise<boolean> => {
    if (!keepScroll) lastTop = 0;
    setGroupId(g);
    await cache.ensure(g, 0, 1).catch(() => undefined);
    if (!alive || groupId() !== g) return false;
    const t = cache.total(g) ?? 0;
    const byId = keepId ? await api.indexOf(g, keepId).catch(() => -1) : -1;
    if (!alive || groupId() !== g) return false;
    selectRow(restoreIndex(byId, memory.rows.get(g), t));
    return byId >= 0;
  };

  /** Re-reads groups and the visible slice, keeping focus on the same channel id when it still exists. */
  const reload = async () => {
    const keepId = focusedRow()?.id ?? memory.channelId;
    const gs = await api.getGroups();
    if (!alive) return;
    setGroups(gs);
    cache.invalidate();
    const g = pickGroup(gs, groupId());
    if (g !== undefined) await openGroup(g, keepId, g === groupId());
  };

  // ---- actions ----

  const focusArea = (a: 'groups' | 'list') => {
    // The group's count is known before its first slice arrives, so a quick Right is not lost.
    const count = total() || (groups().find((g) => g.id === groupId())?.count ?? 0);
    if (a === 'list' && count === 0) return true;
    setArea(a);
    (a === 'groups' ? groupNode : listNode)?.setFocus();
    return true;
  };

  const watch = () => {
    const r = focusedRow();
    const g = groupId();
    if (!r || g === undefined) return true;
    preview.cancel();
    memory.channelId = r.id;
    void (async () => {
      try {
        const ch = await api.getPlayable(r.id);
        if (!alive || !ch) return;
        // Same channel: the stream keeps running and only the rect changes (no reconnect).
        playback.playChannel(ch);
        playback.setRect('fullscreen');
        await api.markWatched(r.id, g).catch(() => undefined);
        if (alive) router.push('player', { channelId: r.id, groupId: g });
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
    return true;
  };

  const closeMenu = () => {
    removeMenu = undefined;
    setMenu(undefined);
    queueMicrotask(() => { if (alive) focusArea('list'); });
  };
  const openMenu = () => {
    const r = focusedRow();
    if (!r) return true;
    preview.cancel();
    setMenu(r);
    removeMenu = router.pushOverlay(MENU_ID, closeMenu);
    queueMicrotask(() => menuNode?.setFocus());
    return true;
  };
  const choose = async (action: ContextAction) => {
    const r = menu();
    removeMenu?.();
    closeMenu();
    if (!r || action === 'cancel') return;
    try {
      if (action === 'favourite') {
        const on = await api.toggleFavourite(r.id);
        showToast(on ? 'Added to favourites' : 'Removed from favourites');
      } else {
        await api.toggleHidden(r.id);
        showToast('Channel hidden');
      }
      if (alive) await reload();
    } catch (err) {
      console.warn('Channel option failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't change this channel.");
    }
  };

  const listKeys = {
    onMove: (d: number) => { held = false; selectRow(moveFocus(focus(), d, total())); return true; },
    onPage: (dir: 1 | -1) => { held = false; selectRow(pageFocus(focus(), dir, LIST_ROWS, total())); return true; },
    onLeft: () => focusArea('groups'),
    onOk: watch,
    onOptions: openMenu,
  };

  const onGroupSelect = (i: number) => {
    const g = groups()[i];
    if (!g) return;
    preview.cancel();
    held = false;
    void openGroup(g.id);
  };

  // ---- lifecycle ----

  onMount(() => {
    playback.setRect(PREVIEW_RECT);
    const offs = [
      onEvent('progress', (p) => setProgress(p as Progress)),
      onEvent('refreshed', () => { setWaiting(false); void reload().catch(() => undefined); }),
      onEvent('refreshFailed', () => setWaiting(false)),
    ];
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => { for (const off of offs) off(); clearInterval(tick); });

    void (async () => {
      try {
        const gs = await api.getGroups();
        if (!alive) return;
        setGroups(gs);
        const wantGroup = memory.groupId ?? params.lastGroupId;
        // Coming back from the Player: focus the channel that is playing (it may have zapped away).
        const playingId = playback.current()?.id;
        const wantChannel = playingId ?? memory.channelId ?? params.lastChannelId;
        const g = pickGroup(gs, wantGroup);
        // An empty cache on first start: the list arrives with a later `refreshed` event.
        if ((gs.find((x) => x.id === 'all')?.count ?? 0) === 0) setWaiting(true);
        let found = g !== undefined && await openGroup(g, wantChannel);
        if (!alive) return;
        // A channel reached by number entry may be outside the remembered group: show it in "All".
        if (!found && playingId !== undefined && g !== GROUP_ALL && gs.some((x) => x.id === GROUP_ALL)) {
          found = await openGroup(GROUP_ALL, playingId);
          if (!alive) return;
        }
        setReady(true);
        focusArea(total() > 0 ? 'list' : 'groups');
        // The preview resumes the last channel right away (no-op when it is already playing). A last channel
        // that is gone or hidden is not resumed; the focused row previews after the usual delay instead.
        const resume = playback.current()?.id ?? (found ? wantChannel : undefined);
        if (resume && !held) void playById(resume);
      } catch (err) {
        console.warn('Home load failed', err instanceof Error ? err.name : 'Error');
        setReady(true);
      }
    })();
  });

  onCleanup(() => {
    alive = false;
    preview.cancel();
    removeMenu?.();
    router.removeOverlay(MENU_ID);
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    if (area() === 'groups' && total() > 0) return focusArea('list');
    return false;
  };

  const groupName = () => groups().find((g) => g.id === groupId())?.name ?? '';
  const emptyText = () => {
    if (!ready()) return '';
    if (waiting()) {
      const p = progress();
      return p ? `Loading channels… ${p.count}` : 'Loading channels…';
    }
    return 'No channels here yet.';
  };

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} onBack={onBack}
      forwardFocus={() => { focusArea(area()); return true; }}
      onYellow={() => { router.push('search'); return true; }}
      onGreen={() => { router.push('guide'); return true; }}
      onBlue={() => { router.push('settings'); return true; }}>
      {/* Opaque background everywhere except the preview box, which stays a hole onto the video. */}
      <View width={LAYOUT.width} height={PREVIEW_RECT.y} color={COLORS.background} />
      <View y={PREVIEW_RECT.y + PREVIEW_RECT.h} width={LAYOUT.width} height={LAYOUT.height - PREVIEW_RECT.y - PREVIEW_RECT.h}
        color={COLORS.background} />
      <View y={PREVIEW_RECT.y} width={PREVIEW_RECT.x} height={PREVIEW_RECT.h} color={COLORS.background} />
      <View x={PREVIEW_RECT.x + PREVIEW_RECT.w} y={PREVIEW_RECT.y} width={LAYOUT.width - PREVIEW_RECT.x - PREVIEW_RECT.w}
        height={PREVIEW_RECT.h} color={COLORS.background} />

      <Text x={GROUP_X} y={LAYOUT.safeY} fontSize={FONT.title} color={COLORS.text}>{'Channels'}</Text>
      <Text x={LIST_X} y={HEAD_Y} width={LIST_W} maxWidth={LIST_W} contain="width" maxLines={1} fontSize={FONT.body}
        color={COLORS.muted}>{groupName() ? `${groupName()} · ${total()}` : ''}</Text>

      <GroupList ref={(el) => { groupNode = el; }} x={GROUP_X} y={BODY_Y} width={GROUP_W} height={LIST_H}
        groups={groups()} selected={groupIndex()} onSelect={onGroupSelect} onRight={() => focusArea('list')} />

      <ChannelList ref={(el) => { listNode = el; }} x={LIST_X} y={BODY_Y} width={LIST_W} height={LIST_H}
        total={total()} top={top()} focus={focus()} row={rowAt} now={now()} playingId={playback.current()?.id}
        onFocusChanged={(f) => { if (f) setArea('list'); }} {...listKeys} />
      <Show when={ready() && total() === 0}>
        <Text x={LIST_X + 24} y={BODY_Y + 24} width={LIST_W - 48} maxWidth={LIST_W - 48} contain="width"
          fontSize={FONT.body} color={COLORS.muted}>{emptyText()}</Text>
      </Show>

      <PreviewPanel x={PREVIEW_X} y={BODY_Y} channel={focusedRow()} status={playback.status()}
        playing={playback.current() !== undefined} now={now()} />

      <Text x={GROUP_X} y={HINT_Y} width={SAFE_W} maxWidth={SAFE_W} contain="width" maxLines={1} fontSize={FONT.small}
        color={COLORS.muted}>
        {'Ok watch · Hold Ok or Menu: options · Yellow search · Green guide · Blue settings'}
      </Text>

      <Show when={menu()}>{(r) => (
        <ContextMenu ref={(el) => { menuNode = el; }} title={r().name} favourite={r().favourite}
          onChoose={(a) => void choose(a)} />
      )}</Show>
    </View>
  );
}
