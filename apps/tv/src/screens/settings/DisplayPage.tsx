import { createSignal, onCleanup } from 'solid-js';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { settings } from '../../state/appState.ts';
import { onOff } from '../settingsLogic.ts';
import { saveSetting, type PageProps } from './shared.ts';

/** Display: show the clock on or off. */
export function DisplayPage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const clock = () => settings()?.showClock ?? true;
  const items = (): SettingItem[] => [
    { id: 'clock', label: 'Show the clock', value: onOff(clock()), adjustable: true, help: 'Top right, and in the channel banner' },
  ];
  const toggle = (id: string) => {
    if (id !== 'clock') return false;
    void saveSetting({ showClock: !clock() });
    return true;
  };
  onCleanup(() => props.register(undefined));
  return (
    <SettingsList ref={props.register} x={props.x} y={props.y} width={props.width} height={props.height}
      items={items()} selected={sel()} onSelect={setSel} onAdjust={(id) => toggle(id)} onOk={toggle}
      onLeftEdge={props.onLeftEdge} />
  );
}
