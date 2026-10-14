import type { ElementNode } from '@lightningtv/solid';
// Type-only: @iptv/core must stay out of the main-thread bundle.
import type { AppSettings } from '@iptv/core';
import { api } from '../../api.ts';
import type { OptionItem } from '../../components/OptionsMenu.tsx';
import { showToast } from '../../shell/Toast.tsx';
import { patchSettings, settings } from '../../state/appState.ts';

/** What the Settings screen gives each page: its content box plus the shared modals. */
export interface PageProps {
  x: number; y: number; width: number; height: number;
  /** The page's focusable list (undefined when it has nothing to focus). */
  register: (el: ElementNode | undefined) => void;
  /** Left on the list's edge: back to the menu. */
  onLeftEdge: () => boolean;
  /** Yes/No dialog (No focused); Back answers No. */
  confirm: (message: string, yes: string) => Promise<boolean>;
  /** Action menu (OptionsMenu); Back or "Cancel" answers undefined. */
  choose: (title: string, items: OptionItem[]) => Promise<string | undefined>;
  /** Blocks keys behind a "busy" panel until the returned function is called. */
  busy: (text: string) => () => void;
}

let saveSeq = 0;

/**
 * Applies a settings change right away (the UI reacts through `appState.settings`), then stores it; the
 * worker's sanitised answer replaces the optimistic value unless a newer change has been made since.
 */
export async function saveSetting(partial: Partial<AppSettings>): Promise<void> {
  const cur = settings();
  if (cur) patchSettings({ ...cur, ...partial });
  const seq = ++saveSeq;
  try {
    const saved = await api.saveSettings(partial);
    if (seq === saveSeq) patchSettings(saved);
  } catch (err) {
    console.warn('Save settings failed', err instanceof Error ? err.name : 'Error');
    showToast("Couldn't save the setting.");
  }
}
