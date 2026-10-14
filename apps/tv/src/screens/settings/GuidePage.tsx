import { createSignal, onCleanup } from 'solid-js';
import { api } from '../../api.ts';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { showToast } from '../../shell/Toast.tsx';
import { settings } from '../../state/appState.ts';
import { offsetLabel, stepOffset } from '../settingsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

/** TV guide: EPG time offset (Left/Right, 0.5 h steps, ±12 h) and "Refresh the guide now". */
export function GuidePage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const offset = () => settings()?.epgOffsetHours ?? 0;
  const items = (): SettingItem[] => [
    { id: 'offset', label: 'Guide time offset', value: offsetLabel(offset()), adjustable: true,
      help: 'Adjust if programme times look shifted' },
    { id: 'refresh', label: 'Refresh the guide now', help: 'Downloads the TV guide again' },
  ];
  const onAdjust = (id: string, dir: 1 | -1) => {
    if (id !== 'offset') return false;
    const next = stepOffset(offset(), dir);
    if (next !== offset()) void saveSetting({ epgOffsetHours: next });
    return true;
  };
  const onOk = async (id: string) => {
    if (id !== 'refresh') return;
    showToast('Refreshing TV guide…');
    try {
      await api.refresh('epg');
      showToast('TV guide updated');
    } catch (err) {
      console.warn('Guide refresh failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't refresh the TV guide.");
    }
  };
  onCleanup(() => props.register(undefined));
  return (
    <SettingsList ref={props.register} x={props.x} y={props.y} width={props.width} height={props.height}
      items={items()} selected={sel()} onSelect={setSel} onAdjust={onAdjust} onOk={(id) => void onOk(id)}
      onLeftEdge={props.onLeftEdge} />
  );
}
