import type { VersionView } from '@iptv/app-api';
import { VOD_COPY } from '../copy.ts';
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { SUBTITLE_LANGUAGE_OPTIONS } from './subtitleLogic.ts';
import { languageName as nameOf } from './tracks.ts';
import { LANGUAGE_NAMES } from './tracks.ts';

/** The Versions list's last row: shows each version as its own card. */
export const SHOW_SEPARATELY = VOD_COPY.showSeparately;

const languageName = (code: string) => nameOf(code) ?? code.toUpperCase();

/** `versions` with the languages `getVersionLanguages` found filled in (a version's own language is never replaced). */
export function withLanguages<T extends VersionView>(versions: readonly T[], langs: Record<string, string>): T[] {
  return versions.map((v) => (v.lang || !langs[v.id] ? v : { ...v, lang: langs[v.id] }));
}

/**
 * "Swedish · 4K · HDR"; the automatic pick ends in "· Auto". A version without a language starts with its place in
 * the list (`n`, from 1): "Version 2 · 4K", never "Unknown".
 */
export function versionLabel(v: VersionView, n = 1): string {
  return [v.lang ? languageName(v.lang) : VOD_COPY.version(n), v.quality, ...v.tags, v.auto ? 'Auto' : undefined].filter(Boolean).join(' · ');
}

/** The Versions list: every version (the one shown checked), then "Show versions separately". */
export function versionRows(versions: readonly VersionView[], shownId: string | undefined): PickerRow[] {
  const rows: PickerRow[] = versions.map((v, i) => ({ kind: 'list', id: v.id, label: versionLabel(v, i + 1), checked: v.id === shownId }));
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
  (option === 'auto' ? VOD_COPY.automaticLanguage : LANGUAGE_NAMES[option] ?? option.toUpperCase());
