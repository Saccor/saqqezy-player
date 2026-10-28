import { createSignal, onCleanup, onMount } from 'solid-js';
import type { SourceSummary } from '@iptv/app-api';
import { api, onEvent } from '../../api.ts';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { playback } from '../../playback/playback.ts';
import { router } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import { applyInitState } from '../../state/appState.ts';
import { maxConnectionsOf } from '../../state/sourceLimit.ts';
import { connectionsLine } from '../addSourceLogic.ts';
import { markSubscreenLeave, type PageProps } from './shared.ts';
import { CATCHUP_COPY, SETTINGS_COPY } from '../../copy.ts';
import { catchupOffsetChoices, catchupOffsetFromId, catchupOffsetIndex, catchupOffsetLabel } from '../settingsLogic.ts';

const ADD_ID = '__add';
const S = SETTINGS_COPY.sources;
/** Focused row across visits (Edit/Add source return to it). */
let lastSel = 0;
const KIND: Record<SourceSummary['kind'], string> = { xtream: 'Xtream', m3u: 'M3U' };

/** Sources: the list with an "Active" marker, per-source actions (Ok) and "Add source". */
export function SourcesPage(props: PageProps) {
  const [sources, setSources] = createSignal<SourceSummary[]>([]);
  /** Each Xtream source's connection limit, when its login reported one ("Connections allowed: N"). */
  const [limits, setLimits] = createSignal<ReadonlyMap<string, number>>(new Map());
  const [sel, setSelSignal] = createSignal(lastSel);
  const setSel = (v: number | ((i: number) => number)) => { lastSel = setSelSignal(v); };
  let alive = true;

  const load = async () => {
    try {
      const list = await api.listSources();
      if (alive) setSources(list);
      // In parallel; one source that cannot be read only loses its own line.
      const read = await Promise.all(list.filter((s) => s.kind === 'xtream').map(async (s) => {
        try {
          return [s.id, maxConnectionsOf(await api.getSource(s.id))] as const;
        } catch (err) {
          console.warn('Read source limit failed', err instanceof Error ? err.name : 'Error');
          return [s.id, undefined] as const;
        }
      }));
      const next = new Map<string, number>();
      for (const [id, max] of read) if (max !== undefined) next.set(id, max);
      if (alive) setLimits(next);
    } catch (err) {
      console.warn('List sources failed', err instanceof Error ? err.name : 'Error');
    }
  };

  const items = (): SettingItem[] => [
    ...sources().map((s) => ({
      id: s.id,
      label: s.name,
      value: s.active ? SETTINGS_COPY.values.active : '',
      help: [KIND[s.kind], connectionsLine(limits().get(s.id))].filter(Boolean).join(' · '),
    })),
    { id: ADD_ID, label: S.add, help: S.addHelp },
  ];

  const setActive = async (s: SourceSummary) => {
    const done = props.busy(S.switching);
    playback.stop(); // the playing channel belongs to the old source
    try {
      applyInitState(await api.setActiveSource(s.id));
      showToast(S.nowUsing(s.name));
    } catch (err) {
      console.warn('Set active source failed', err instanceof Error ? err.name : 'Error');
      showToast(S.switchFailed);
    } finally {
      done();
    }
    await load();
  };

  const refreshNow = async () => {
    showToast(S.refreshing);
    try {
      await api.refresh('both');
      showToast(S.refreshed);
    } catch (err) {
      console.warn('Refresh failed', err instanceof Error ? err.name : 'Error');
      showToast(S.refreshFailed);
    }
  };

  const remove = async (s: SourceSummary) => {
    if (!(await props.confirm(S.deleteTitle, S.delete, { line: s.name }))) return;
    // Deleting waits for a refresh of that source that may still be running.
    const done = props.busy(S.deleting);
    if (s.active) playback.stop();
    try {
      const state = await api.deleteSource(s.id);
      applyInitState(state);
      done();
      showToast(S.deleted);
      if (state.sources.length === 0) {
        router.reset('addSource');
        return;
      }
    } catch (err) {
      done();
      console.warn('Delete source failed', err instanceof Error ? err.name : 'Error');
      showToast(S.deleteFailed);
    }
    await load();
    setSel((i) => Math.min(i, items().length - 1));
  };

  /** Catch-up time: Auto or a fixed offset from UTC (the list opens at the current value). Saved without a refresh. */
  const catchupTime = async (s: { id: string; name: string }) => {
    const current = (await api.getSource(s.id).catch(() => undefined))?.catchupOffsetMin;
    if (!alive) return;
    const choices = catchupOffsetChoices();
    const at = catchupOffsetIndex(choices, current);
    const pick = await props.choose(`${CATCHUP_COPY.time} · ${CATCHUP_COPY.timeHelp}`, choices, at);
    if (!alive || pick === undefined) return;
    try {
      const saved = await api.setCatchupOffset(s.id, catchupOffsetFromId(pick));
      showToast(S.catchupSaved(catchupOffsetLabel(saved)));
    } catch (err) {
      console.warn('Catch-up time save failed', err instanceof Error ? err.name : 'Error');
      showToast(S.catchupFailed);
    }
  };

  const onOk = async (id: string) => {
    if (id === ADD_ID) {
      markSubscreenLeave();
      router.push('addSource');
      return;
    }
    const s = sources().find((x) => x.id === id);
    if (!s) return;
    const choice = await props.choose(s.name, [
      ...(s.active ? [] : [{ id: 'active', label: S.setActive }]),
      { id: 'edit', label: S.edit },
      { id: 'advanced', label: S.advanced },
      { id: 'catchupTime', label: CATCHUP_COPY.time },
      ...(s.active ? [{ id: 'refresh', label: S.refreshNow }] : []),
      { id: 'delete', label: S.delete },
      { id: 'cancel', label: S.cancel },
    ]);
    if (!alive) return;
    if (choice === 'active') await setActive(s);
    else if (choice === 'edit') { markSubscreenLeave(); router.push('addSource', { sourceId: s.id }); }
    else if (choice === 'advanced') { markSubscreenLeave(); router.push('addSource', { sourceId: s.id, advanced: true }); }
    else if (choice === 'catchupTime') await catchupTime(s);
    else if (choice === 'refresh') await refreshNow();
    else if (choice === 'delete') await remove(s);
  };

  // A paired phone changed the sources while this page is open: re-read the list.
  onMount(() => {
    void load();
    const off = onEvent('sourcesChanged', () => void load());
    onCleanup(off);
  });
  onCleanup(() => { alive = false; props.register(undefined); });

  return (
    <SettingsList ref={props.register} x={props.x} y={props.y} width={props.width} height={props.height}
      items={items()} selected={sel()} onSelect={setSel} onOk={(id) => void onOk(id)} onLeftEdge={props.onLeftEdge} />
  );
}
