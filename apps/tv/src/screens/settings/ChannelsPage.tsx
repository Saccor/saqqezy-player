import { createSignal, onCleanup, onMount } from 'solid-js';
import type { ChannelRow } from '@iptv/app-api';
import { api } from '../../api.ts';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { showToast } from '../../shell/Toast.tsx';
import { settings } from '../../state/appState.ts';
import { AUTO_REFRESH_OPTIONS, autoRefreshLabel, cycleOption } from '../settingsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

const NONE_ID = '__none';

/** Channels: auto-refresh interval, then the hidden channels (Ok shows one again). */
export function ChannelsPage(props: PageProps) {
  const [hidden, setHidden] = createSignal<ChannelRow[] | undefined>(undefined);
  const [sel, setSel] = createSignal(0);
  let alive = true;
  const auto = (): number => settings()?.autoRefreshHours ?? 12;

  const load = async () => {
    try {
      const rows = await api.hiddenChannels();
      if (alive) setHidden(rows);
    } catch (err) {
      console.warn('Hidden channels failed', err instanceof Error ? err.name : 'Error');
      if (alive) setHidden([]);
    }
  };

  const items = (): SettingItem[] => {
    const list = hidden();
    const rest: SettingItem[] = list === undefined
      ? [{ id: NONE_ID, label: 'Loading hidden channels…' }]
      : list.length === 0
        ? [{ id: NONE_ID, label: 'No hidden channels', help: 'Hide channels from the channel options' }]
        : list.map((c) => ({ id: c.id, label: `${c.number} · ${c.name}`, value: 'Hidden', help: 'Ok: show this channel again' }));
    return [
      { id: 'auto', label: 'Refresh channels and guide', value: autoRefreshLabel(auto()), adjustable: true,
        help: 'How often the list is downloaded again' },
      ...rest,
    ];
  };

  const onAdjust = (id: string, dir: 1 | -1) => {
    if (id !== 'auto') return false;
    void saveSetting({ autoRefreshHours: cycleOption<number>(AUTO_REFRESH_OPTIONS, auto(), dir) });
    return true;
  };
  const onOk = async (id: string) => {
    if (id === 'auto') { onAdjust(id, 1); return; }
    if (id === NONE_ID) return;
    try {
      await api.toggleHidden(id);
      showToast('Channel shown again');
    } catch (err) {
      console.warn('Unhide failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't change this channel.");
    }
    await load();
    if (alive) setSel((i) => Math.min(i, items().length - 1));
  };

  onMount(() => void load());
  onCleanup(() => { alive = false; props.register(undefined); });
  return (
    <SettingsList ref={props.register} x={props.x} y={props.y} width={props.width} height={props.height}
      items={items()} selected={sel()} onSelect={setSel} onAdjust={onAdjust} onOk={(id) => void onOk(id)}
      onLeftEdge={props.onLeftEdge} />
  );
}
