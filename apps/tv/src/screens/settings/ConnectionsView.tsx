import { View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { connectionMemory, journal } from '../../playback/playback.ts';
import { initState, platformId } from '../../state/appState.ts';
import { activeConnectionsOf, maxConnectionsOf } from '../../state/sourceLimit.ts';
import { isTvPlatform } from '../../video/engineConfig.ts';
import { connectionsHeader, connectionsRows, connectionsText, type ConnectionsFacts } from './connectionsLogic.ts';

/** The clipboard on desktop builds only; TVs have none. */
function desktopClipboard(): Clipboard | undefined {
  if (isTvPlatform(platformId)) return undefined;
  try {
    return globalThis.navigator?.clipboard ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Diagnostics → Connections: what the source reports, the most windows seen playing, where it refused, and every
 * window's open, refusal and stop with its time (a snapshot taken when the view opens). "Copy" (desktop) copies it
 * all as text. Back, Left, or the first row return to Diagnostics.
 */
export function ConnectionsView(props: {
  width: number; height: number;
  register: (el: ElementNode | undefined) => void;
  onClose: () => void;
}) {
  const sourceId = initState()?.activeSourceId;
  const [sel, setSel] = createSignal(0);
  const [facts, setFacts] = createSignal<ConnectionsFacts>({
    maxSeen: sourceId ? connectionMemory.maxSeen(sourceId) : 0,
    ...(sourceId && connectionMemory.refusedAt(sourceId) !== undefined ? { refusedAt: connectionMemory.refusedAt(sourceId)! } : {}),
  });
  const [copyNote, setCopyNote] = createSignal<string | undefined>();
  const entries = journal.entries();
  const clipboard = desktopClipboard();
  let alive = true;
  onCleanup(() => { alive = false; });
  onMount(() => {
    if (!sourceId) return;
    api.getSource(sourceId).then((src) => {
      if (!alive) return;
      const reported = maxConnectionsOf(src);
      const active = activeConnectionsOf(src);
      setFacts((f) => ({ ...f, ...(reported !== undefined ? { reported } : {}), ...(active !== undefined ? { activeAtLogin: active } : {}) }));
    }).catch(() => undefined);
  });

  const items = (): SettingItem[] => {
    const now = Date.now();
    const rows: SettingItem[] = [{ id: 'back', label: 'Back to Diagnostics' }];
    if (clipboard) rows.push({ id: 'copy', label: 'Copy', value: copyNote() });
    for (const [k, v] of connectionsHeader(facts())) rows.push({ id: `h:${k}`, label: k, value: v });
    const list = connectionsRows(entries, now);
    rows.push({ id: 'heading', label: list.length > 0 ? 'Windows, newest first' : 'No multiview sessions yet.', heading: true });
    for (const r of list) rows.push({ id: r.id, label: r.text, value: r.time });
    return rows;
  };

  const ok = (id: string) => {
    if (id === 'back') props.onClose();
    else if (id === 'copy' && clipboard) {
      try {
        clipboard.writeText(connectionsText(facts(), entries, Date.now()))
          .then(() => setCopyNote('Copied'), () => setCopyNote('Copy not available'));
      } catch {
        setCopyNote('Copy not available');
      }
    }
  };

  return (
    <View width={props.width} height={props.height} onBack={() => { props.onClose(); return true; }}>
      <SettingsList ref={props.register} x={0} y={0} width={props.width} height={props.height}
        items={items()} selected={sel()} onSelect={setSel} onOk={ok}
        onLeftEdge={() => { props.onClose(); return true; }} />
    </View>
  );
}
