import { normalizeCountry } from './text/regions.ts';

export type LiveDelaySetting = 'low' | 'balanced' | 'stable';
export type OpenOn = 'lastChannel' | 'start';
export type PosterSize = 'standard' | 'compact';
/** Your countries: off (no effect), put first, or show only these (report 2026-10-20 §2.2). */
export type RegionMode = 'off' | 'first' | 'only';
/** ISO 3166-1 alpha-2 codes (GB, not UK), plus `lang:xx` for language-only groups. */
export interface RegionSettings { codes: string[]; mode: RegionMode }
/** Most entries in `regions.codes`. */
export const REGIONS_MAX = 10;
export const FOLLOWED_TEAMS_MAX = 50;
export const FOLLOWED_TEAM_LEN = 40;

export interface AppSettings {
  epgOffsetHours: number;
  preferredFormat: 'ts' | 'm3u8';
  autoRefreshHours: number;
  sleepTimerMinutes: number;
  showClock: boolean;
  /** Closeness to live versus stall resistance (the player's live delay preset). */
  liveDelay: LiveDelaySetting;
  /** Movies and series: the subtitle language turned on when a title has no choice of its own ('off': none). */
  subtitleLanguage: string;
  /** The audio track picked when a title or channel has no remembered choice: ISO 639-1, or 'auto' (the stream's default). */
  audioLanguage: string;
  /**
   * Find subtitles online also matches the exact video file (reads 128 KB of it from the provider: one short extra
   * request while the title plays, which one-connection accounts may refuse). Off by default.
   */
  subtitleExactMatch: boolean;
  /** Movies and series: one card per title, its language and quality versions behind a Versions list. */
  combineDuplicates: boolean;
  /** Movies and series: which version Play starts, most preferred first (ISO 639-1). Empty: the TV's language, then English. */
  preferredLanguages: string[];
  /** Where a cold start lands: Live TV with the last channel (default), or the Start page over it. */
  openOn: OpenOn;
  /** Sides the user follows (EPG text as shown); events with a followed side are pinned on Start. On-device only. */
  followedTeams: string[];
  /** Library grid density: 8 posters a row, or 10 (Compact). */
  posterSize: PosterSize;
  /**
   * Live: one row per channel; its other streams take over when one fails (spec 2026-10-19-live-grouping). Off by
   * default until the TV UI for sources lands (report 2026-10-20 §3.1 step 3), then on.
   */
  combineChannels: boolean;
  /** Your countries for Live TV groups and movie/series categories. Person-level, on this device. */
  regions: RegionSettings;
  /**
   * Movies and series: merge categories that differ only by a language prefix ("SE | Action" and "EN | Action").
   * Off by default (owner decision 1): provider categories are kept.
   */
  combineCategories: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  epgOffsetHours: 0,
  preferredFormat: 'ts',
  autoRefreshHours: 12,
  sleepTimerMinutes: 0,
  showClock: true,
  liveDelay: 'balanced',
  subtitleLanguage: 'off',
  audioLanguage: 'auto',
  subtitleExactMatch: false,
  combineDuplicates: true,
  preferredLanguages: [],
  openOn: 'lastChannel',
  followedTeams: [],
  posterSize: 'standard',
  combineChannels: false,
  regions: { codes: [], mode: 'off' },
  combineCategories: false,
};

/** Most entries in `preferredLanguages`. */
export const PREFERRED_LANGUAGES_MAX = 5;

/** 'off', then ISO 639-1 codes in order of their English names. */
export const SUBTITLE_LANGUAGES: readonly string[] = [
  'off', 'ar', 'zh', 'cs', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'el', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'no', 'fa',
  'pl', 'pt', 'ro', 'ru', 'es', 'sv', 'th', 'tr', 'uk', 'vi',
];

const LIVE_DELAY_CHOICES: readonly LiveDelaySetting[] = ['low', 'balanced', 'stable'];

const AUTO_REFRESH_CHOICES = [0, 6, 12, 24];
const SLEEP_CHOICES = [0, 15, 30, 60, 90, 120];

const OPEN_ON_CHOICES: readonly OpenOn[] = ['lastChannel', 'start'];

function sanitizeTeams(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const t = v.trim().slice(0, FOLLOWED_TEAM_LEN).trim();
    if (!t) continue;
    const k = t.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= FOLLOWED_TEAMS_MAX) break;
  }
  return out;
}

function oneOf(value: unknown, choices: number[], fallback: number): number {
  return typeof value === 'number' && choices.includes(value) ? value + 0 : fallback;
}

export function sanitizeSettings(partial: unknown): AppSettings {
  const src = partial && typeof partial === 'object' && !Array.isArray(partial)
    ? (partial as Record<string, unknown>)
    : {};
  const offset = src.epgOffsetHours;
  return {
    epgOffsetHours: typeof offset === 'number' && Number.isFinite(offset)
      ? Math.max(-12, Math.min(12, Math.round(offset * 2) / 2)) + 0
      : DEFAULT_SETTINGS.epgOffsetHours,
    preferredFormat: src.preferredFormat === 'm3u8' || src.preferredFormat === 'ts'
      ? src.preferredFormat
      : DEFAULT_SETTINGS.preferredFormat,
    autoRefreshHours: oneOf(src.autoRefreshHours, AUTO_REFRESH_CHOICES, DEFAULT_SETTINGS.autoRefreshHours),
    sleepTimerMinutes: oneOf(src.sleepTimerMinutes, SLEEP_CHOICES, DEFAULT_SETTINGS.sleepTimerMinutes),
    showClock: typeof src.showClock === 'boolean' ? src.showClock : DEFAULT_SETTINGS.showClock,
    liveDelay: LIVE_DELAY_CHOICES.includes(src.liveDelay as LiveDelaySetting)
      ? (src.liveDelay as LiveDelaySetting)
      : DEFAULT_SETTINGS.liveDelay,
    subtitleLanguage: typeof src.subtitleLanguage === 'string' && SUBTITLE_LANGUAGES.includes(src.subtitleLanguage)
      ? src.subtitleLanguage
      : DEFAULT_SETTINGS.subtitleLanguage,
    audioLanguage: src.audioLanguage === 'auto'
      || (typeof src.audioLanguage === 'string' && src.audioLanguage !== 'off' && SUBTITLE_LANGUAGES.includes(src.audioLanguage))
      ? (src.audioLanguage as string)
      : DEFAULT_SETTINGS.audioLanguage,
    subtitleExactMatch: typeof src.subtitleExactMatch === 'boolean' ? src.subtitleExactMatch : DEFAULT_SETTINGS.subtitleExactMatch,
    combineDuplicates: typeof src.combineDuplicates === 'boolean' ? src.combineDuplicates : DEFAULT_SETTINGS.combineDuplicates,
    preferredLanguages: languageList(src.preferredLanguages),
    openOn: OPEN_ON_CHOICES.includes(src.openOn as OpenOn) ? (src.openOn as OpenOn) : DEFAULT_SETTINGS.openOn,
    followedTeams: sanitizeTeams(src.followedTeams),
    posterSize: src.posterSize === 'compact' || src.posterSize === 'standard' ? src.posterSize : DEFAULT_SETTINGS.posterSize,
    combineChannels: typeof src.combineChannels === 'boolean' ? src.combineChannels : DEFAULT_SETTINGS.combineChannels,
    regions: sanitizeRegions(src.regions),
    combineCategories: typeof src.combineCategories === 'boolean' ? src.combineCategories : DEFAULT_SETTINGS.combineCategories,
  };
}

const REGION_MODES: readonly RegionMode[] = ['off', 'first', 'only'];

/** A region key as stored, or undefined: a known country (UK → GB), or `lang:` with a two-letter language. */
export function regionCode(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const lang = /^lang:([a-z]{2})$/i.exec(x);
  if (lang) return `lang:${lang[1]!.toLowerCase()}`;
  return normalizeCountry(x);
}

function sanitizeRegions(v: unknown): RegionSettings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { codes: [], mode: 'off' };
  const r = v as Record<string, unknown>;
  const codes: string[] = [];
  if (Array.isArray(r.codes)) {
    for (const x of r.codes) {
      const c = regionCode(x);
      if (c && !codes.includes(c)) codes.push(c);
      if (codes.length === REGIONS_MAX) break;
    }
  }
  return { codes, mode: REGION_MODES.includes(r.mode as RegionMode) ? (r.mode as RegionMode) : 'off' };
}

function languageList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const code of v) {
    if (typeof code !== 'string' || code === 'off' || !SUBTITLE_LANGUAGES.includes(code) || out.includes(code)) continue;
    out.push(code);
    if (out.length === PREFERRED_LANGUAGES_MAX) break;
  }
  return out;
}
