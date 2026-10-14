export type LiveDelaySetting = 'low' | 'balanced' | 'stable';

export interface AppSettings {
  epgOffsetHours: number;
  preferredFormat: 'ts' | 'm3u8';
  autoRefreshHours: number;
  sleepTimerMinutes: number;
  showClock: boolean;
  /** Closeness to live versus stall resistance (the player's live delay preset). */
  liveDelay: LiveDelaySetting;
}

export const DEFAULT_SETTINGS: AppSettings = {
  epgOffsetHours: 0,
  preferredFormat: 'ts',
  autoRefreshHours: 12,
  sleepTimerMinutes: 0,
  showClock: true,
  liveDelay: 'balanced',
};

const LIVE_DELAY_CHOICES: readonly LiveDelaySetting[] = ['low', 'balanced', 'stable'];

const AUTO_REFRESH_CHOICES = [0, 6, 12, 24];
const SLEEP_CHOICES = [0, 15, 30, 60, 90, 120];

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
  };
}
