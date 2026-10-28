/**
 * The full-screen player's channel changes: zapping in the zap group (Up/Down, Channel up/down, the wheel), number
 * entry, the Red previous-channel toggle and a jump to one channel. The banner previews the channel a zap lands on;
 * the stream switches once the zap settles. Not unit-tested: the pure parts live in zapper.ts and numberEntry.ts.
 */
import { createSignal } from 'solid-js';
import type { PlayableChannel } from '@iptv/app-api';
import { api } from '../../api.ts';
import { PLAYER_COPY } from '../../copy.ts';
import { withFailTest } from '../../dev/failTest.ts';
import { channelHistory } from '../../playback/channelHistory.ts';
import { devResume } from '../../playback/devResume.ts';
import { createNumberEntry } from '../../playback/numberEntry.ts';
import { playback } from '../../playback/playback.ts';
import { rowIdOf } from '../../playback/sourceLogic.ts';
import { createZapper } from '../../playback/zapper.ts';
import { createJumpGuard } from '../playerLogic.ts';

const GROUP_ALL = 'all';
const ZAP_DELAY_MS = 300;
const NUMBER_IDLE_MS = 1500;

/** Wraps channel lookups; in DEV, `?failTest=1` turns channel 1 into an unreachable stream. */
function lookup(p: Promise<PlayableChannel | undefined>): Promise<PlayableChannel | undefined> {
  return import.meta.env.DEV ? p.then(withFailTest) : p;
}

export function createChannelSwitch(d: {
  alive: () => boolean;
  /** The row the Player opened on (`params.channelId`) and its zap group. */
  channelId: string | undefined;
  groupId: string | undefined;
  showBanner: () => void;
  /** A short message where the number shows (a number or previous channel that is not there). */
  flashMessage: (text: string) => void;
  /** The digits typed so far ('' when none); a new number clears the message. */
  onDigits: (text: string) => void;
}) {
  const { alive, showBanner } = d;
  let zapGroup = d.groupId ?? GROUP_ALL;
  const initial = playback.current();
  const [shown, setShown] = createSignal<PlayableChannel | undefined>(
    initial && rowIdOf(initial) === d.channelId ? initial : undefined,
  );
  const jumps = createJumpGuard();
  // Channels that were found by falling back to "All": committing one switches the zap group.
  const fallbackGroup = new WeakSet<PlayableChannel>();

  /** Plays `ch` now (the stream restarts only when it is a different or failed channel). */
  const commit = (ch: PlayableChannel) => {
    if (!alive()) return;
    playback.playChannel(ch);
    setShown(ch);
    // The row, not the stream: a combined channel's streams take turns under one row.
    const row = rowIdOf(ch)!;
    channelHistory.visit(row);
    zapper.setCurrent(row);
    if (fallbackGroup.has(ch)) zapGroup = GROUP_ALL;
    showBanner();
    api.markWatched(row, zapGroup).catch(() => undefined);
  };

  /** Neighbour within the zap group; a channel outside it (after number entry) falls back to "All". */
  const neighbour = async (anchor: string, offset: number) => {
    const inGroup = await lookup(api.neighbour(zapGroup, anchor, offset));
    if (inGroup || zapGroup === GROUP_ALL) return inGroup;
    const inAll = await lookup(api.neighbour(GROUP_ALL, anchor, offset));
    if (inAll) fallbackGroup.add(inAll);
    return inAll;
  };

  const zapper = createZapper<PlayableChannel>({
    delayMs: ZAP_DELAY_MS,
    resolve: neighbour,
    onPreview: (ch) => { if (alive()) { setShown(ch); showBanner(); } },
    onCommit: commit,
    onMiss: () => { if (alive()) setShown(playback.current() ?? shown()); },
  });

  const zap = (delta: number) => {
    numbers.clear();
    jumps.bump();
    zapper.press(delta);
    return true;
  };

  const jumpTo = async (load: () => Promise<PlayableChannel | undefined>, missText?: string) => {
    devResume.release(); // the user started a channel (spec §3.1)
    const mine = jumps.bump();
    try {
      const ch = await lookup(load());
      if (!alive() || !jumps.isCurrent(mine)) return;
      if (ch) {
        zapper.cancel();
        commit(ch);
      } else if (missText) {
        d.flashMessage(missText);
      }
    } catch (err) {
      console.warn('Channel change failed', err instanceof Error ? err.name : 'Error');
    }
  };

  const numbers = createNumberEntry({
    idleMs: NUMBER_IDLE_MS,
    maxDigits: 4,
    onChange: d.onDigits,
    onSubmit: (n) => void jumpTo(() => api.byNumber(n), PLAYER_COPY.noChannel(n)),
  });

  const previous = () => {
    const prev = channelHistory.previous();
    if (prev) void jumpTo(() => api.getPlayable(prev), PLAYER_COPY.previousUnavailable);
    return true;
  };

  return {
    shown, setShown, zap, jumpTo, previous, numbers,
    /** The Player opened on the playing row: it is the current channel for zapping and history. */
    adopt: (row: string) => {
      channelHistory.visit(row);
      zapper.setCurrent(row);
    },
    /** Unmount: a pending zap and number entry stop. */
    dispose: () => {
      zapper.cancel();
      numbers.clear();
    },
  };
}
