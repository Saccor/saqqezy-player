export interface AppSettings {
  epgOffsetHours: number;
  preferredFormat: 'ts' | 'm3u8';
  autoRefreshHours: number;
  sleepTimerMinutes: number;
  showClock: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  epgOffsetHours: 0,
  preferredFormat: 'ts',
  autoRefreshHours: 12,
  sleepTimerMinutes: 0,
  showClock: true,
};

const AUTO_REFRESH_CHOICES = [0, 6, 12, 24];
const SLEEP_CHOICES = [0, 15, 30, 60, 90, 120];

function nearest(value: unknown, choices: number[], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  let best = choices[0]!;
  for (const c of choices) if (Math.abs(c - value) < Math.abs(best - value)) best = c;
  return best;
}

export function sanitizeSettings(partial: unknown): AppSettings {
  const src = partial && typeof partial === 'object' && !Array.isArray(partial)
    ? (partial as Record<string, unknown>)
    : {};
  const offset = src.epgOffsetHours;
  return {
    epgOffsetHours: typeof offset === 'number' && Number.isFinite(offset)
      ? Math.max(-12, Math.min(12, Math.round(offset * 2) / 2))
      : DEFAULT_SETTINGS.epgOffsetHours,
    preferredFormat: src.preferredFormat === 'm3u8' || src.preferredFormat === 'ts'
      ? src.preferredFormat
      : DEFAULT_SETTINGS.preferredFormat,
    autoRefreshHours: nearest(src.autoRefreshHours, AUTO_REFRESH_CHOICES, DEFAULT_SETTINGS.autoRefreshHours),
    sleepTimerMinutes: nearest(src.sleepTimerMinutes, SLEEP_CHOICES, DEFAULT_SETTINGS.sleepTimerMinutes),
    showClock: typeof src.showClock === 'boolean' ? src.showClock : DEFAULT_SETTINGS.showClock,
  };
}
