/**
 * The app's own volume (desktop and other non-TV HTML5 players; TVs keep their remote's volume keys): pure logic for
 * steps, mute, the slider and the stored value. Mute is kept apart from the autoplay-policy mute (`AutoMute`): the
 * player applies it as volume 0, so a gesture that drops the autoplay mute never unmutes the user's mute.
 */
export interface VolumeState {
  /** 0..1 */
  level: number;
  muted: boolean;
}

export const VOLUME_STEP = 0.05;
export const DEFAULT_VOLUME = 1;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Rounded to 0.01, so steps never print as 0.30000000000000004. */
const tidy = (v: number) => Math.round(clamp01(v) * 100) / 100;

/** One step up (unmutes) or down (a muted volume stays muted). Snaps to the step grid. */
export function stepVolume(s: VolumeState, dir: 1 | -1): VolumeState {
  const steps = s.level / VOLUME_STEP;
  // A level between grid points goes to the next grid point in that direction (the epsilon absorbs float noise).
  const next = dir > 0 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1;
  return { level: tidy(next * VOLUME_STEP), muted: dir > 0 ? false : s.muted };
}

/** Mute on/off; unmuting a silent volume brings it back at the default level. */
export function toggleMute(s: VolumeState): VolumeState {
  if (s.level === 0) return { level: DEFAULT_VOLUME, muted: false };
  return { level: s.level, muted: !s.muted };
}

/** The level a click or drag on the slider sets (`fraction` along it); unmutes. */
export function levelAt(fraction: number): VolumeState {
  return { level: tidy(fraction), muted: false };
}

/** What the media element plays at. */
export function effectiveVolume(s: VolumeState): number {
  return s.muted ? 0 : s.level;
}

export function volumePercent(s: VolumeState): number {
  return Math.round(effectiveVolume(s) * 100);
}

export function serializeVolume(s: VolumeState): string {
  return JSON.stringify({ level: s.level, muted: s.muted });
}

/** The stored volume; anything missing or broken gives full volume, unmuted. */
export function parseVolume(raw: string | null | undefined): VolumeState {
  const def = { level: DEFAULT_VOLUME, muted: false };
  if (!raw) return def;
  try {
    const v = JSON.parse(raw) as { level?: unknown; muted?: unknown };
    if (typeof v?.level !== 'number' || !Number.isFinite(v.level)) return def;
    return { level: tidy(v.level), muted: v.muted === true };
  } catch {
    return def;
  }
}

/**
 * The volume step of a keyboard key: + (or =, its unshifted key) and numpad + up, - and numpad - down. With Ctrl or
 * Cmd they are the browser's zoom, not ours.
 */
export function volumeKeyStep(e: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }):
  1 | -1 | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 1;
  if (e.key === '-' || e.code === 'NumpadSubtract') return -1;
  return undefined;
}
