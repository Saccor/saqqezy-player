import type { ElementNode } from '@lightningtv/solid';
// Type-only: @iptv/core must stay out of the main-thread bundle.
import type { AppSettings } from '@iptv/core';
import { api } from '../../api.ts';
import type { OptionItem } from '../../components/sheetLogic.ts';
import { SETTINGS_COPY } from '../../copy.ts';
import { showToast } from '../../shell/Toast.tsx';
import { patchSettings, settings } from '../../state/appState.ts';
import { rollbackTarget } from '../settingsLogic.ts';

export interface ConfirmOptions {
  single?: boolean; detail?: string;
  /** A second, smaller line under the title (the title stays one line). */
  line?: string;
}

/** What the Settings screen gives each page: its content box plus the shared modals. */
export interface PageProps {
  x: number; y: number; width: number; height: number;
  /** The page's focusable list (undefined when it has nothing to focus). */
  register: (el: ElementNode | undefined) => void;
  /** Left on the list's edge: back to the menu. */
  onLeftEdge: () => boolean;
  /** Yes/No dialog (No focused); Back answers No. `opts.single`: one button only; `opts.detail`: a large line (a code). */
  confirm: (message: string, yes: string, opts?: ConfirmOptions) => Promise<boolean>;
  /** Action menu (OptionsMenu); Back or "Cancel" answers undefined. */
  choose: (title: string, items: OptionItem[], initial?: number) => Promise<string | undefined>;
  /** Blocks keys behind a "busy" panel until the returned function is called. */
  busy: (text: string) => () => void;
  /** A deep link's row to select first (`router.push('settings', { page, focusItem })`). */
  focusItem?: string;
}

let leavingForSubscreen = false;
/** A page calls this right before pushing Edit/Add source, so Settings keeps its focus area for the return trip. */
export function markSubscreenLeave(): void { leavingForSubscreen = true; }
/** Settings' cleanup: true (once) if the screen is only being covered by Edit/Add source. */
export function consumeSubscreenLeave(): boolean {
  const v = leavingForSubscreen;
  leavingForSubscreen = false;
  return v;
}

let saveSeq = 0;

/**
 * Applies a settings change right away (the UI reacts through `appState.settings`), then stores it; the
 * worker's sanitised answer replaces the optimistic value unless a newer change has been made since.
 * If the save fails, the previous value is restored (again unless a newer change has been made).
 */
export async function saveSetting(partial: Partial<AppSettings>): Promise<void> {
  const cur = settings();
  const previous = cur;
  if (cur) patchSettings({ ...cur, ...partial });
  const seq = ++saveSeq;
  try {
    const saved = await api.saveSettings(partial);
    if (seq === saveSeq) patchSettings(saved);
  } catch (err) {
    console.warn('Save settings failed', err instanceof Error ? err.name : 'Error');
    const back = rollbackTarget(previous, seq, saveSeq);
    if (back) patchSettings(back);
    showToast(SETTINGS_COPY.saveFailed);
  }
}
