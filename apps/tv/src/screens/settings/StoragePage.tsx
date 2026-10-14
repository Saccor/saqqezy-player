import { createSignal, onCleanup } from 'solid-js';
import { api } from '../../api.ts';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { playback } from '../../playback/playback.ts';
import { showToast } from '../../shell/Toast.tsx';
import { applyInitState } from '../../state/appState.ts';
import type { PageProps } from './shared.ts';

/** Storage: clear the cached channels and guide (sources and favourites stay), then download them again. */
export function StoragePage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const items = (): SettingItem[] => [
    { id: 'clear', label: 'Clear cached channels and guide', help: 'Your sources and favourites are kept' },
  ];
  const onOk = async (id: string) => {
    if (id !== 'clear') return;
    if (!(await props.confirm('Clear cached channels and guide?', 'Clear'))) return;
    const done = props.busy('Clearing…');
    playback.stop(); // the cached list the stream came from is gone
    try {
      applyInitState(await api.clearCache());
      done();
      showToast('Cache cleared. Downloading channels and guide…');
      api.refresh('both').catch((err: unknown) => {
        console.warn('Refresh after clear failed', err instanceof Error ? err.name : 'Error');
      });
    } catch (err) {
      done();
      console.warn('Clear cache failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't clear the cache.");
    }
  };
  onCleanup(() => props.register(undefined));
  return (
    <SettingsList ref={props.register} x={props.x} y={props.y} width={props.width} height={props.height}
      items={items()} selected={sel()} onSelect={setSel} onOk={(id) => void onOk(id)} onLeftEdge={props.onLeftEdge} />
  );
}
