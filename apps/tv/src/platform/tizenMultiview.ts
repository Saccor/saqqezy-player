/**
 * Multiview on Tizen (spec 2026-10-22-tizen-multiview): AVPlay has two video scalers, MAIN and SUB
 * (`IN_APP_MULTIVIEW`, Tizen 7.0+), so two windows can show at once; extra players come from `webapis.avplaystore` and
 * the sound moves with `enable/disableAudioStream` (Tizen 6.5+). Pure: the globals are passed in.
 */
export type VideoResource = 'MAIN' | 'SUB';

export interface TizenMultiviewGlobals {
  tizen?: { systeminfo?: { getCapability?(key: string): unknown } };
  webapis?: {
    avplay?: { enableAudioStream?: unknown; disableAudioStream?: unknown };
    avplaystore?: { getPlayer?: unknown };
  };
}

export interface WindowCeiling {
  windows: 1 | 2;
  reason: 'ok' | 'noStore' | 'noAudioStream' | 'version';
}

const MIN_MAJOR = 7;

/** The platform version: `tizen.systeminfo` first, else the user agent's `Tizen x.y`; undefined when neither says. */
function platformMajor(g: TizenMultiviewGlobals, ua: string): number | undefined {
  let v: unknown;
  try {
    v = g.tizen?.systeminfo?.getCapability?.('http://tizen.org/feature/platform.version');
  } catch {
    v = undefined;
  }
  const text = typeof v === 'string' && v ? v : /Tizen (\d+(?:\.\d+)?)/.exec(ua)?.[1];
  const major = text ? Number.parseInt(text, 10) : Number.NaN;
  return Number.isFinite(major) ? major : undefined;
}

/** How many windows this TV can show: 2 with two scalers and per-player audio, else 1 (no multiview). */
export function tizenWindowCeiling(g: TizenMultiviewGlobals, ua: string): WindowCeiling {
  const w = g.webapis;
  if (typeof w?.avplaystore?.getPlayer !== 'function') return { windows: 1, reason: 'noStore' };
  if (typeof w.avplay?.enableAudioStream !== 'function' || typeof w.avplay.disableAudioStream !== 'function') {
    return { windows: 1, reason: 'noAudioStream' };
  }
  const major = platformMajor(g, ua);
  if (major === undefined || major < MIN_MAJOR) return { windows: 1, reason: 'version' };
  return { windows: 2, reason: 'ok' };
}

/** The scalers, shared by every AVPlay player: a player claims one per open and releases it at stop. */
export interface VideoResources {
  /** MAIN when free, else SUB when free, else undefined. */
  claim(): VideoResource | undefined;
  release(r: VideoResource): void;
}

export function createVideoResources(): VideoResources {
  const taken = new Set<VideoResource>();
  return {
    claim() {
      const r = (['MAIN', 'SUB'] as const).find((x) => !taken.has(x));
      if (r) taken.add(r);
      return r;
    },
    release(r) { taken.delete(r); },
  };
}
