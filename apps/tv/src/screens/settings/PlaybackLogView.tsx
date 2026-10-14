import { View, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup } from 'solid-js';
import type { JournalEvent } from '@iptv/player';
import { SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { journal } from '../../playback/playback.ts';
import { platformId } from '../../state/appState.ts';
import { isTvPlatform } from '../../video/engineConfig.ts';
import { journalText, logRows } from '../journalLogic.ts';

const CLEAR_ARM_MS = 3000;

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
 * Diagnostics → Playback log: what the player did, newest first (a snapshot taken when the view opens).
 * "Clear log" asks for a second OK within 3 s; "Copy log" (desktop only) copies the summary and the lines.
 * Back, Left, or the first row return to Diagnostics.
 */
export function PlaybackLogView(props: {
  width: number; height: number;
  register: (el: ElementNode | undefined) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = createSignal(0);
  const [entries, setEntries] = createSignal<JournalEvent[]>(journal.entries());
  const [armed, setArmed] = createSignal(false);
  const [copyNote, setCopyNote] = createSignal<string | undefined>();
  const clipboard = desktopClipboard();
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(armTimer));

  const items = (): SettingItem[] => {
    const rows: SettingItem[] = [
      { id: 'back', label: 'Back to Diagnostics' },
      { id: 'clear', label: armed() ? 'Press OK again to clear' : 'Clear log' },
    ];
    if (clipboard) rows.push({ id: 'copy', label: 'Copy log', value: copyNote() });
    const list = entries();
    rows.push({ id: 'heading', label: list.length > 0 ? 'Newest first' : 'Nothing logged yet', heading: true });
    for (const r of logRows(list, Date.now())) rows.push({ id: r.id, label: r.text, value: r.time });
    return rows;
  };

  const ok = (id: string) => {
    if (id === 'back') {
      props.onClose();
    } else if (id === 'clear') {
      clearTimeout(armTimer);
      if (armed()) {
        journal.clear();
        setEntries([]);
        setArmed(false);
        return;
      }
      setArmed(true);
      armTimer = setTimeout(() => setArmed(false), CLEAR_ARM_MS);
    } else if (id === 'copy' && clipboard) {
      try {
        clipboard.writeText(journalText(journal.entries(), Date.now()))
          .then(() => setCopyNote('Copied'), () => setCopyNote('Copy not available'));
      } catch {
        setCopyNote('Copy not available');
      }
    }
  };

  const select = (i: number) => {
    if (i !== sel()) {
      clearTimeout(armTimer);
      setArmed(false);
    }
    setSel(i);
  };

  return (
    <View width={props.width} height={props.height} onBack={() => { props.onClose(); return true; }}>
      <SettingsList ref={props.register} x={0} y={0} width={props.width} height={props.height}
        items={items()} selected={sel()} onSelect={select} onOk={ok}
        onLeftEdge={() => { props.onClose(); return true; }} />
    </View>
  );
}
