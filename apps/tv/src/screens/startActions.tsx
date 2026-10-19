import { Show, type JSX } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import type { ChannelRow, SportsEventTile } from '@iptv/app-api';
import { api } from '../api.ts';
import { EventChannels } from '../components/EventChannels.tsx';
import { playback } from '../playback/playback.ts';
import { router } from '../shell/router.ts';
import { showToast } from '../shell/Toast.tsx';
import { channelsLabel, eventWhen } from './startLogic.ts';

const GROUP_ALL = 'all';
const EVENT_OVERLAY = 'startEvent';

export function createStartActions(deps: { alive: () => boolean; reload: () => void; refocus: () => void }) {
  const [event, setEvent] = createSignal<{ tile: SportsEventTile; rows: ChannelRow[]; now: number } | undefined>();
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

  /** One channel airs it: tune. Several: the picker. None left (the guide moved on): a toast and a reload. */
  const openEvent = async (tile: SportsEventTile) => {
    const rows = await api.getEventChannels(tile.key).catch(() => [] as ChannelRow[]);
    if (!deps.alive()) return;
    if (rows.length === 0) { showToast('This event is no longer in your guide'); deps.reload(); return; }
    if (rows.length === 1) { tune(rows[0]!.id); return; }
    setEvent({ tile, rows, now: Date.now() });
    removeLayer = router.pushOverlay(EVENT_OVERLAY, () => { removeLayer = undefined; setEvent(undefined); deps.refocus(); });
  };

  const EventView = (): JSX.Element => (
    <Show when={event()} keyed>{(e) => (
      <EventChannels title={e.tile.title} when={`${eventWhen(e.tile, e.now)} · ${channelsLabel(e.rows.length)}`} rows={e.rows} now={e.now}
        onPick={(id) => { close(); tune(id); }} />
    )}</Show>
  );
  return { tune, openEvent, close, View: EventView };
}
