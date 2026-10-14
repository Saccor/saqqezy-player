import { createSignal, onCleanup, onMount } from 'solid-js';
import type { SourceSummary } from '@iptv/app-api';
import { api } from '../../api.ts';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { playback } from '../../playback/playback.ts';
import { router } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import { applyInitState } from '../../state/appState.ts';
import type { PageProps } from './shared.ts';

const ADD_ID = '__add';
/** Focused row across visits (Edit/Add source return to it). */
let lastSel = 0;
const KIND: Record<SourceSummary['kind'], string> = { xtream: 'Xtream', m3u: 'M3U' };

/** Sources: the list with an "Active" marker, per-source actions (Ok) and "Add source". */
export function SourcesPage(props: PageProps) {
  const [sources, setSources] = createSignal<SourceSummary[]>([]);
  const [sel, setSelSignal] = createSignal(lastSel);
  const setSel = (v: number | ((i: number) => number)) => { lastSel = setSelSignal(v); };
  let alive = true;

  const load = async () => {
    try {
      const list = await api.listSources();
      if (alive) setSources(list);
    } catch (err) {
      console.warn('List sources failed', err instanceof Error ? err.name : 'Error');
    }
  };

  const items = (): SettingItem[] => [
    ...sources().map((s) => ({
      id: s.id,
      label: s.name,
      value: s.active ? 'Active' : '',
      help: `${KIND[s.kind]} · Ok: options`,
    })),
    { id: ADD_ID, label: 'Add source', help: 'Xtream login or M3U link' },
  ];

  const setActive = async (s: SourceSummary) => {
    const done = props.busy('Switching source…');
    playback.stop(); // the playing channel belongs to the old source
    try {
      applyInitState(await api.setActiveSource(s.id));
      showToast(`Now using ${s.name}`);
    } catch (err) {
      console.warn('Set active source failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't switch to this source.");
    } finally {
      done();
    }
    await load();
  };

  const refreshNow = async () => {
    showToast('Refreshing channels and TV guide…');
    try {
      await api.refresh('both');
      showToast('Channels and TV guide updated');
    } catch (err) {
      console.warn('Refresh failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't refresh. Showing saved list.");
    }
  };

  const remove = async (s: SourceSummary) => {
    if (!(await props.confirm(`Delete "${s.name}"?`, 'Delete'))) return;
    // Deleting waits for a refresh of that source that may still be running.
    const done = props.busy('Deleting source…');
    if (s.active) playback.stop();
    try {
      const state = await api.deleteSource(s.id);
      applyInitState(state);
      done();
      showToast('Source deleted');
      if (state.sources.length === 0) {
        router.reset('addSource');
        return;
      }
    } catch (err) {
      done();
      console.warn('Delete source failed', err instanceof Error ? err.name : 'Error');
      showToast("Couldn't delete this source.");
    }
    await load();
    setSel((i) => Math.min(i, items().length - 1));
  };

  const onOk = async (id: string) => {
    if (id === ADD_ID) {
      router.push('addSource');
      return;
    }
    const s = sources().find((x) => x.id === id);
    if (!s) return;
    const choice = await props.choose(s.name, [
      ...(s.active ? [] : [{ id: 'active', label: 'Set as active' }]),
      { id: 'edit', label: 'Edit' },
      ...(s.active ? [{ id: 'refresh', label: 'Refresh now' }] : []),
      { id: 'delete', label: 'Delete' },
      { id: 'cancel', label: 'Cancel' },
    ]);
    if (!alive) return;
    if (choice === 'active') await setActive(s);
    else if (choice === 'edit') router.push('addSource', { sourceId: s.id });
    else if (choice === 'refresh') await refreshNow();
    else if (choice === 'delete') await remove(s);
  };

  onMount(() => void load());
  onCleanup(() => { alive = false; props.register(undefined); });

  return (
    <SettingsList ref={props.register} x={props.x} y={props.y} width={props.width} height={props.height}
      items={items()} selected={sel()} onSelect={setSel} onOk={(id) => void onOk(id)} onLeftEdge={props.onLeftEdge} />
  );
}
