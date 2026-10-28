import { Show, type ElementNode } from '@lightningtv/solid';
import { createMemo, createSignal, type JSX } from 'solid-js';
import type { VersionView } from '@iptv/app-api';
import { api } from '../api.ts';
import { VOD_COPY } from '../copy.ts';
import { Sheet } from '../components/Sheet.tsx';
import { fromPickerRow } from '../components/sheetLogic.ts';
import { router } from '../shell/router.ts';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { versionRows, withLanguages } from './versionsLogic.ts';

const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');

export interface VersionsPickerDeps<V extends { versions: VersionView[] }> {
  /** The overlay layer id (Back closes the list). */
  layerId: string;
  /** The title id the versions belong to (asked for their languages). */
  titleId: string;
  view: () => V | undefined;
  setView: (v: V) => void;
  alive: () => boolean;
  /** The version the list marks as shown. */
  shownId: () => string | undefined;
  /** After the list closes (Back or a pick), on the next microtask while the screen is alive. */
  onClosed: () => void;
  onPick: (row: PickerRow) => void;
}

/** The Versions list of the movie and series detail screens: open, close and the sheet itself. */
export function createVersionsPicker<V extends { versions: VersionView[] }>(deps: VersionsPickerDeps<V>) {
  const [picking, setPicking] = createSignal(false);
  let node: ElementNode | undefined;
  let removeLayer: (() => void) | undefined;

  const open = () => {
    const shown = deps.view();
    if (!shown || shown.versions.length < 2) return;
    // Versions whose names give no language: the source's probe data usually does (fills in while the list shows).
    if (shown.versions.some((v) => !v.lang)) {
      api.getVersionLanguages(deps.titleId).then((langs) => {
        const cur = deps.view();
        if (deps.alive() && cur && Object.keys(langs).length > 0) deps.setView({ ...cur, versions: withLanguages(cur.versions, langs) });
      }).catch((err) => console.warn('Version languages failed', errName(err)));
    }
    setPicking(true);
    removeLayer = router.pushOverlay(deps.layerId, closed);
    queueMicrotask(() => { if (deps.alive()) node?.setFocus(); });
  };
  function closed() {
    removeLayer = undefined;
    setPicking(false);
    queueMicrotask(() => { if (deps.alive()) deps.onClosed(); });
  }
  /** Closes the list (its layer too). */
  const close = () => {
    removeLayer?.();
    closed();
  };
  /** Screen cleanup: drops the layer without the close side effects. */
  const dispose = () => removeLayer?.();

  const View = (): JSX.Element => (
    <Show when={picking()}>{(() => {
      const pickRows = createMemo(() => versionRows(deps.view()?.versions ?? [], deps.shownId()));
      const sheetRows = createMemo(() => pickRows().map(fromPickerRow));
      return (
        <Sheet ref={(el) => { node = el; }} title={VOD_COPY.versions} rows={sheetRows()} backLayerId={deps.layerId}
          onSelect={(_, i) => { const r = pickRows()[i]; if (r) deps.onPick(r); }} />
      );
    })()}</Show>
  );

  return { open, close, dispose, View };
}
