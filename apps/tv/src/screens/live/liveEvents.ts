/**
 * The worker's events Live TV follows while it is mounted: load progress, refreshes (the groups and the guide are read
 * again, keeping the focus), a companion's layout or source change, and the source's archive and short-EPG answers
 * (their rows are fetched again). Returns the unsubscribe functions. Not unit-tested: it drives the screen's parts.
 */
import type { AppEvent } from '@iptv/app-api';
import type { GroupInfo } from '@iptv/core';
import { onEvent } from '../../api.ts';
import { externalLayoutChange } from '../../state/events.ts';
import type { createGroupPicker } from './liveGroupPicker.tsx';
import { allIn } from './liveGroups.ts';
import { retagWarm } from './liveMemory.ts';
import type { createLiveMenu } from './liveMenu.tsx';
import type { LiveState } from './liveState.ts';

type Progress = Extract<AppEvent, { type: 'progress' }>;
type LayoutChanged = Extract<AppEvent, { type: 'layoutChanged' }>;
type SourcesChanged = Extract<AppEvent, { type: 'sourcesChanged' }>;

export function listenLiveEvents(s: LiveState, d: {
  alive: () => boolean;
  reload: () => Promise<GroupInfo[] | undefined>;
  /** After a refresh or a source change: the focus moves off what emptied (`settleFocus` in LiveTv). */
  settleFocus: (hadChannels: boolean) => void;
  liveMenu: ReturnType<typeof createLiveMenu>;
  picker: ReturnType<typeof createGroupPicker>;
  loadCatchupDays: () => Promise<void>;
}): Array<() => void> {
  /** The source the cached rows belong to (a remote source switch invalidates them). */
  let sourceId = s.sourceId;
  return [
    onEvent('progress', (p) => s.setProgress(p as Progress)),
    onEvent('refreshed', () => {
      const had = s.groupCount() > 0;
      s.setWaiting(false);
      void d.reload().then(() => d.settleFocus(had)).catch(() => undefined);
    }),
    // A companion changed the layout, or a backup was restored: re-read, keeping focus by id. Changes made on this
    // screen re-read on their own.
    onEvent('layoutChanged', (e) => {
      if (!externalLayoutChange(e as LayoutChanged)) return;
      // An open menu is rebuilt from the fresh state once the groups are re-read; an open list picker re-reads too.
      void d.reload().then(() => d.liveMenu.rebuildMenu()).catch(() => undefined);
      d.liveMenu.rereadOpenPicker();
    }),
    // A companion switched, added or deleted a source: drop the picker of the old source and re-read.
    onEvent('sourcesChanged', (e) => {
      const ev = e as SourcesChanged;
      if (ev.origin !== 'remote') return;
      // Another source's rows are never valid, not even under the same group id: drop them (answers in flight too).
      if (ev.activeSourceId !== sourceId) {
        sourceId = ev.activeSourceId;
        s.cache.invalidate();
        retagWarm(s.cache, ev.activeSourceId);
      }
      d.picker.dismissPicker();
      d.liveMenu.dismissAll();
      void d.loadCatchupDays();
      const had = s.groupCount() > 0;
      void d.reload().then((gs) => {
        if (!d.alive() || !gs) return;
        s.setWaiting(allIn(gs) === 0);
        d.settleFocus(had);
      }).catch(() => undefined);
    }),
    onEvent('refreshFailed', () => {
      s.setWaiting(false);
      d.settleFocus(true);
    }),
    // The source's own archive listings for the focused row arrived: fetch that row again (no flicker).
    onEvent('archiveRefined', (e) => {
      if (s.focusedId() !== (e as { channelId?: string }).channelId) return;
      s.cache.stalePage(s.row());
      s.setKick((k) => k + 1);
    }),
    // Background short-EPG answers (the focused or playing channel): every cached page holding them is fetched again.
    onEvent('nowNextUpdated', (e) => {
      if (s.cache.staleChannels((e as { channelIds: string[] }).channelIds, (c) => c.id) > 0) s.setKick((k) => k + 1);
    }),
  ];
}
