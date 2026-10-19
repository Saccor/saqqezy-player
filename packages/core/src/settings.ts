export type LiveDelaySetting = 'low' | 'balanced' | 'stable';
export type OpenOn = 'lastChannel' | 'start';
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  epgOffsetHours: 0,
  preferredFormat: 'ts',
  autoRefreshHours: 12,
  sleepTimerMinutes: 0,
  showClock: true,
  liveDelay: 'balanced',
  subtitleLanguage: 'off',
  subtitleExactMatch: false,
  combineDuplicates: true,
  preferredLanguages: [],
  openOn: 'lastChannel',
  followedTeams: [],
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
    subtitleExactMatch: typeof src.subtitleExactMatch === 'boolean' ? src.subtitleExactMatch : DEFAULT_SETTINGS.subtitleExactMatch,
    combineDuplicates: typeof src.combineDuplicates === 'boolean' ? src.combineDuplicates : DEFAULT_SETTINGS.combineDuplicates,
    preferredLanguages: languageList(src.preferredLanguages),
    openOn: OPEN_ON_CHOICES.includes(src.openOn as OpenOn) ? (src.openOn as OpenOn) : DEFAULT_SETTINGS.openOn,
    followedTeams: sanitizeTeams(src.followedTeams),
  };
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
