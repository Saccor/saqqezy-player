import type { VersionView } from '@iptv/app-api';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { SUBTITLE_LANGUAGE_OPTIONS } from './subtitleLogic.ts';
import { LANGUAGE_NAMES } from './vodPlayerLogic.ts';

/** The Versions list's last row: shows each version as its own card. */
export const SHOW_SEPARATELY = 'Show versions separately';

const languageName = (code: string | undefined) =>
  code ? LANGUAGE_NAMES[code] ?? code.toUpperCase() : 'Unknown language';

/** "Swedish · 4K · HDR"; the automatic pick ends in "· Auto". */
export function versionLabel(v: VersionView): string {
  return [languageName(v.lang), v.quality, ...v.tags, v.auto ? 'Auto' : undefined].filter(Boolean).join(' · ');
}

/** The Versions list: every version (the one shown checked), then "Show versions separately". */
export function versionRows(versions: readonly VersionView[], shownId: string | undefined): PickerRow[] {
  const rows: PickerRow[] = versions.map((v) => ({ kind: 'list', id: v.id, label: versionLabel(v), checked: v.id === shownId }));
  rows.push({ kind: 'new', label: SHOW_SEPARATELY });
  return rows;
}

/** Settings' "Preferred language" stepper: Automatic, then each listed language. */
export const PREFERRED_LANGUAGE_OPTIONS: readonly string[] = ['auto', ...SUBTITLE_LANGUAGE_OPTIONS.filter((c) => c !== 'off')];

/** The stepper's value for the stored list (its first language, or Automatic when empty). */
export const preferredLanguageOption = (langs: readonly string[] | undefined): string => langs?.[0] ?? 'auto';

/** The stored list for a stepper value. */
export const preferredLanguagesFor = (option: string): string[] => (option === 'auto' ? [] : [option]);

export const preferredLanguageLabel = (option: string): string =>
  (option === 'auto' ? 'Automatic (TV language)' : LANGUAGE_NAMES[option] ?? option.toUpperCase());
