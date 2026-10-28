/**
 * Live TV's groups: opening one (the cache swaps to it), finding the group and row a channel should open at, and
 * re-reading the groups and the guide after a refresh or a layout change while keeping the focus on its channel.
 * `seq()` changes whenever a group opens, so an answer for the previous group is dropped. Not unit-tested: the pure
 * rules live in liveLogic.ts and homeMenuLogic.ts.
 */
import { batch } from 'solid-js';
import type { GroupInfo } from '@iptv/core';
import { api } from '../../api.ts';
import { initState } from '../../state/appState.ts';
import { waitsForChannels } from '../homeLogic.ts';
import { focusAfterRefresh } from '../homeMenuLogic.ts';
import { groupsRetryMs, locateFocus } from './liveLogic.ts';
import { memory } from './liveMemory.ts';
import { GROUP_ALL, type LiveState } from './liveState.ts';

/** The channels in All (0: the source has no live channels, or they are still loading). */
export const allIn = (gs: readonly GroupInfo[]) => gs.find((x) => x.id === GROUP_ALL)?.count ?? 0;

export function createLiveGroups(s: LiveState, alive: () => boolean) {
  let groupSeq = 0;
  let reloadSeq = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const openGroup = (g: string, index: number) => {
    groupSeq++;
    // The group's count (from getGroups) is the total, so opening needs no extra request for page 0.
    s.cache.setGroup(g, s.groups().find((x) => x.id === g)?.count);
    s.scrollNear(index);
    batch(() => {
      s.setRow(index);
      s.setExpanded(false);
      s.setGroupId(g);
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
  const reload = async (keepId0?: string): Promise<GroupInfo[] | undefined> => {
    const seq = ++reloadSeq;
    const keepId = keepId0 ?? s.focusedId() ?? memory.channelId;
    const before = s.groupId();
    const gs = await api.getGroups();
    if (!alive() || seq !== reloadSeq) return undefined;
    s.setGroups(gs);
    s.setGroupsFailed(false); // a failed first read is answered (its retry stops)
    if (before !== undefined && gs.some((x) => x.id === before)) {
      // Same group: the rows stay on screen and are refetched (`setGroup` to the same group is a no-op, so no blank grid).
      s.cache.staleAll();
      s.setKick((k) => k + 1);
      // The channel's new row; one that left the group (hidden, removed) hands its row to the neighbour.
      const gSeq = groupSeq;
      const index = keepId === undefined ? -1 : await api.indexOf(before, keepId).catch(() => -1);
      if (!alive() || seq !== reloadSeq || gSeq !== groupSeq) return gs;
      const count = gs.find((x) => x.id === before)?.count ?? 0;
      s.setFocusRow(focusAfterRefresh(index, s.row(), count));
      return gs;
    }
    // The group disappeared: All channels (or the first group; `openGroup` swaps the cache), at the same channel when it is there.
    const located = await locate(gs, undefined, [], [keepId]);
    if (!alive() || seq !== reloadSeq || located === 'superseded' || located.g === undefined) return gs;
    openGroup(located.g, located.index);
    return gs;
  };

  /**
   * Reads the groups and opens the focus group. A failed read (the worker) is not "no live channels": the info block
   * says so and the read runs again (`groupsRetryMs`) until it, or a `refreshed` re-read, succeeds. A retry that
   * succeeds leaves the focus where the user put it meanwhile. `settled` runs after every attempt (the screen sets
   * the focus); `playingId` is the channel playing (or the one a VOD tab stopped).
   */
  const firstLoad = async (attempt: number, playingId: string | undefined, settled: (attempt: number) => void) => {
    const { target, params, fromCatchup, focusHint } = s;
    try {
      const gs = await api.getGroups();
      if (!alive()) return;
      s.setGroups(gs);
      s.setGroupsFailed(false);
      // An empty cache on first start: the channels arrive with a later `refreshed` event.
      if (waitsForChannels(allIn(gs), initState()?.hasVod)) s.setWaiting(true);
      // Focus order: a requested channel, the Player's last channel, the playing one (these may switch to All), then
      // the remembered one and init's last (these keep the group). One lookup when the first is in the group.
      // Back from catch-up the remembered channel comes first: the live channel resumes later (async).
      // The remembered row is the fallback in the remembered group (its channel was hidden or removed meanwhile).
      const prefer = target.groupId ?? memory.groupId ?? params.lastGroupId;
      const located = await locate(gs, prefer,
        fromCatchup ? [target.channelId] : [target.channelId, focusHint, playingId],
        fromCatchup ? [memory.channelId, playingId, params.lastChannelId] : [memory.channelId, params.lastChannelId],
        prefer !== undefined && prefer === memory.groupId ? memory.row : undefined);
      if (!alive() || located === 'superseded') return;
      if (located.g !== undefined) openGroup(located.g, located.index);
    } catch (err) {
      console.warn('Live TV load failed', err instanceof Error ? err.name : 'Error');
      if (alive() && s.groups().length === 0) {
        s.setGroupsFailed(true);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (alive() && s.groupsFailed()) void firstLoad(attempt + 1, playingId, settled);
        }, groupsRetryMs(attempt));
      }
    } finally {
      settled(attempt);
    }
  };

  return {
    openGroup, locate, reload, firstLoad, seq: () => groupSeq,
    /** Unmount: a first read waiting to be retried never runs. */
    dispose: () => { clearTimeout(retryTimer); },
  };
}
