import { Show, type JSX } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import type { ChannelRow, SportsEventTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { EventChannels } from '../components/EventChannels.tsx';
import { playback } from '../playback/playback.ts';
import { router } from '../shell/router.ts';
import { showToast } from '../shell/Toast.tsx';
import { CATCHUP_COPY, LIVE_COPY } from '../copy.ts';
import { canFromStart } from '../playback/catchupLogic.ts';
import { channelsLabel, eventWhen } from './startLogic.ts';

const GROUP_ALL = 'all';
const EVENT_OVERLAY = 'startEvent';

export function createStartActions(deps: { alive: () => boolean; reload: () => void; refocus: () => void }) {
  /** `fromStart`: the picker plays the chosen channel's programme from its start (catch-up) instead of live. */
  const [event, setEvent] = createSignal<{ tile: SportsEventTile; rows: ChannelRow[]; now: number; fromStart?: boolean } | undefined>();
  let removeLayer: (() => void) | undefined;
  const close = () => { removeLayer?.(); removeLayer = undefined; setEvent(undefined); };

  const tune = (channelId: string) => {
    const token = playback.begin();
    void (async () => {
      try {
        const pc = await api.getPlayable(channelId);
        if (!deps.alive() || !pc || !playback.isLatest(token)) return;
        playback.playChannel(pc);
        playback.setRect('fullscreen');
        await api.markWatched(channelId, GROUP_ALL).catch(() => undefined);
        if (deps.alive() && playback.isLatest(token)) router.push('player', { channelId, groupId: GROUP_ALL });
      } catch (err) {
        console.warn('Open channel failed', err instanceof Error ? err.name : 'Error');
      }
    })();
  };

  /** Catch-up: the channel's programme on now, from its start, in the catch-up player. */
  const fromStart = (ch: ChannelRow) => {
    if (!ch.now) return;
    api.getCatchupPlayable(ch.id, ch.now.start).then((r) => {
      if (!deps.alive()) return;
      if ('kind' in r) router.push('vodPlay', { catchup: r });
      else showToast(CATCHUP_COPY.notAvailable);
    }, (err) => console.warn('From the start failed', err instanceof Error ? err.name : 'Error'));
  };

  /** An event's channels with an archive for it: one plays at once, several open the picker in From the start mode. */
  const fromStartRows = (tile: SportsEventTile, rows: ChannelRow[]) => {
    const now = Date.now();
    const archived = rows.filter((r) => canFromStart(r, now));
    if (archived.length === 0) { showToast(CATCHUP_COPY.noArchive); return; }
    if (archived.length === 1) { fromStart(archived[0]!); return; }
    setEvent({ tile, rows: archived, now, fromStart: true });
    removeLayer?.();
    removeLayer = router.pushOverlay(EVENT_OVERLAY, () => { removeLayer = undefined; setEvent(undefined); deps.refocus(); });
  };

  let opening = false;
  /** One channel airs it: tune. Several: the picker. None left (the guide moved on): a toast and a reload. */
  const openEvent = async (tile: SportsEventTile) => {
    if (opening || event() || removeLayer) return;
    opening = true;
    try {
      await openEventInner(tile);
    } finally {
      opening = false;
    }
  };
  const openEventInner = async (tile: SportsEventTile) => {
    const rows = await api.getEventChannels(tile.key).catch(() => [] as ChannelRow[]);
    if (!deps.alive()) return;
    if (rows.length === 0) { showToast(LIVE_COPY.start.eventGone); deps.reload(); return; }
    if (rows.length === 1) { tune(rows[0]!.id); return; }
    setEvent({ tile, rows, now: Date.now() });
    removeLayer?.();
    removeLayer = router.pushOverlay(EVENT_OVERLAY, () => { removeLayer = undefined; setEvent(undefined); deps.refocus(); });
  };

  const EventView = (): JSX.Element => (
    <Show when={event()} keyed>{(e) => (
      <EventChannels title={e.fromStart ? `${CATCHUP_COPY.fromStart}: ${e.tile.title}` : e.tile.title}
        when={`${eventWhen(e.tile, e.now)} · ${channelsLabel(e.rows.length)}`} rows={e.rows} now={e.now}
        onPick={(id) => {
          const row = e.rows.find((r) => r.id === id);
          close();
          if (e.fromStart && row) fromStart(row);
          else tune(id);
        }}
        onRowMenu={(id) => {
          // Menu on a row with an archive: that channel's programme from its start.
          const row = e.rows.find((r) => r.id === id);
          if (!e.fromStart && row && canFromStart(row, Date.now())) { close(); fromStart(row); }
        }} />
    )}</Show>
  );
  return { tune, openEvent, fromStart, fromStartRows, close, View: EventView };
}
